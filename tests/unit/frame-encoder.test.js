/**
 * Tests for web/gif/frame-encoder.js: encoded clips are decoded with omggif.
 */
import { describe, it, expect } from 'vitest';
import omggif from 'omggif';
import { createFrameEncoder, changedRect, MIN_DELAY_CS } from '../../web/gif/frame-encoder.js';

const { GifReader } = omggif;
const W = 40;
const H = 30;
const WHITE = [255, 255, 255];
const RED = [255, 0, 0];
const BLUE = [0, 0, 255];

function solid(color) {
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) rgba.set([...color, 255], i * 4);
  return rgba;
}

/** Copy of `base` with a filled box from (x0, y0) up to, not including, (x1, y1). */
function withBox(base, x0, y0, x1, y1, color) {
  const rgba = base.slice();
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) rgba.set([...color, 255], (y * W + x) * 4);
  }
  return rgba;
}

/** Decode a GIF into the picture after each frame, plus frame info. */
function decode(bytes) {
  const reader = new GifReader(bytes);
  const pixels = new Uint8Array(reader.width * reader.height * 4);
  const pictures = [];
  const infos = [];
  for (let i = 0; i < reader.numFrames(); i++) {
    reader.decodeAndBlitFrameRGBA(i, pixels);
    pictures.push(pixels.slice());
    infos.push(reader.frameInfo(i));
  }
  return { pictures, infos, delays: infos.map(info => info.delay) };
}

const BG = solid(WHITE);
const BOX = withBox(BG, 2, 2, 6, 6, RED);
const TWO_BOXES = withBox(BOX, 10, 5, 14, 9, BLUE);

describe('changedRect', () => {
  it('is null for identical pictures', () => {
    expect(changedRect(BG, BG.slice(), W, H)).toBeNull();
  });

  it('bounds every changed pixel', () => {
    expect(changedRect(BOX, TWO_BOXES, W, H)).toEqual({ x: 10, y: 5, width: 4, height: 4 });
    expect(changedRect(BG, TWO_BOXES, W, H)).toEqual({ x: 2, y: 2, width: 12, height: 7 });
  });
});

describe('createFrameEncoder', () => {
  it('stores the first frame full size and later frames as changed rectangles', () => {
    const encoder = createFrameEncoder({ width: W, height: H });
    encoder.addFrame(BG, 0, false);
    encoder.addFrame(BOX, 100, false);
    encoder.addFrame(TWO_BOXES, 200, false);
    const { pictures, infos } = decode(encoder.finish(300, false).bytes);
    expect(infos.map(({ x, y, width, height }) => [x, y, width, height])).toEqual([
      [0, 0, W, H], [2, 2, 4, 4], [10, 5, 4, 4],
    ]);
    expect(infos[0].transparent_index).toBeNull();
    expect(infos[1].transparent_index).not.toBeNull();
    expect(infos.every(info => info.disposal === 1)).toBe(true);
    expect(pictures).toEqual([BG, BOX, TWO_BOXES]);
  });

  it('keeps unchanged pixels inside the rectangle transparent', () => {
    const corners = withBox(withBox(BG, 0, 0, 1, 1, RED), W - 1, H - 1, W, H, BLUE);
    const encoder = createFrameEncoder({ width: W, height: H });
    encoder.addFrame(BG, 0, false);
    encoder.addFrame(corners, 100, false);
    const { pictures, infos } = decode(encoder.finish(200, false).bytes);
    expect(infos[1]).toMatchObject({ x: 0, y: 0, width: W, height: H });
    expect(pictures[1]).toEqual(corners);
  });

  it('merges an unchanged picture into the previous frame', () => {
    const encoder = createFrameEncoder({ width: W, height: H });
    encoder.addFrame(BG, 0, false);
    expect(encoder.addFrame(BG.slice(), 500, false).frames).toBe(1);
    encoder.addFrame(BOX, 1000, false);
    expect(decode(encoder.finish(1100, false).bytes).delays).toEqual([100, 10]);
  });

  it('caps a pause of the program at 3 s', () => {
    const encoder = createFrameEncoder({ width: W, height: H });
    encoder.addFrame(BG, 0, false);
    encoder.addFrame(BG.slice(), 33, false);
    encoder.addFrame(BOX, 10_000, false);
    expect(decode(encoder.finish(10_100, false).bytes).delays).toEqual([300, 10]);
  });

  it('caps a pause at 0.5 s when the user was waited on', () => {
    const encoder = createFrameEncoder({ width: W, height: H });
    encoder.addFrame(BG, 0, false);
    encoder.addFrame(BOX, 10_000, true);
    expect(decode(encoder.finish(10_100, false).bytes).delays).toEqual([50, 10]);
  });

  it('caps the whole pause at 0.5 s when the user was waited on during part of it', () => {
    const encoder = createFrameEncoder({ width: W, height: H });
    encoder.addFrame(BG, 0, false);
    encoder.addFrame(BG.slice(), 1000, true);
    encoder.addFrame(BOX, 10_000, false);
    expect(decode(encoder.finish(10_100, false).bytes).delays).toEqual([50, 10]);
  });

  it('caps the last frame at save time like any other pause', () => {
    const encoder = createFrameEncoder({ width: W, height: H });
    encoder.addFrame(BG, 0, false);
    encoder.addFrame(BOX, 100, false);
    expect(decode(encoder.finish(60_000, false).bytes).delays).toEqual([10, 300]);
    expect(decode(encoder.finish(60_000, true).bytes).delays).toEqual([10, 50]);
  });

  it('carries rounding into the next delay so 30 fps stays on time', () => {
    const encoder = createFrameEncoder({ width: W, height: H });
    for (let i = 0; i <= 6; i++) {
      encoder.addFrame(withBox(BG, i, 0, i + 1, 1, RED), (i * 1000) / 30, false);
    }
    expect(decode(encoder.finish(7000 / 30, false).bytes).delays.slice(0, 6)).toEqual([3, 4, 3, 3, 4, 3]);
  });

  it(`never writes a delay below ${MIN_DELAY_CS} cs`, () => {
    const encoder = createFrameEncoder({ width: W, height: H });
    encoder.addFrame(BG, 0, false);
    encoder.addFrame(BOX, 5, false);
    encoder.addFrame(TWO_BOXES, 10, false);
    const { delays } = decode(encoder.finish(11, false).bytes);
    expect(delays.every(delay => delay >= MIN_DELAY_CS)).toBe(true);
  });

  it('stops at exactly one minute of playback', () => {
    const encoder = createFrameEncoder({ width: W, height: H });
    let stats;
    let i = 0;
    for (; i < 70 * 30; i++) {
      // Whole milliseconds, so the 60 s boundary is hit exactly.
      stats = encoder.addFrame(withBox(BG, i % W, 0, (i % W) + 1, 1, [i % 256, 0, 0]), Math.round((i * 1000) / 30), false);
      if (stats.limit) break;
    }
    expect(stats).toMatchObject({ limit: 'time', closedMs: 60_000, openStart: null });
    expect(i).toBe(1800);
    const frames = stats.frames;
    expect(encoder.addFrame(BOX, 70_000, false).frames).toBe(frames);
    const result = encoder.finish(80_000, false);
    expect(result).toMatchObject({ lengthMs: 60_000, limit: 'time' });
    const { delays } = decode(result.bytes);
    expect(delays).toHaveLength(frames);
    expect(delays.reduce((sum, delay) => sum + delay, 0)).toBe(6000);
  });

  it.each([[1000 / 30], [33.4]])('ends at exactly one minute with unrounded timestamps %d ms apart', (period) => {
    const encoder = createFrameEncoder({ width: W, height: H });
    let stats;
    for (let i = 0; i < 70 * 30; i++) {
      stats = encoder.addFrame(withBox(BG, i % W, 0, (i % W) + 1, 1, [i % 256, 0, 0]), i * period, false);
      if (stats.limit) break;
    }
    expect(stats).toMatchObject({ limit: 'time', closedMs: 60_000, openStart: null });
    const result = encoder.finish(80_000, false);
    expect(result).toMatchObject({ lengthMs: 60_000, limit: 'time' });
    const { delays } = decode(result.bytes);
    expect(delays).toHaveLength(stats.frames);
    expect(delays.reduce((sum, delay) => sum + delay, 0)).toBe(6000);
    expect(delays.every(delay => delay >= MIN_DELAY_CS)).toBe(true);
  });

  it('ends at exactly the limit when a save cuts a frame that starts just before it', () => {
    const encoder = createFrameEncoder({ width: W, height: H, maxPlaybackMs: 1000 });
    encoder.addFrame(BG, 0, false);
    encoder.addFrame(BOX, 500, false);
    encoder.addFrame(TWO_BOXES, 995, false);
    const first = encoder.finish(5000, false);
    expect(first).toMatchObject({ lengthMs: 1000, limit: 'time' });
    const { delays, pictures } = decode(first.bytes);
    expect(delays.reduce((sum, delay) => sum + delay, 0)).toBe(100);
    expect(delays.every(delay => delay >= MIN_DELAY_CS)).toBe(true);
    expect(pictures[pictures.length - 1]).toEqual(BOX);
    const second = encoder.finish(5000, false);
    expect(second.bytes).toEqual(first.bytes);
    // Nothing was changed by saving: the frame is still open and the clip can be cut earlier.
    const earlier = decode(encoder.finish(1000, false).bytes);
    expect(earlier.delays.reduce((sum, delay) => sum + delay, 0)).toBe(100);
  });

  it('stops with no frames when the first frame alone is over the size limit', () => {
    const encoder = createFrameEncoder({ width: W, height: H, maxBytes: 10 });
    expect(encoder.addFrame(BG, 0, false)).toMatchObject({ frames: 0, limit: 'size' });
  });

  it('reaches the time limit while the picture stays the same', () => {
    const encoder = createFrameEncoder({ width: W, height: H, maxPlaybackMs: 2000 });
    encoder.addFrame(BG, 0, false);
    encoder.addFrame(BOX, 1000, false);
    expect(encoder.addFrame(BOX.slice(), 1500, false).limit).toBeNull();
    expect(encoder.addFrame(BOX.slice(), 2000, false)).toMatchObject({ limit: 'time', closedMs: 2000, openStart: null });
    const result = encoder.finish(9000, false);
    expect(result.lengthMs).toBe(2000);
    expect(decode(result.bytes).delays).toEqual([100, 100]);
  });

  it('drops the frame that would pass the size limit and stops', () => {
    const probe = createFrameEncoder({ width: W, height: H });
    const encoder = createFrameEncoder({ width: W, height: H, maxBytes: probe.addFrame(BG, 0, false).bytes + 5 });
    encoder.addFrame(BG, 0, false);
    expect(encoder.addFrame(BOX, 5000, false)).toMatchObject({ frames: 1, limit: 'size', closedMs: 3000, openStart: null });
    expect(encoder.addFrame(TWO_BOXES, 6000, false).frames).toBe(1);
    const result = encoder.finish(9000, false);
    expect(result).toMatchObject({ lengthMs: 3000, limit: 'size' });
    expect(decode(result.bytes).delays).toEqual([300]);
  });

  it('reports stats that match the saved file', () => {
    const encoder = createFrameEncoder({ width: W, height: H });
    encoder.addFrame(BG, 0, false);
    const stats = encoder.addFrame(BOX, 250, true);
    expect(stats).toMatchObject({ frames: 2, closedMs: 250, openStart: 250, openUserWaited: false, limit: null });
    const result = encoder.finish(300, false);
    expect(result.size).toBe(result.bytes.length);
    expect(stats.bytes).toBe(result.size);
    expect(result.lengthMs).toBe(300);
  });

  it('keeps recording after a save', () => {
    const encoder = createFrameEncoder({ width: W, height: H });
    encoder.addFrame(BG, 0, false);
    encoder.addFrame(BOX, 100, false);
    encoder.finish(150, false);
    encoder.addFrame(TWO_BOXES, 200, false);
    const { pictures, delays } = decode(encoder.finish(300, false).bytes);
    expect(pictures).toEqual([BG, BOX, TWO_BOXES]);
    expect(delays).toEqual([10, 10, 10]);
  });

  it('rejects a frame of the wrong size', () => {
    const encoder = createFrameEncoder({ width: W, height: H });
    expect(() => encoder.addFrame(new Uint8Array(16), 0, false)).toThrow(/size/);
  });
});
