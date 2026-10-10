/**
 * frame-encoder.js
 *
 * Turns captured pictures into GIF frames as they arrive. Only the rectangle
 * that changed is stored. Unchanged pictures extend the previous frame, long
 * pauses are shortened, and recording stops at the time and size limits.
 * Runs in the GIF worker and uses no browser APIs.
 */
import * as gifencModule from 'gifenc';
import { gifHeader, gifFrame, setFrameDelay, assembleGif } from './gif-writer.js';
import { MAX_BYTES, MAX_PLAYBACK_MS, waitCap } from './limits.js';

// gifenc ships CommonJS and ES builds. Node loads the CommonJS one, whose
// functions sit on the default export; Vite and vitest load the ES one, whose
// functions are named exports (and whose default export is only GIFEncoder).
const gifenc = typeof gifencModule.default?.quantize === 'function' ? gifencModule.default : gifencModule;
const { quantize } = gifenc;

/** GIF players stretch shorter delays, so no frame is shorter than this. */
export const MIN_DELAY_CS = 2;

/** Index of the palette color nearest to `r, g, b`. */
function nearestColor(r, g, b, palette) {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const [pr, pg, pb] = palette[i];
    const distance = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
      if (distance === 0) break;
    }
  }
  return best;
}

/**
 * Palette index of each pixel. gifenc's applyPalette remembers one answer per
 * coarse color bin, so the first pixel seen in a bin decides the color of all
 * the others, and a background can take the shade of a darker edge pixel.
 * This remembers answers per exact color instead.
 */
function paletteIndices(rgba, palette) {
  const words = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.length / 4);
  const indices = new Uint8Array(words.length);
  const known = new Map();
  let lastColor = -1;
  let lastIndex = 0;
  for (let i = 0; i < words.length; i++) {
    const color = words[i] & 0xffffff;
    if (color !== lastColor) {
      lastColor = color;
      lastIndex = known.get(color);
      if (lastIndex === undefined) {
        lastIndex = nearestColor(color & 0xff, (color >> 8) & 0xff, color >> 16, palette);
        known.set(color, lastIndex);
      }
    }
    indices[i] = lastIndex;
  }
  return indices;
}

/**
 * Smallest rectangle containing every pixel that differs, or `null` if none does.
 *
 * @param {Uint8Array} previous - RGBA pixels.
 * @param {Uint8Array} next - RGBA pixels of the same size.
 * @param {number} width
 * @param {number} height
 * @returns {{ x: number, y: number, width: number, height: number } | null}
 */
export function changedRect(previous, next, width, height) {
  const a = new Uint32Array(previous.buffer, previous.byteOffset, width * height);
  const b = new Uint32Array(next.buffer, next.byteOffset, width * height);
  let top = -1;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) { top = (i / width) | 0; break; }
  }
  if (top < 0) return null;
  let bottom = top;
  for (let i = a.length - 1; i >= 0; i--) {
    if (a[i] !== b[i]) { bottom = (i / width) | 0; break; }
  }
  let left = width;
  let right = -1;
  for (let y = top; y <= bottom; y++) {
    const row = y * width;
    for (let x = 0; x < left; x++) {
      if (a[row + x] !== b[row + x]) { left = x; break; }
    }
    for (let x = width - 1; x > right; x--) {
      if (a[row + x] !== b[row + x]) { right = x; break; }
    }
  }
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/**
 * Encode `rect` of `next` as a frame. Without `previous` every pixel is drawn.
 * With it, pixels equal to `previous` get a transparent index so the frame
 * below shows through, and only the changed pixels pick the palette.
 */
function encodeRect(previous, next, frameWidth, rect) {
  const { x, y, width, height } = rect;
  const crop = new Uint8Array(width * height * 4);
  const cropWords = new Uint32Array(crop.buffer);
  const nextWords = new Uint32Array(next.buffer, next.byteOffset, next.length / 4);
  const previousWords = previous && new Uint32Array(previous.buffer, previous.byteOffset, previous.length / 4);
  const same = previous ? new Uint8Array(width * height) : null;
  let changed = 0;
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const source = (y + row) * frameWidth + x + col;
      const target = row * width + col;
      cropWords[target] = nextWords[source];
      if (previous && previousWords[source] === nextWords[source]) same[target] = 1;
      else changed++;
    }
  }

  let sample = crop;
  if (previous && changed < width * height) {
    sample = new Uint8Array(changed * 4);
    const sampleWords = new Uint32Array(sample.buffer);
    for (let i = 0, j = 0; i < same.length; i++) {
      if (!same[i]) sampleWords[j++] = cropWords[i];
    }
  }

  // One palette slot stays free for the transparent index.
  const palette = quantize(sample, previous ? 255 : 256);
  const indices = paletteIndices(crop, palette);
  if (!previous) return gifFrame({ x, y, width, height, palette, indices });

  const transparentIndex = palette.length;
  for (let i = 0; i < same.length; i++) {
    if (same[i]) indices[i] = transparentIndex;
  }
  return gifFrame({ x, y, width, height, palette: [...palette, [0, 0, 0]], indices, transparentIndex });
}

/**
 * @param {{ width: number, height: number, maxBytes?: number, maxPlaybackMs?: number }} options
 */
export function createFrameEncoder({ width, height, maxBytes = MAX_BYTES, maxPlaybackMs = MAX_PLAYBACK_MS }) {
  const header = gifHeader(width, height);
  const frames = [];
  /** File size so far, trailer included. */
  let bytes = header.length + 1;
  /** Pixels of the last captured picture. */
  let previous = null;
  /** The frame still on screen: `{ frame, start, userWaited }`; its delay is not final. */
  let open = null;
  /** The latest frame whose delay is final, and that delay. */
  let lastClosed = null;
  /** Playback time of the frames whose delay is final. */
  let closedMs = 0;
  /** Sum of the delays written so far, in centiseconds. */
  let writtenCs = 0;
  /** `'time'` or `'size'` once recording has stopped. */
  let limit = null;

  function openDuration(t, userWaited) {
    return Math.min(Math.max(0, t - open.start), waitCap(open.userWaited || userWaited));
  }

  /** Delay that brings the written total closest to `totalMs`. */
  function delayFor(totalMs) {
    return Math.max(MIN_DELAY_CS, Math.round(totalMs / 10) - writtenCs);
  }

  /**
   * What the open frame becomes when it reaches the time limit. A remainder
   * below the minimum delay cannot be a frame of its own without overshooting
   * the limit, so the frame is dropped and the remainder goes to the frame before.
   *
   * @returns {{ drop: boolean, delay: number }} `delay` is the open frame's delay,
   *   or, when dropped, the previous frame's new delay.
   */
  function cutAtLimit() {
    const remaining = Math.round(maxPlaybackMs / 10) - writtenCs;
    if (remaining >= MIN_DELAY_CS || !lastClosed) return { drop: false, delay: Math.max(MIN_DELAY_CS, remaining) };
    return { drop: true, delay: Math.max(MIN_DELAY_CS, lastClosed.delay + remaining) };
  }

  /** Fix the open frame's delay at time `t`; returns `'time'` if that fills the clip. */
  function closeOpen(t, userWaited) {
    let duration = openDuration(t, userWaited);
    let reached = null;
    if (closedMs + duration >= maxPlaybackMs) {
      duration = maxPlaybackMs - closedMs;
      reached = 'time';
    }
    closedMs += duration;
    if (reached) {
      const cut = cutAtLimit();
      if (cut.drop) {
        frames.pop();
        bytes -= open.frame.length;
        writtenCs += cut.delay - lastClosed.delay;
        lastClosed.delay = cut.delay;
        setFrameDelay(lastClosed.frame, cut.delay);
        open = null;
        return reached;
      }
      writtenCs += cut.delay;
      setFrameDelay(open.frame, cut.delay);
      lastClosed = { frame: open.frame, delay: cut.delay };
      open = null;
      return reached;
    }
    const delay = delayFor(closedMs);
    writtenCs += delay;
    setFrameDelay(open.frame, delay);
    lastClosed = { frame: open.frame, delay };
    open = null;
    return reached;
  }

  function stats() {
    return {
      frames: frames.length,
      closedMs,
      openStart: open ? open.start : null,
      openUserWaited: open ? open.userWaited : false,
      bytes,
      limit,
    };
  }

  return {
    /**
     * Add the picture captured at time `t` (ms).
     *
     * @param {Uint8Array} rgba - `width * height` RGBA pixels; kept, not copied.
     * @param {number} t
     * @param {boolean} userWaited - The user was waited on since the previous capture.
     */
    addFrame(rgba, t, userWaited) {
      if (rgba.length !== width * height * 4) {
        throw new Error(`Frame size does not match the ${width}×${height} recording`);
      }
      if (limit) return stats();
      let rect = { x: 0, y: 0, width, height };
      if (previous) {
        rect = changedRect(previous, rgba, width, height);
        if (!rect) {
          open.userWaited = open.userWaited || userWaited;
          if (closedMs + openDuration(t, false) >= maxPlaybackMs) limit = closeOpen(t, false);
          return stats();
        }
        limit = closeOpen(t, userWaited);
        if (limit) return stats();
      }
      const frame = encodeRect(previous, rgba, width, rect);
      if (bytes + frame.length > maxBytes) {
        limit = 'size';
        return stats();
      }
      frames.push(frame);
      bytes += frame.length;
      open = { frame, start: t, userWaited: false };
      previous = rgba;
      return stats();
    },

    stats,

    /**
     * The GIF as it would be if the clip ended at time `t`. Recording can go on.
     *
     * @param {number} t
     * @param {boolean} userWaited - The user was waited on since the last capture.
     */
    finish(t, userWaited) {
      let lengthMs = closedMs;
      let reached = limit;
      let list = frames;
      if (open) {
        let duration = openDuration(t, userWaited);
        if (closedMs + duration >= maxPlaybackMs) {
          duration = maxPlaybackMs - closedMs;
          reached = reached ?? 'time';
          const cut = cutAtLimit();
          if (cut.drop) {
            // Work on copies: recording may continue after this save.
            const patched = lastClosed.frame.slice();
            setFrameDelay(patched, cut.delay);
            list = [...frames.slice(0, -2), patched];
          } else {
            setFrameDelay(open.frame, cut.delay);
          }
        } else {
          setFrameDelay(open.frame, delayFor(lengthMs + duration));
        }
        lengthMs += duration;
      }
      const gif = assembleGif(header, list);
      return { bytes: gif, lengthMs, size: gif.length, limit: reached };
    },
  };
}
