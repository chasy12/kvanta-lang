/**
 * The real recorder talking to the real worker handler through a fake worker:
 * pictures go in, a GIF comes out, and the meter agrees with the file.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import omggif from 'omggif';
import { createRecorder, GIF_SIZE } from '../../web/gif/recorder.js';
import { createWorkerHandler } from '../../web/gif/worker-handler.js';

/** Fake canvas whose picture is a 10×10 box on a solid background; `box` moves it. */
function setup({ workerDelayMs = 0 } = {}) {
  let box = 0;
  const worker = { onmessage: null, onerror: null, terminate: vi.fn() };
  const handle = createWorkerHandler((data) => worker.onmessage({ data }));
  let waiting = 0;
  worker.waiting = () => waiting;
  worker.postMessage = (message) => {
    if (message.type === 'frame') waiting += 1;
    setTimeout(() => {
      if (message.type === 'frame') waiting -= 1;
      handle(message);
    }, workerDelayMs);
  };

  const context = {
    drawImage: vi.fn(),
    getImageData: vi.fn(() => {
      const data = new Uint8ClampedArray(GIF_SIZE * GIF_SIZE * 4);
      for (let i = 0; i < GIF_SIZE * GIF_SIZE; i++) data.set([20, 30, 40, 255], i * 4);
      for (let y = 100; y < 110; y++) {
        for (let x = box; x < box + 10; x++) data.set([250, 200, 0, 255], (y * GIF_SIZE + x) * 4);
      }
      return { data };
    }),
  };
  const onStats = vi.fn();
  const recorder = createRecorder({
    onStats,
    createWorker: () => worker,
    createCanvas: () => ({ width: 0, height: 0, getContext: () => context }),
    now: () => Date.now(),
  });
  return { recorder, onStats, worker, show: (x) => { box = x; recorder.present({}); } };
}

beforeEach(() => vi.useFakeTimers({ now: 0 }));
afterEach(() => vi.useRealTimers());

describe('GIF recording end to end', () => {
  it('saves a GIF whose frames, delays and size match the meter', async () => {
    const { recorder, onStats, show } = setup();
    recorder.start();
    show(0);
    for (const x of [40, 80]) {
      await vi.advanceTimersByTimeAsync(100);
      show(x);
    }
    await vi.advanceTimersByTimeAsync(200);
    expect(recorder.canSave()).toBe(true);

    const saved = await (async () => {
      const saving = recorder.save(300);
      await vi.advanceTimersByTimeAsync(10);
      return saving;
    })();

    const reader = new omggif.GifReader(saved.bytes);
    expect(reader.width).toBe(GIF_SIZE);
    expect(reader.numFrames()).toBe(3);
    expect([0, 1, 2].map(i => reader.frameInfo(i).delay)).toEqual([10, 10, 10]);
    expect(saved.lengthMs).toBe(300);
    expect(saved.size).toBe(saved.bytes.length);

    const meter = onStats.mock.calls.at(-1)[0];
    expect(recorder.stats()).toMatchObject({ frames: 3, bytes: saved.size });
    expect(meter.frames).toBe(3);
  });

  it('never has more than two frames waiting for a slow worker, and still ends on the last picture', async () => {
    const { recorder, show, worker } = setup({ workerDelayMs: 150 });
    recorder.start();
    let mostWaiting = 0;
    for (let i = 0; i < 10; i++) {
      show(i * 10);
      mostWaiting = Math.max(mostWaiting, worker.waiting());
      await vi.advanceTimersByTimeAsync(40);
    }
    expect(mostWaiting).toBe(2);
    const saving = recorder.save(400);
    await vi.advanceTimersByTimeAsync(1000);
    const saved = await saving;
    const reader = new omggif.GifReader(saved.bytes);
    expect(reader.numFrames()).toBeGreaterThanOrEqual(3);
    expect(reader.numFrames()).toBeLessThan(10);
    expect(saved.lengthMs).toBe(400);
    // The last picture shown (box at x = 90) is the one the clip ends on.
    const pixels = new Uint8Array(GIF_SIZE * GIF_SIZE * 4);
    reader.decodeAndBlitFrameRGBA(reader.numFrames() - 1, pixels);
    expect(Array.from(pixels.slice((105 * GIF_SIZE + 95) * 4, (105 * GIF_SIZE + 95) * 4 + 3))).toEqual([250, 200, 0]);
  });
});
