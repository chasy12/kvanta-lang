/**
 * worker-handler.js
 *
 * Message handling of the GIF worker, kept apart from the worker global so it
 * can be tested directly.
 *
 * In:  { type: 'start', run, width, height }
 *      { type: 'frame', t, userWaited, buffer }   RGBA pixels, transferred
 *      { type: 'save', id, t, userWaited }
 * Out: { type: 'stats', run, stats }   one per frame, so the page can count frames in flight
 *      { type: 'saved', id, bytes, lengthMs, size, limit }   bytes transferred
 *      { type: 'saveFailed', id, message }
 *      { type: 'error', run, message }   encoding failed; frames are ignored until the next start
 */
import { createFrameEncoder } from './frame-encoder.js';

/**
 * @param {(message: object, transfer?: Transferable[]) => void} post
 * @returns {(message: object) => void}
 */
export function createWorkerHandler(post) {
  let encoder = null;
  let run = 0;

  function save({ id, t, userWaited }) {
    if (!encoder) {
      post({ type: 'saveFailed', id, message: 'Nothing recorded yet' });
      return;
    }
    try {
      const result = encoder.finish(t, userWaited);
      post({ type: 'saved', id, ...result }, [result.bytes.buffer]);
    } catch (error) {
      post({ type: 'saveFailed', id, message: error?.message ?? String(error) });
    }
  }

  return function handle(message) {
    if (message.type === 'start') {
      run = message.run;
      encoder = createFrameEncoder({ width: message.width, height: message.height });
    } else if (message.type === 'frame') {
      if (!encoder) return;
      try {
        const stats = encoder.addFrame(new Uint8Array(message.buffer), message.t, message.userWaited);
        post({ type: 'stats', run, stats });
      } catch (error) {
        encoder = null;
        post({ type: 'error', run, message: error?.message ?? String(error) });
      }
    } else if (message.type === 'save') {
      save(message);
    }
  };
}
