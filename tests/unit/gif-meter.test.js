/**
 * Tests for web/gif/gif-meter.js.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createGifMeter, formatClipLength, formatMegabytes } from '../../web/gif/gif-meter.js';
import { setLanguage } from '../../web/i18n.js';

const MB = 1024 * 1024;

beforeEach(() => setLanguage('en'));

describe('formatClipLength', () => {
  it('shows minutes and whole seconds', () => {
    expect(formatClipLength(0)).toBe('0:00');
    expect(formatClipLength(24_000)).toBe('0:24');
    expect(formatClipLength(59_999)).toBe('0:59');
    expect(formatClipLength(60_000)).toBe('1:00');
    expect(formatClipLength(125_000)).toBe('2:05');
  });
});

describe('formatMegabytes', () => {
  it('shows one decimal below 10 MB and whole megabytes above', () => {
    expect(formatMegabytes(3.1 * MB)).toBe('3.1 MB');
    expect(formatMegabytes(8.44 * MB)).toBe('8.4 MB');
    expect(formatMegabytes(20 * MB)).toBe('20 MB');
    expect(formatMegabytes(19.96 * MB)).toBe('20 MB');
  });

  it('never shows less than 0.1 MB', () => {
    expect(formatMegabytes(1000)).toBe('0.1 MB');
  });

  it('uses the language of the interface', () => {
    setLanguage('uk');
    expect(formatMegabytes(3.1 * MB)).toBe('3,1 МБ');
  });
});

describe('createGifMeter', () => {
  let el;
  let meter;

  beforeEach(() => {
    el = document.createElement('span');
    el.hidden = true;
    meter = createGifMeter(el);
  });

  it('stays hidden until two different frames are recorded', () => {
    meter.update({ frames: 1, lengthMs: 0, bytes: 2000, limit: null });
    expect(el.hidden).toBe(true);
    meter.update({ frames: 2, lengthMs: 24_000, bytes: 3.1 * MB, limit: null });
    expect(el.hidden).toBe(false);
    expect(el.textContent).toBe('GIF 0:24 · 3.1 MB');
    expect(el.hasAttribute('title')).toBe(false);
  });

  it('says the clip is full and why at the time limit', () => {
    meter.update({ frames: 900, lengthMs: 60_000, bytes: 8.4 * MB, limit: 'time' });
    expect(el.textContent).toBe('GIF 1:00 · 8.4 MB · full');
    expect(el.title).toBe('Recording stopped: 60 s limit');
  });

  it('says the clip is full and why at the size limit', () => {
    meter.update({ frames: 400, lengthMs: 18_000, bytes: 19.99 * MB, limit: 'size' });
    expect(el.textContent).toBe('GIF 0:18 · 20 MB · full');
    expect(el.title).toBe('Recording stopped: 20 MB limit');
  });

  it('hides itself and its tooltip for a new run', () => {
    meter.update({ frames: 900, lengthMs: 60_000, bytes: 8.4 * MB, limit: 'time' });
    meter.update({ frames: 0, lengthMs: 0, bytes: 0, limit: null });
    expect(el.hidden).toBe(true);
    expect(el.hasAttribute('title')).toBe(false);
  });

  it('shows the last reading in a new language on refresh', () => {
    meter.update({ frames: 2, lengthMs: 24_000, bytes: 3.1 * MB, limit: null });
    setLanguage('uk');
    meter.refresh();
    expect(el.textContent).toBe('GIF 0:24 · 3,1 МБ');
  });
});
