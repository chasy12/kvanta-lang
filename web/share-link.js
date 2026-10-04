/**
 * share-link.js
 *
 * Turn a program into a URL hash (`#code=...`) and back, so a program can be
 * shared as a plain link. The source is deflate-compressed and base64url-encoded,
 * so it survives being pasted into chats and emails.
 */

const PREFIX = "#code=";

/**
 * Run `bytes` through a (de)compression stream and collect the output.
 *
 * @param {Uint8Array} bytes
 * @param {CompressionStream | DecompressionStream} stream
 * @returns {Promise<Uint8Array>}
 */
async function pipe(bytes, stream) {
  const out = new Response(bytes).body.pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

/** @param {Uint8Array} bytes */
function toBase64Url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** @param {string} text */
function fromBase64Url(text) {
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

/**
 * Encode program source as a URL hash.
 *
 * @param {string} code - Program source.
 * @returns {Promise<string>} A hash such as `#code=...`.
 */
export async function encodeCode(code) {
  const packed = await pipe(new TextEncoder().encode(code), new CompressionStream("deflate-raw"));
  return PREFIX + toBase64Url(packed);
}

/**
 * Decode program source from a URL hash made by `encodeCode`.
 *
 * @param {string} hash - Usually `location.hash`.
 * @returns {Promise<string | null>} The source, or null when the hash holds no valid program.
 */
export async function decodeCode(hash) {
  if (!hash.startsWith(PREFIX)) return null;
  try {
    const bytes = await pipe(fromBase64Url(hash.slice(PREFIX.length)), new DecompressionStream("deflate-raw"));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** True when `hash` carries a shared program. */
export function isSharedHash(hash) {
  return hash.startsWith(PREFIX);
}
