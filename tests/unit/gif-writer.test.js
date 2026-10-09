/**
 * Tests for web/gif/gif-writer.js: every GIF is decoded with omggif and
 * compared pixel by pixel.
 */
import { describe, it, expect } from 'vitest';
import omggif from 'omggif';
import { gifHeader, gifFrame, setFrameDelay, assembleGif, lzwEncode } from '../../web/gif/gif-writer.js';

const { GifReader } = omggif;

/** Deterministic pseudo-random palette indices. */
function noise(count, colors, seed = 1) {
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = seed % colors;
  }
  return out;
}

function palette(count) {
  return Array.from({ length: count }, (_, i) => [i, (i * 7) & 255, (i * 13) & 255]);
}

/** Decode frames 0..last onto one canvas and return its RGBA pixels. */
function picture(bytes, last) {
  const reader = new GifReader(bytes);
  const pixels = new Uint8Array(reader.width * reader.height * 4);
  for (let i = 0; i <= last; i++) reader.decodeAndBlitFrameRGBA(i, pixels);
  return pixels;
}

/** Expected RGBA pixels of `indices` drawn with `colors`. */
function rgba(indices, colors) {
  const out = new Uint8Array(indices.length * 4);
  for (let i = 0; i < indices.length; i++) {
    const color = colors[indices[i]];
    out[i * 4] = color[0];
    out[i * 4 + 1] = color[1];
    out[i * 4 + 2] = color[2];
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** Index of the first differing byte, or -1 when both arrays are equal. */
function firstMismatch(actual, expected) {
  if (actual.length !== expected.length) return Math.min(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) return i;
  }
  return -1;
}

function roundTrip(width, height, colors, indices) {
  const bytes = assembleGif(gifHeader(width, height), [gifFrame({ width, height, palette: colors, indices })]);
  expect(firstMismatch(picture(bytes, 0), rgba(indices, colors))).toBe(-1);
}

describe('gifHeader', () => {
  it('starts a GIF89a of the given size that loops forever', () => {
    const bytes = assembleGif(gifHeader(5, 4), [gifFrame({ width: 5, height: 4, palette: palette(2), indices: new Uint8Array(20) })]);
    expect(String.fromCharCode(...bytes.slice(0, 6))).toBe('GIF89a');
    const reader = new GifReader(bytes);
    expect([reader.width, reader.height]).toEqual([5, 4]);
    expect(reader.loopCount()).toBe(0);
  });
});

describe('gifFrame', () => {
  it('round-trips a one-colour frame', () => {
    roundTrip(10, 10, palette(1), new Uint8Array(100));
  });

  it('round-trips a two-colour checkerboard', () => {
    roundTrip(7, 3, palette(2), Uint8Array.from({ length: 21 }, (_, i) => i % 2));
  });

  it('round-trips 256 colours of noise, which fills and resets the code table', () => {
    roundTrip(300, 300, palette(256), noise(90_000, 256));
  });

  it('round-trips a few colours over a large image', () => {
    roundTrip(400, 400, palette(5), noise(160_000, 5, 7));
  });

  it('round-trips a single pixel', () => {
    roundTrip(1, 1, palette(2), Uint8Array.of(1));
  });

  it('places a frame at its offset and lets transparent pixels show the frame below', () => {
    const base = gifFrame({ width: 5, height: 4, palette: [[255, 255, 255]], indices: new Uint8Array(20) });
    const patch = gifFrame({
      x: 2, y: 1, width: 2, height: 2,
      palette: [[255, 0, 0], [0, 0, 0]],
      indices: Uint8Array.of(0, 1, 1, 0),
      transparentIndex: 1,
      delayCs: 7,
    });
    const bytes = assembleGif(gifHeader(5, 4), [base, patch]);
    const info = new GifReader(bytes).frameInfo(1);
    expect(info).toMatchObject({ x: 2, y: 1, width: 2, height: 2, delay: 7, transparent_index: 1, disposal: 1 });

    const pixels = picture(bytes, 1);
    const at = (x, y) => Array.from(pixels.slice((y * 5 + x) * 4, (y * 5 + x) * 4 + 3));
    expect(at(2, 1)).toEqual([255, 0, 0]);
    expect(at(3, 1)).toEqual([255, 255, 255]);
    expect(at(2, 2)).toEqual([255, 255, 255]);
    expect(at(3, 2)).toEqual([255, 0, 0]);
    expect(at(0, 0)).toEqual([255, 255, 255]);
  });

  it('marks a frame without transparency as opaque', () => {
    const bytes = assembleGif(gifHeader(2, 1), [gifFrame({ width: 2, height: 1, palette: palette(2), indices: Uint8Array.of(0, 1), delayCs: 3 })]);
    expect(new GifReader(bytes).frameInfo(0)).toMatchObject({ delay: 3, transparent_index: null, disposal: 1 });
  });
});

describe('setFrameDelay', () => {
  it('changes the delay of an encoded frame', () => {
    const frame = gifFrame({ width: 2, height: 1, palette: palette(2), indices: Uint8Array.of(0, 1), delayCs: 7 });
    setFrameDelay(frame, 300);
    expect(new GifReader(assembleGif(gifHeader(2, 1), [frame])).frameInfo(0).delay).toBe(300);
  });
});

describe('assembleGif', () => {
  it('ends with the trailer', () => {
    const bytes = assembleGif(gifHeader(1, 1), [gifFrame({ width: 1, height: 1, palette: palette(1), indices: new Uint8Array(1) })]);
    expect(bytes.at(-1)).toBe(0x3b);
  });
});

describe('lzwEncode', () => {
  it('splits the data into full 255-byte sub-blocks and a terminator', () => {
    const data = lzwEncode(noise(10_000, 256), 8);
    expect(data[0]).toBe(8);
    const sizes = [];
    let offset = 1;
    while (data[offset] !== 0) {
      sizes.push(data[offset]);
      offset += data[offset] + 1;
    }
    expect(offset).toBe(data.length - 1);
    expect(sizes.length).toBeGreaterThan(1);
    expect(sizes.slice(0, -1).every(size => size === 255)).toBe(true);
  });
});
