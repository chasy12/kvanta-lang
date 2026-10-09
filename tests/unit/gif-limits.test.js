/**
 * Tests for web/gif/limits.js.
 */
import { describe, it, expect } from 'vitest';
import { clipStats, waitCap, MAX_PLAYBACK_MS, MAX_BYTES } from '../../web/gif/limits.js';

const stats = (over) => ({ frames: 3, closedMs: 1000, openStart: 5000, openUserWaited: false, bytes: 4000, limit: null, ...over });

describe('limits', () => {
  it('keep one minute and 20 MB', () => {
    expect(MAX_PLAYBACK_MS).toBe(60_000);
    expect(MAX_BYTES).toBe(20 * 1024 * 1024);
  });

  it('cap pauses at 3 s, or 0.5 s when the user was waited on', () => {
    expect(waitCap(false)).toBe(3000);
    expect(waitCap(true)).toBe(500);
  });
});

describe('clipStats', () => {
  it('is empty before the first frame', () => {
    expect(clipStats(null, 100, false)).toEqual({ frames: 0, lengthMs: 0, bytes: 0, limit: null });
  });

  it('counts the open frame up to now', () => {
    expect(clipStats(stats(), 5800, false)).toEqual({ frames: 3, lengthMs: 1800, bytes: 4000, limit: null });
  });

  it('caps the open frame at 3 s while the program waits', () => {
    expect(clipStats(stats(), 20_000, false).lengthMs).toBe(4000);
  });

  it('caps the open frame at 0.5 s when the user was waited on', () => {
    expect(clipStats(stats(), 20_000, true).lengthMs).toBe(1500);
    expect(clipStats(stats({ openUserWaited: true }), 20_000, false).lengthMs).toBe(1500);
  });

  it('reports the time limit once the open frame reaches a minute', () => {
    expect(clipStats(stats({ closedMs: 59_000 }), 9000, false)).toMatchObject({ lengthMs: 60_000, limit: 'time' });
  });

  it('keeps the encoder limit and stops counting when no frame is open', () => {
    expect(clipStats(stats({ openStart: null, limit: 'size' }), 99_000, false)).toMatchObject({ lengthMs: 1000, limit: 'size' });
  });
});
