/**
 * gif-writer.js
 *
 * Writes GIF89a bytes: the file header, frames with their own palette and
 * position, LZW compression and the trailer. Pure functions, no browser APIs.
 */

/** Disposal method 1: leave the frame in place so the next one draws over it. */
const DO_NOT_DISPOSE = 1;
const TRAILER = 0x3b;

function pushUint16(bytes, value) {
  bytes.push(value & 0xff, (value >> 8) & 0xff);
}

function pushAscii(bytes, text) {
  for (let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i));
}

/** Bits needed for a colour table of `count` entries (a table has at least 2). */
function paletteBits(count) {
  let bits = 1;
  while ((1 << bits) < count) bits++;
  return bits;
}

/**
 * Bytes that start the file: signature, logical screen descriptor without a
 * global palette, and the NETSCAPE2.0 extension that loops the animation forever.
 *
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array}
 */
export function gifHeader(width, height) {
  const bytes = [];
  pushAscii(bytes, 'GIF89a');
  pushUint16(bytes, width);
  pushUint16(bytes, height);
  bytes.push(0, 0, 0); // no global palette, background 0, square pixels
  bytes.push(0x21, 0xff, 11);
  pushAscii(bytes, 'NETSCAPE2.0');
  bytes.push(3, 1, 0, 0, 0); // loop count 0 = forever
  return Uint8Array.from(bytes);
}

/**
 * One frame: graphic control extension, image descriptor at (`x`, `y`), local
 * palette and compressed pixels. The delay sits at bytes 4–5 (see `setFrameDelay`).
 *
 * @param {{ x?: number, y?: number, width: number, height: number, palette: number[][],
 *   indices: Uint8Array, transparentIndex?: number, delayCs?: number }} frame
 *   `palette` holds `[r, g, b]` entries; `transparentIndex` is -1 for none.
 * @returns {Uint8Array}
 */
export function gifFrame({ x = 0, y = 0, width, height, palette, indices, transparentIndex = -1, delayCs = 0 }) {
  const bits = paletteBits(palette.length);
  const head = [0x21, 0xf9, 4, (DO_NOT_DISPOSE << 2) | (transparentIndex >= 0 ? 1 : 0)];
  pushUint16(head, delayCs);
  head.push(Math.max(0, transparentIndex), 0);
  head.push(0x2c);
  pushUint16(head, x);
  pushUint16(head, y);
  pushUint16(head, width);
  pushUint16(head, height);
  head.push(0x80 | (bits - 1)); // local palette, not interlaced
  for (let i = 0; i < 1 << bits; i++) {
    const color = palette[i] ?? [0, 0, 0];
    head.push(color[0], color[1], color[2]);
  }
  const data = lzwEncode(indices, Math.max(2, bits));
  const frame = new Uint8Array(head.length + data.length);
  frame.set(head);
  frame.set(data, head.length);
  return frame;
}

/**
 * Change the delay of a frame made by `gifFrame`.
 *
 * @param {Uint8Array} frame
 * @param {number} delayCs - Hundredths of a second.
 */
export function setFrameDelay(frame, delayCs) {
  frame[4] = delayCs & 0xff;
  frame[5] = (delayCs >> 8) & 0xff;
}

/**
 * The complete file: header, frames, trailer.
 *
 * @param {Uint8Array} header
 * @param {Uint8Array[]} frames
 * @returns {Uint8Array}
 */
export function assembleGif(header, frames) {
  let size = header.length + 1;
  for (const frame of frames) size += frame.length;
  const out = new Uint8Array(size);
  out.set(header);
  let offset = header.length;
  for (const frame of frames) {
    out.set(frame, offset);
    offset += frame.length;
  }
  out[offset] = TRAILER;
  return out;
}

/**
 * GIF LZW compression of palette indices, as image data: the minimum code
 * size, sub-blocks of at most 255 bytes and a zero terminator. The code table
 * is cleared whenever it reaches 4096 entries.
 *
 * @param {Uint8Array} indices
 * @param {number} minCodeSize - At least 2; enough bits for every index.
 * @returns {Uint8Array}
 */
export function lzwEncode(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let packed = new Uint8Array(Math.max(64, indices.length));
  let length = 0;
  let bitBuffer = 0;
  let bitCount = 0;
  let codeSize = minCodeSize + 1;

  function emit(code) {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      if (length === packed.length) {
        const grown = new Uint8Array(packed.length * 2);
        grown.set(packed);
        packed = grown;
      }
      packed[length++] = bitBuffer & 0xff;
      bitBuffer >>>= 8;
      bitCount -= 8;
    }
  }

  emit(clearCode);
  const table = new Map();
  let nextCode = endCode + 1;
  if (indices.length > 0) {
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const index = indices[i];
      const key = (prefix << 8) | index;
      const code = table.get(key);
      if (code !== undefined) {
        prefix = code;
        continue;
      }
      emit(prefix);
      if (nextCode < 4096) {
        table.set(key, nextCode++);
        if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
      } else {
        emit(clearCode);
        table.clear();
        nextCode = endCode + 1;
        codeSize = minCodeSize + 1;
      }
      prefix = index;
    }
    emit(prefix);
  }
  emit(endCode);
  if (bitCount > 0) {
    if (length === packed.length) {
      const grown = new Uint8Array(length + 1);
      grown.set(packed);
      packed = grown;
    }
    packed[length++] = bitBuffer & 0xff;
  }

  const blocks = Math.ceil(length / 255);
  const out = new Uint8Array(1 + blocks + length + 1);
  out[0] = minCodeSize;
  let offset = 1;
  for (let start = 0; start < length; start += 255) {
    const size = Math.min(255, length - start);
    out[offset++] = size;
    out.set(packed.subarray(start, start + size), offset);
    offset += size;
  }
  out[offset] = 0;
  return out;
}
