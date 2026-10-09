/**
 * recorder.js
 *
 * Records what the canvas shows during a run so its start can be saved as a
 * GIF. At most 30 pictures a second are scaled to 500×500 and handed to a
 * worker that encodes each one straight away (see gif-worker.js).
 */
import { clipStats } from './limits.js';

/** Shortest time between two captures: 30 a second. */
export const CAPTURE_INTERVAL_MS = 33;
/** Width and height of the GIF. */
export const GIF_SIZE = 500;
/** How often the clip length is reported while recording. */
const STATS_INTERVAL_MS = 500;

function createGifWorker() {
  return new Worker(new URL('./gif-worker.js', import.meta.url), { type: 'module' });
}

/**
 * @param {{
 *   onStats?: (stats: { frames: number, lengthMs: number, bytes: number, limit: null | 'time' | 'size' }) => void,
 *   createWorker?: () => Worker,
 *   createCanvas?: () => HTMLCanvasElement,
 *   now?: () => number,
 * }} [options]
 */
export function createRecorder({
  onStats = () => {},
  createWorker = createGifWorker,
  createCanvas = () => document.createElement('canvas'),
  now = () => performance.now(),
} = {}) {
  let worker = null;
  let context = null;
  /** Number of the current recording, echoed by the worker with its stats. */
  let run = 0;
  let capturing = false;
  /** Canvas holding the latest picture. */
  let source = null;
  let lastCapture = -Infinity;
  let trailingTimer = null;
  let statsTimer = null;
  /** The program is waiting for the user right now. */
  let waiting = false;
  /** The user was waited on at some point since the last capture. */
  let waitedSinceCapture = false;
  let stoppedAt = null;
  let encoderStats = null;
  let lastSaveId = 0;
  const pendingSaves = new Map();

  function stats() {
    return clipStats(encoderStats, stoppedAt ?? now(), waiting || waitedSinceCapture);
  }

  function report() {
    onStats(stats());
  }

  function halt() {
    capturing = false;
    clearTimeout(trailingTimer);
    trailingTimer = null;
    clearInterval(statsTimer);
    statsTimer = null;
  }

  function fail(error) {
    console.warn('GIF recording stopped:', error);
    halt();
    worker?.terminate();
    worker = null;
    encoderStats = null;
    for (const { reject } of pendingSaves.values()) reject(error);
    pendingSaves.clear();
    report();
  }

  function receive(message) {
    if (message.type === 'stats') {
      if (message.run !== run) return;
      encoderStats = message.stats;
      if (message.stats.limit) halt();
      report();
    } else if (message.type === 'saved' || message.type === 'saveFailed') {
      const pending = pendingSaves.get(message.id);
      pendingSaves.delete(message.id);
      if (message.type === 'saved') {
        pending?.resolve({ bytes: message.bytes, lengthMs: message.lengthMs, size: message.size, limit: message.limit });
      } else {
        pending?.reject(new Error(message.message));
      }
    } else if (message.type === 'error') {
      fail(new Error(message.message));
    }
  }

  function connect() {
    if (worker) return true;
    try {
      worker = createWorker();
    } catch (error) {
      console.warn('GIF recording is not available:', error);
      return false;
    }
    worker.onmessage = (event) => receive(event.data);
    worker.onerror = (event) => fail(new Error(event?.message || 'GIF worker failed'));
    return true;
  }

  /** Send the picture on screen to the encoder as shown at time `t`. */
  function capture(t) {
    clearTimeout(trailingTimer);
    trailingTimer = null;
    lastCapture = t;
    try {
      if (!context) {
        const canvas = createCanvas();
        canvas.width = GIF_SIZE;
        canvas.height = GIF_SIZE;
        context = canvas.getContext('2d', { willReadFrequently: true });
      }
      context.drawImage(source, 0, 0, GIF_SIZE, GIF_SIZE);
      const { data } = context.getImageData(0, 0, GIF_SIZE, GIF_SIZE);
      const userWaited = waiting || waitedSinceCapture;
      waitedSinceCapture = waiting;
      worker.postMessage({ type: 'frame', t, userWaited, buffer: data.buffer }, [data.buffer]);
    } catch (error) {
      console.warn('GIF capture failed:', error);
    }
  }

  function canSave() {
    return worker !== null && (encoderStats?.frames ?? 0) >= 2;
  }

  return {
    /** Forget the previous recording and record a new run. */
    start() {
      halt();
      run += 1;
      source = null;
      lastCapture = -Infinity;
      waiting = false;
      waitedSinceCapture = false;
      stoppedAt = null;
      encoderStats = null;
      if (connect()) {
        worker.postMessage({ type: 'start', run, width: GIF_SIZE, height: GIF_SIZE });
        capturing = true;
        statsTimer = setInterval(report, STATS_INTERVAL_MS);
      }
      report();
    },

    /** A new picture is on `canvas`: capture it now, or at the next free slot. */
    present(canvas) {
      if (!capturing) return;
      source = canvas;
      if (trailingTimer !== null) return;
      const wait = lastCapture + CAPTURE_INTERVAL_MS - now();
      if (wait <= 0) capture(now());
      else trailingTimer = setTimeout(() => capture(now()), wait);
    },

    /** Whether the program is waiting for the user (console input, or only handlers left). */
    setWaitingForUser(value) {
      if (!capturing) return;
      waiting = value;
      if (value) waitedSinceCapture = true;
    },

    /** Stop capturing; the recording stays available for saving. */
    stop() {
      if (capturing) {
        const t = now();
        if (trailingTimer !== null) capture(t);
        stoppedAt = t;
      }
      halt();
      report();
    },

    stats,
    canSave,

    /**
     * Assemble the GIF of the clip ending at `at` (or at the stop time, if earlier).
     *
     * @param {number} [at]
     * @returns {Promise<{ bytes: Uint8Array, lengthMs: number, size: number, limit: null | 'time' | 'size' }>}
     */
    save(at = now()) {
      if (!canSave()) return Promise.reject(new Error('Nothing recorded yet'));
      const end = stoppedAt === null ? at : Math.min(stoppedAt, at);
      if (capturing && trailingTimer !== null) capture(end);
      const id = ++lastSaveId;
      return new Promise((resolve, reject) => {
        pendingSaves.set(id, { resolve, reject });
        worker.postMessage({ type: 'save', id, t: end, userWaited: waiting || waitedSinceCapture });
      });
    },
  };
}
