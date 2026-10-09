/**
 * gif-worker.js
 *
 * Web Worker that encodes recorded frames into a GIF (see worker-handler.js).
 */
import { createWorkerHandler } from './worker-handler.js';

const handle = createWorkerHandler((message, transfer = []) => self.postMessage(message, transfer));
self.onmessage = (event) => handle(event.data);
