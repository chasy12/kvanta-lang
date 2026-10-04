/**
 * fps-counter.js
 *
 * Shows how many frames per second a running program actually presents.
 */

/**
 * Create a counter that renders into `el`, updating about twice a second.
 * The element is hidden until the first frame and again after `reset()`.
 *
 * @param {HTMLElement} el
 * @param {{ intervalMs?: number }} [options]
 * @returns {{ tick(now: number): void, reset(): void }}
 */
export function createFpsCounter(el, { intervalMs = 500 } = {}) {
  let frames = 0;
  let windowStart = null;

  return {
    /** Record a presented frame at time `now` (ms, e.g. `performance.now()`). */
    tick(now) {
      if (windowStart === null) {
        windowStart = now;
        el.textContent = '– fps';
        el.hidden = false;
        return;
      }
      frames += 1;
      const elapsed = now - windowStart;
      if (elapsed >= intervalMs) {
        el.textContent = `${Math.round((frames * 1000) / elapsed)} fps`;
        frames = 0;
        windowStart = now;
      }
    },

    /** Hide the counter and forget previous frames. */
    reset() {
      frames = 0;
      windowStart = null;
      el.hidden = true;
    },
  };
}
