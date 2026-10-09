/**
 * Tests for web/gif/recorder.js with a fake worker, a fake canvas and fake timers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRecorder, GIF_SIZE } from '../../web/gif/recorder.js';

function setup({ createWorker } = {}) {
  const worker = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null };
  const context = {
    drawImage: vi.fn(),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(GIF_SIZE * GIF_SIZE * 4) })),
  };
  const canvas = { width: 0, height: 0, getContext: vi.fn(() => context) };
  const onStats = vi.fn();
  const recorder = createRecorder({
    onStats,
    createWorker: createWorker ?? (() => worker),
    createCanvas: () => canvas,
    now: () => Date.now(),
  });
  const messages = () => worker.postMessage.mock.calls.map(([message]) => message);
  const frames = () => messages().filter(message => message.type === 'frame');
  const reply = (data) => worker.onmessage({ data });
  return { worker, context, canvas, onStats, recorder, messages, frames, reply };
}

const encoderStats = (over) => ({ frames: 2, closedMs: 1000, openStart: 1000, openUserWaited: false, bytes: 5000, limit: null, ...over });

beforeEach(() => vi.useFakeTimers({ now: 0 }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createRecorder', () => {
  it('starts the encoder for a new run at the GIF size', () => {
    const { recorder, messages, onStats } = setup();
    recorder.start();
    expect(messages()).toEqual([{ type: 'start', run: 1, width: 500, height: 500 }]);
    expect(onStats).toHaveBeenLastCalledWith({ frames: 0, lengthMs: 0, bytes: 0, limit: null });
  });

  it('captures the first picture right away, scaled from the whole canvas', () => {
    const { recorder, context, canvas, worker, frames } = setup();
    recorder.start();
    const shown = { id: 'canvas' };
    recorder.present(shown);
    expect(canvas.getContext).toHaveBeenCalledWith('2d', { willReadFrequently: true });
    expect(context.drawImage).toHaveBeenCalledWith(shown, 0, 0, 500, 500);
    expect(frames()).toEqual([{ type: 'frame', t: 0, userWaited: false, buffer: expect.any(ArrayBuffer) }]);
    const [message, transfer] = worker.postMessage.mock.calls.find(([m]) => m.type === 'frame');
    expect(transfer).toEqual([message.buffer]);
  });

  it('captures at most 30 times a second and keeps the last picture of a burst', () => {
    const { recorder, context, frames } = setup();
    recorder.start();
    recorder.present('first');
    for (let i = 1; i <= 10; i++) {
      vi.advanceTimersByTime(2);
      recorder.present(`burst ${i}`);
    }
    expect(frames()).toHaveLength(1);
    vi.advanceTimersByTime(33);
    expect(frames()).toHaveLength(2);
    expect(frames()[1].t).toBe(33);
    expect(context.drawImage).toHaveBeenLastCalledWith('burst 10', 0, 0, 500, 500);
  });

  it('captures a picture right away after a quiet spell', () => {
    const { recorder, frames } = setup();
    recorder.start();
    recorder.present('a');
    vi.advanceTimersByTime(100);
    recorder.present('b');
    expect(frames().map(frame => frame.t)).toEqual([0, 100]);
  });

  it('marks a frame when the user was waited on since the previous one', () => {
    const { recorder, frames } = setup();
    recorder.start();
    recorder.present('a');
    recorder.setWaitingForUser(true);
    vi.advanceTimersByTime(50);
    recorder.setWaitingForUser(false);
    recorder.present('b');
    vi.advanceTimersByTime(50);
    recorder.present('c');
    expect(frames().map(frame => frame.userWaited)).toEqual([false, true, false]);
  });

  it('marks every frame while the user is still being waited on', () => {
    const { recorder, frames } = setup();
    recorder.start();
    recorder.setWaitingForUser(true);
    for (let i = 0; i < 3; i++) {
      recorder.present(`key ${i}`);
      vi.advanceTimersByTime(1000);
    }
    expect(frames().map(frame => frame.userWaited)).toEqual([true, true, true]);
  });

  it('scales every picture from the whole canvas whatever its size', () => {
    const { recorder, context } = setup();
    recorder.start();
    recorder.present({ width: 1000, height: 1000 });
    vi.advanceTimersByTime(40);
    recorder.present({ width: 3000, height: 3000 });
    expect(context.drawImage.mock.calls.map(call => call.slice(1))).toEqual([[0, 0, 500, 500], [0, 0, 500, 500]]);
  });

  it('keeps the last picture of a burst on stop, then stops capturing', () => {
    const { recorder, frames } = setup();
    recorder.start();
    recorder.present('a');
    vi.advanceTimersByTime(10);
    recorder.present('b');
    recorder.stop();
    expect(frames().map(frame => frame.t)).toEqual([0, 10]);
    vi.advanceTimersByTime(100);
    recorder.present('c');
    expect(frames()).toHaveLength(2);
  });

  it('measures the clip up to the stop time', () => {
    const { recorder, reply } = setup();
    recorder.start();
    reply({ type: 'stats', run: 1, stats: encoderStats() });
    vi.advanceTimersByTime(2000);
    recorder.stop();
    expect(recorder.stats().lengthMs).toBe(2000);
    vi.advanceTimersByTime(5000);
    expect(recorder.stats().lengthMs).toBe(2000);
  });

  it('stops capturing once the encoder reports a limit', () => {
    const { recorder, reply, frames, onStats } = setup();
    recorder.start();
    recorder.present('a');
    reply({ type: 'stats', run: 1, stats: encoderStats({ limit: 'size', openStart: null }) });
    expect(onStats).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 'size' }));
    vi.advanceTimersByTime(100);
    recorder.present('b');
    expect(frames()).toHaveLength(1);
  });

  it('ignores stats from an earlier run', () => {
    const { recorder, reply } = setup();
    recorder.start();
    recorder.start();
    reply({ type: 'stats', run: 1, stats: encoderStats() });
    expect(recorder.canSave()).toBe(false);
  });

  it('allows saving once two different frames are stored', () => {
    const { recorder, reply } = setup();
    recorder.start();
    expect(recorder.canSave()).toBe(false);
    reply({ type: 'stats', run: 1, stats: encoderStats({ frames: 1 }) });
    expect(recorder.canSave()).toBe(false);
    reply({ type: 'stats', run: 1, stats: encoderStats({ frames: 2 }) });
    expect(recorder.canSave()).toBe(true);
  });

  it('reports the clip about twice a second while recording', () => {
    const { recorder, onStats } = setup();
    recorder.start();
    onStats.mockClear();
    vi.advanceTimersByTime(1000);
    expect(onStats).toHaveBeenCalledTimes(2);
    recorder.stop();
    onStats.mockClear();
    vi.advanceTimersByTime(1000);
    expect(onStats).not.toHaveBeenCalled();
  });

  it('saves the clip as it was at the given time', async () => {
    const { recorder, reply, messages } = setup();
    recorder.start();
    recorder.present('a');
    reply({ type: 'stats', run: 1, stats: encoderStats() });
    vi.advanceTimersByTime(1000);
    const saving = recorder.save(400);
    const request = messages().at(-1);
    expect(request).toEqual({ type: 'save', id: expect.any(Number), t: 400, userWaited: false });
    const bytes = new Uint8Array([1, 2]);
    reply({ type: 'saved', id: request.id, bytes, lengthMs: 400, size: 2, limit: null });
    await expect(saving).resolves.toEqual({ bytes, lengthMs: 400, size: 2, limit: null });
  });

  it('ends the clip at the stop time when saving after a stop', () => {
    const { recorder, reply, messages } = setup();
    recorder.start();
    recorder.present('a');
    reply({ type: 'stats', run: 1, stats: encoderStats() });
    vi.advanceTimersByTime(300);
    recorder.stop();
    vi.advanceTimersByTime(5000);
    recorder.save();
    expect(messages().at(-1)).toMatchObject({ type: 'save', t: 300 });
  });

  it('includes a pending picture of a burst in the save', () => {
    const { recorder, reply, frames } = setup();
    recorder.start();
    recorder.present('a');
    reply({ type: 'stats', run: 1, stats: encoderStats() });
    vi.advanceTimersByTime(10);
    recorder.present('b');
    recorder.save(10);
    expect(frames().map(frame => frame.t)).toEqual([0, 10]);
  });

  it('rejects a save the encoder could not finish', async () => {
    const { recorder, reply, messages } = setup();
    recorder.start();
    reply({ type: 'stats', run: 1, stats: encoderStats() });
    const saving = recorder.save();
    reply({ type: 'saveFailed', id: messages().at(-1).id, message: 'boom' });
    await expect(saving).rejects.toThrow('boom');
  });

  it('rejects saving before two frames are stored', async () => {
    const { recorder } = setup();
    recorder.start();
    await expect(recorder.save()).rejects.toThrow();
  });

  it('keeps working when workers are unavailable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { recorder, onStats } = setup({ createWorker: () => { throw new Error('no workers'); } });
    expect(() => {
      recorder.start();
      recorder.present('a');
      recorder.setWaitingForUser(true);
      recorder.stop();
    }).not.toThrow();
    expect(recorder.canSave()).toBe(false);
    expect(onStats).toHaveBeenLastCalledWith({ frames: 0, lengthMs: 0, bytes: 0, limit: null });
    expect(warn).toHaveBeenCalled();
  });

  it('turns recording off when the worker fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { recorder, reply, worker, frames, onStats } = setup();
    recorder.start();
    recorder.present('a');
    reply({ type: 'stats', run: 1, stats: encoderStats() });
    const saving = recorder.save();
    worker.onerror({ message: 'crash' });
    await expect(saving).rejects.toThrow('crash');
    expect(worker.terminate).toHaveBeenCalled();
    expect(recorder.canSave()).toBe(false);
    expect(onStats).toHaveBeenLastCalledWith(expect.objectContaining({ frames: 0 }));
    vi.advanceTimersByTime(100);
    recorder.present('b');
    expect(frames()).toHaveLength(1);
  });

  it('turns recording off when encoding fails', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { recorder, reply } = setup();
    recorder.start();
    reply({ type: 'stats', run: 1, stats: encoderStats() });
    reply({ type: 'error', message: 'bad frame' });
    expect(recorder.canSave()).toBe(false);
  });

  it('ignores capture errors', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { recorder, context } = setup();
    context.getImageData.mockImplementation(() => { throw new Error('tainted'); });
    recorder.start();
    expect(() => recorder.present('a')).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});
