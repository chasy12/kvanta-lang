/**
 * limits.js
 *
 * How much of a run a GIF keeps and how long pauses play back. Shared by the
 * encoder in the worker and the recorder on the page.
 */

/** Longest playback: the start of the run, up to one minute. */
export const MAX_PLAYBACK_MS = 60_000;
/** Largest file. */
export const MAX_BYTES = 20 * 1024 * 1024;
/** Longest pause while the program itself waits (sleep(), an unchanged picture). */
export const PROGRAM_WAIT_CAP_MS = 3000;
/** Longest pause when the user was waited on (console input, key or mouse handlers). */
export const USER_WAIT_CAP_MS = 500;

/**
 * The longest a picture may stay on screen in the GIF.
 *
 * @param {boolean} userWaited - The user was waited on while it was shown.
 * @returns {number}
 */
export function waitCap(userWaited) {
  return userWaited ? USER_WAIT_CAP_MS : PROGRAM_WAIT_CAP_MS;
}

/**
 * Length and size of the GIF that saving at `now` would produce.
 *
 * @param {null | { frames: number, closedMs: number, openStart: number | null,
 *   openUserWaited: boolean, bytes: number, limit: null | 'time' | 'size' }} stats
 *   The encoder's latest stats, or `null` before the first frame.
 * @param {number} now - When the clip would end, on the clock of the frame times.
 * @param {boolean} userWaited - The user was waited on since the last frame.
 * @returns {{ frames: number, lengthMs: number, bytes: number, limit: null | 'time' | 'size' }}
 */
export function clipStats(stats, now, userWaited) {
  if (!stats || stats.frames === 0) return { frames: 0, lengthMs: 0, bytes: 0, limit: null };
  let lengthMs = stats.closedMs;
  if (stats.openStart !== null) {
    lengthMs += Math.min(Math.max(0, now - stats.openStart), waitCap(stats.openUserWaited || userWaited));
  }
  lengthMs = Math.min(lengthMs, MAX_PLAYBACK_MS);
  const limit = stats.limit ?? (lengthMs >= MAX_PLAYBACK_MS ? 'time' : null);
  return { frames: stats.frames, lengthMs, bytes: stats.bytes, limit };
}
