/**
 * recorder.js
 *
 * Records what the canvas shows during a run so its start can be saved as a
 * GIF. At most 30 pictures a second are scaled to 500×500 and handed to a
 * worker that encodes each one straight away (see gif-worker.js). The worker
 * answers every frame with its stats; only MAX_FRAMES_IN_FLIGHT frames may be
 * unanswered, so a slow encoder makes the GIF coarser instead of piling up
 * pictures in memory.
 */
import { clipStats } from './limits.js';

/** Shortest time between two captures: 30 a second. */
export const CAPTURE_INTERVAL_MS = 33;
/** Most frames sent to the worker and not yet answered. */
export const MAX_FRAMES_IN_FLIGHT = 2;
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
  /** Frames posted in this run that the worker has not answered yet. */
  let framesInFlight = 0;
  /** A capture is wanted: timer set, or deferred until the worker answers. */
  let capturePending = false;
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
    capturePending = false;
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
      framesInFlight = Math.max(0, framesInFlight - 1);
      if (message.stats.limit) halt();
      report();
      if (capturing && capturePending) scheduleCapture();
    } else if (message.type === 'saved' || message.type === 'saveFailed') {
      const pending = pendingSaves.get(message.id);
      pendingSaves.delete(message.id);
      if (message.type === 'saved') {
        pending?.resolve({ bytes: message.bytes, lengthMs: message.lengthMs, size: message.size, limit: message.limit });
      } else {
        pending?.reject(new Error(message.message));
      }
    } else if (message.type === 'error') {
      if (message.run !== run) return;
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

  /**
   * Capture the picture on screen at the next free slot: now if the capture
   * interval has passed since the last one, otherwise when it does. Nothing is
   * scheduled while the worker is too far behind; its next answer calls this again.
   */
  function scheduleCapture() {
    capturePending = true;
    if (trailingTimer !== null || framesInFlight >= MAX_FRAMES_IN_FLIGHT) return;
    const wait = lastCapture + CAPTURE_INTERVAL_MS - now();
    if (wait <= 0) {
      capture(now());
    } else {
      trailingTimer = setTimeout(() => {
        trailingTimer = null;
        scheduleCapture();
      }, wait);
    }
  }

  /** Send the picture on screen to the encoder as shown at time `t`. */
  function capture(t) {
    clearTimeout(trailingTimer);
    trailingTimer = null;
    capturePending = false;
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
      framesInFlight += 1;
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
      framesInFlight = 0;
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
      scheduleCapture();
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
        if (capturePending) capture(t);
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
      // The click time labels the picture on screen. That is only right because
      // the page then blocks on the name prompt, so nothing is drawn before the save.
      if (capturing && capturePending) capture(end);
      const id = ++lastSaveId;
      const saved = new Promise((resolve, reject) => {
        pendingSaves.set(id, { resolve, reject });
        worker.postMessage({ type: 'save', id, t: end, userWaited: waiting || waitedSinceCapture });
      });
      // This clip ends at the click, but the prompt after it blocks the page,
      // so the gap holding it is a wait for the user in later saves.
      if (capturing) waitedSinceCapture = true;
      return saved;
    },
  };
}
