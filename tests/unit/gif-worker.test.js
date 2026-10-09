/**
 * Tests for web/gif/worker-handler.js, the message handling of the GIF worker.
 */
import { describe, it, expect, vi } from 'vitest';
import omggif from 'omggif';
import { createWorkerHandler } from '../../web/gif/worker-handler.js';

const W = 4;
const H = 3;

function solid(color) {
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) rgba.set([...color, 255], i * 4);
  return rgba;
}

function setup() {
  const post = vi.fn();
  return { post, handle: createWorkerHandler(post) };
}

function frame(t, color) {
  return { type: 'frame', t, userWaited: false, buffer: solid(color).buffer };
}

describe('createWorkerHandler', () => {
  it('reports encoder stats for each frame with the run number', () => {
    const { post, handle } = setup();
    handle({ type: 'start', run: 7, width: W, height: H });
    handle(frame(0, [255, 0, 0]));
    expect(post).toHaveBeenLastCalledWith({ type: 'stats', run: 7, stats: expect.objectContaining({ frames: 1, limit: null }) });
  });

  it('sends the finished GIF and hands its buffer over', () => {
    const { post, handle } = setup();
    handle({ type: 'start', run: 1, width: W, height: H });
    handle(frame(0, [255, 0, 0]));
    handle(frame(100, [0, 0, 255]));
    handle({ type: 'save', id: 3, t: 200, userWaited: false });
    const [message, transfer] = post.mock.calls.at(-1);
    expect(message).toMatchObject({ type: 'saved', id: 3, lengthMs: 200, limit: null });
    expect(message.size).toBe(message.bytes.length);
    expect(transfer).toEqual([message.bytes.buffer]);
    expect(new omggif.GifReader(message.bytes).numFrames()).toBe(2);
  });

  it('ignores frames that arrive before a recording starts', () => {
    const { post, handle } = setup();
    handle(frame(0, [255, 0, 0]));
    expect(post).not.toHaveBeenCalled();
  });

  it('reports a save with nothing recorded as failed', () => {
    const { post, handle } = setup();
    handle({ type: 'save', id: 1, t: 0, userWaited: false });
    expect(post).toHaveBeenLastCalledWith({ type: 'saveFailed', id: 1, message: expect.any(String) });
  });

  it('reports an encoding error and stops encoding', () => {
    const { post, handle } = setup();
    handle({ type: 'start', run: 1, width: W, height: H });
    handle({ type: 'frame', t: 0, userWaited: false, buffer: new ArrayBuffer(8) });
    expect(post).toHaveBeenLastCalledWith({ type: 'error', message: expect.stringContaining('size') });
    post.mockClear();
    handle(frame(10, [255, 0, 0]));
    expect(post).not.toHaveBeenCalled();
  });

  it('finishes a save with the previous clip when a new run starts right after', () => {
    const { post, handle } = setup();
    handle({ type: 'start', run: 1, width: W, height: H });
    handle(frame(0, [255, 0, 0]));
    handle(frame(100, [0, 0, 255]));
    handle({ type: 'save', id: 1, t: 200, userWaited: false });
    handle({ type: 'start', run: 2, width: W, height: H });
    handle(frame(0, [0, 255, 0]));
    const saved = post.mock.calls.map(([message]) => message).find(message => message.type === 'saved');
    expect(new omggif.GifReader(saved.bytes).numFrames()).toBe(2);
    expect(post).toHaveBeenLastCalledWith({ type: 'stats', run: 2, stats: expect.objectContaining({ frames: 1 }) });
  });
});
