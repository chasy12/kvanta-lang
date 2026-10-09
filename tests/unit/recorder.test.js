/**
 * Tests for web/gif/recorder.js with a fake worker, a fake canvas and fake timers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRecorder, GIF_SIZE, MAX_FRAMES_IN_FLIGHT } from '../../web/gif/recorder.js';

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
    const { recorder, frames, reply } = setup();
    recorder.start();
    recorder.present('a');
    reply({ type: 'stats', run: 1, stats: encoderStats() });
    recorder.setWaitingForUser(true);
    vi.advanceTimersByTime(50);
    recorder.setWaitingForUser(false);
    recorder.present('b');
    reply({ type: 'stats', run: 1, stats: encoderStats() });
    vi.advanceTimersByTime(50);
    recorder.present('c');
    expect(frames().map(frame => frame.userWaited)).toEqual([false, true, false]);
  });

  it('marks every frame while the user is still being waited on', () => {
    const { recorder, frames, reply } = setup();
    recorder.start();
    recorder.setWaitingForUser(true);
    for (let i = 0; i < 3; i++) {
      recorder.present(`key ${i}`);
      reply({ type: 'stats', run: 1, stats: encoderStats() });
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
    reply({ type: 'error', run: 1, message: 'bad frame' });
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

describe('backpressure', () => {
  it('posts no more than MAX_FRAMES_IN_FLIGHT frames while the worker has not answered', () => {
    const { recorder, frames, reply, context } = setup();
    expect(MAX_FRAMES_IN_FLIGHT).toBe(2);
    recorder.start();
    for (let i = 0; i <= 25; i++) {
      recorder.present(`picture ${i}`);
      vi.advanceTimersByTime(40);
    }
    expect(frames()).toHaveLength(2);
    reply({ type: 'stats', run: 1, stats: encoderStats() });
    expect(frames()).toHaveLength(3);
    expect(frames()[2].t).toBe(1040);
    expect(context.drawImage).toHaveBeenLastCalledWith('picture 25', 0, 0, 500, 500);
  });

  it('waits for the next slot when an answer comes before the capture interval has passed', () => {
    const { recorder, frames, reply } = setup();
    recorder.start();
    recorder.present('a');
    vi.advanceTimersByTime(40);
    recorder.present('b');
    vi.advanceTimersByTime(40);
    recorder.present('c');
    reply({ type: 'stats', run: 1, stats: encoderStats() });
    expect(frames()).toHaveLength(2 + 1);
    expect(frames()[2].t).toBe(80);
    recorder.present('d');
    reply({ type: 'stats', run: 1, stats: encoderStats() });
    expect(frames()).toHaveLength(3);
    vi.advanceTimersByTime(33);
    expect(frames()).toHaveLength(4);
    expect(frames()[3].t).toBe(113);
  });

  it('does not free a slot for an answer from an earlier run', () => {
    const { recorder, frames, reply } = setup();
    recorder.start();
    recorder.start();
    recorder.present('a');
    vi.advanceTimersByTime(40);
    recorder.present('b');
    vi.advanceTimersByTime(40);
    recorder.present('c');
    expect(frames()).toHaveLength(2);
    reply({ type: 'stats', run: 1, stats: encoderStats() });
    expect(frames()).toHaveLength(2);
    reply({ type: 'stats', run: 2, stats: encoderStats() });
    expect(frames()).toHaveLength(3);
  });

  it('starts every run with free slots', () => {
    const { recorder, frames } = setup();
    recorder.start();
    recorder.present('a');
    vi.advanceTimersByTime(40);
    recorder.present('b');
    recorder.start();
    recorder.present('c');
    expect(frames().map(frame => frame.t)).toEqual([0, 40, 40]);
  });

  it('still records the final picture on stop when the worker is behind', () => {
    const { recorder, frames, context } = setup();
    recorder.start();
    recorder.present('a');
    vi.advanceTimersByTime(40);
    recorder.present('b');
    vi.advanceTimersByTime(40);
    recorder.present('last');
    expect(frames()).toHaveLength(2);
    vi.advanceTimersByTime(60);
    recorder.stop();
    expect(frames().map(frame => frame.t)).toEqual([0, 40, 140]);
    expect(context.drawImage).toHaveBeenLastCalledWith('last', 0, 0, 500, 500);
  });

  it('includes the final picture in a save when the worker is behind', () => {
    const { recorder, frames, reply } = setup();
    recorder.start();
    recorder.present('a');
    vi.advanceTimersByTime(40);
    recorder.present('b');
    reply({ type: 'stats', run: 1, stats: encoderStats() });
    vi.advanceTimersByTime(40);
    recorder.present('c');
    vi.advanceTimersByTime(40);
    recorder.present('d');
    recorder.save(130);
    expect(frames().map(frame => frame.t)).toEqual([0, 40, 80, 130]);
  });

  it('stops asking for captures when the encoder fails', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { recorder, frames, reply } = setup();
    recorder.start();
    recorder.present('a');
    vi.advanceTimersByTime(40);
    recorder.present('b');
    vi.advanceTimersByTime(40);
    recorder.present('c');
    reply({ type: 'error', run: 1, message: 'bad frame' });
    reply({ type: 'stats', run: 1, stats: encoderStats() });
    vi.advanceTimersByTime(100);
    expect(frames()).toHaveLength(2);
  });
});

describe('waits around a save', () => {
  it('counts the gap after a save as a wait for the user', () => {
    const { recorder, frames, reply } = setup();
    recorder.start();
    recorder.present('a');
    reply({ type: 'stats', run: 1, stats: encoderStats() });
    vi.advanceTimersByTime(500);
    recorder.save(500);
    vi.advanceTimersByTime(4000);
    recorder.present('b');
    expect(frames().map(frame => frame.userWaited)).toEqual([false, true]);
  });

  it('does not mark a save that ends the clip before the prompt', () => {
    const { recorder, messages, reply } = setup();
    recorder.start();
    recorder.present('a');
    reply({ type: 'stats', run: 1, stats: encoderStats() });
    recorder.save(100);
    expect(messages().at(-1)).toMatchObject({ type: 'save', userWaited: false });
  });

  it('does not mark later frames after a save once recording has stopped', () => {
    const { recorder, frames, reply } = setup();
    recorder.start();
    recorder.present('a');
    reply({ type: 'stats', run: 1, stats: encoderStats() });
    recorder.stop();
    recorder.save();
    recorder.present('b');
    expect(frames()).toHaveLength(1);
  });
});

describe('worker errors', () => {
  it('ignores an error from an earlier run', () => {
    const { recorder, reply } = setup();
    recorder.start();
    recorder.start();
    reply({ type: 'stats', run: 2, stats: encoderStats() });
    reply({ type: 'error', run: 1, message: 'old failure' });
    expect(recorder.canSave()).toBe(true);
  });
});
