/**
 * gif-meter.js
 *
 * Shows how long and how large the GIF of the current run would be, and
 * whether recording stopped at a limit.
 */
import { t, getLanguage } from '../i18n.js';

/**
 * Clip length as `m:ss`, rounded down to whole seconds.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatClipLength(ms) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * File size in megabytes: one decimal below 10 MB, whole above, at least 0.1.
 *
 * @param {number} bytes
 * @returns {string}
 */
export function formatMegabytes(bytes) {
  const megabytes = Math.max(0.1, bytes / (1024 * 1024));
  const digits = megabytes < 10 ? 1 : 0;
  const number = new Intl.NumberFormat(getLanguage(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(megabytes);
  return t('megabytes', number);
}

/**
 * Create the readout in `el`. It is hidden until two different frames are
 * recorded; at a limit it says "full" and its tooltip names the limit.
 *
 * @param {HTMLElement} el
 * @returns {{ update(stats: { frames: number, lengthMs: number, bytes: number, limit: null | 'time' | 'size' }): void, refresh(): void }}
 */
export function createGifMeter(el) {
  let shown = null;

  function render() {
    if (!shown || shown.frames < 2) {
      el.hidden = true;
      el.removeAttribute('title');
      return;
    }
    el.textContent = t(shown.limit ? 'gifMeterFull' : 'gifMeter', formatClipLength(shown.lengthMs), formatMegabytes(shown.bytes));
    if (shown.limit) el.title = t(shown.limit === 'time' ? 'gifTimeLimit' : 'gifSizeLimit');
    else el.removeAttribute('title');
    el.hidden = false;
  }

  return {
    /** Show the clip that saving now would produce. */
    update(stats) {
      shown = stats;
      render();
    },
    /** Redraw in the current language. */
    refresh: render,
  };
}
