/**
 * canvas-runtime.js
 *
 * Executes drawing operations from the WASM runtime on a double-buffered
 * HTML5 canvas.
 *
 * Architecture:
 *   - All drawing happens on an off-screen `bufferCanvas` first.
 *   - The result is composited onto the visible `drawCanvas` only when a
 *     frame is ready (end of a non-animation script, or an explicit frame
 *     flush during animation).
 *   - Coordinates are in logical canvas units (0–1000); a DPR scale transform
 *     maps them to physical pixels.
 */

import { CANVAS_W, CANVAS_H, deg2rad } from './canvas-utils.js';

const logEl      = document.getElementById('logs');
const drawCanvas = document.getElementById('canvas');
const drawCtx    = drawCanvas.getContext('2d', { alpha: false });

// Off-screen buffer – all drawing targets this canvas to avoid partial-frame flicker.
const bufferCanvas        = document.createElement('canvas');
bufferCanvas.width        = 1000;
bufferCanvas.height       = 1000;
const ctx                 = bufferCanvas.getContext('2d', { alpha: false });

let isAnimation = false;
let isCancelled = false;

// Cap DPR at 3 to avoid excessive memory usage on very high-density displays.
const DPR = Math.max(1, Math.min(3, window.devicePixelRatio || 1));

/** Safari requires a special repaint workaround after compositing (see `drawCommands`). */
let isSafari = false;

// Size both canvases to physical pixels and apply a DPR scale transform so
// all subsequent draw calls can use logical (CSS) pixel coordinates.
drawCanvas.width    = Math.floor(CANVAS_W * DPR);
drawCanvas.height   = Math.floor(CANVAS_H * DPR);
bufferCanvas.width  = drawCanvas.width;
bufferCanvas.height = drawCanvas.height;
ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write a message to the on-page log element.
 * Non-string values are coerced with `String()`.
 *
 * @param {*} text - Message to display.
 */
export function log(text) {
  if (typeof text !== 'string') text = String(text);
  logEl.textContent = text;
}

/**
 * Reset runtime state before executing a new program and wipe the canvas.
 */
export function setup() {
  clearCanvas();
}

/**
 * Return whether the current execution has been cancelled.
 *
 * @returns {boolean}
 */
export function checkIsCancelled() {
  return isCancelled;
}

/**
 * Cancel (or un-cancel) the current execution.
 * Also resets the animation flag so the render loop stops.
 *
 * @param {boolean} [value=true]
 */
export function cancelNow(value = true) {
  isCancelled = value;
  isAnimation = false;
}

/**
 * Tell the runtime whether it is running inside Safari.
 *
 * @param {boolean} value
 */
export function setIsSafari(value) {
  isSafari = value;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Fill the buffer canvas with a solid background color.
 * Resets the transform temporarily so the clear covers the full physical
 * canvas regardless of the DPR scale transform.
 *
 * @param {string} [color='#0a0f1f']
 */
function clearCanvas(color = '#0a0f1f') {
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  ctx.restore();

  ctx.save(); ctx.fillStyle = color;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.restore();
}

/** CSS color strings for packed 0xRRGGBBAA colors, so each color is formatted once. */
const colorStrings = new Map();

/**
 * Convert a packed 0xRRGGBBAA color to a CSS `#rrggbbaa` string.
 *
 * @param {number} packed
 * @returns {string}
 */
export function colorToCss(packed) {
  let css = colorStrings.get(packed);
  if (css === undefined) {
    css = '#' + (packed >>> 0).toString(16).padStart(8, '0');
    colorStrings.set(packed, css);
  }
  return css;
}

// ---------------------------------------------------------------------------
// Command executor
// ---------------------------------------------------------------------------

/**
 * Opcodes of the drawing buffer produced by the WASM runtime.
 * Keep in sync with `op` in quanta-lang/src/utils/canvas.rs.
 */
export const OP = Object.freeze({
  CLEAR: 1,      // –
  ANIMATE: 2,    // –
  CIRCLE: 3,     // x, y, radius
  RECTANGLE: 4,  // x1, y1, x2, y2
  LINE: 5,       // x1, y1, x2, y2
  ARC: 6,        // x, y, radius, start°, end°
  POLYGON: 7,    // n, then n coordinates x1, y1, x2, y2, …
  STYLE: 8,      // fill 0xRRGGBBAA, stroke 0xRRGGBBAA, line width
  PRINT: 9,      // index into `strings`
});

/**
 * Whether the running program has entered animation mode (`animate()`).
 *
 * @returns {boolean}
 */
export function isAnimationMode() {
  return isAnimation;
}

/**
 * Execute a buffer of drawing operations on the buffer canvas, then
 * composite to the visible canvas when appropriate.
 *
 * Shapes are filled with the current fill color and outlined with the
 * current stroke color; lines are only stroked. Styles persist until the
 * next `STYLE` operation within the same call.
 *
 * In animation mode (after an `ANIMATE` operation) the result is only shown
 * when `present` is true, i.e. once per `frame()`.
 *
 * @param {ArrayLike<number>} ops     - Opcodes followed by their arguments (see `OP`).
 * @param {string[]}          strings - Messages referenced by `PRINT` operations.
 * @param {boolean} [present=false]   - Show the result even in animation mode.
 */
export function drawCommands(ops, strings, present = false) {
  if (isCancelled) { return; }
  ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round';

  let i = 0;
  while (i < ops.length) {
    switch (ops[i]) {
      case OP.CLEAR:
        clearCanvas();
        i += 1;
        break;
      case OP.ANIMATE:
        isAnimation = true;
        i += 1;
        break;
      case OP.STYLE:
        ctx.fillStyle = colorToCss(ops[i + 1]);
        ctx.strokeStyle = colorToCss(ops[i + 2]);
        ctx.lineWidth = ops[i + 3];
        i += 4;
        break;
      case OP.CIRCLE:
        ctx.beginPath();
        ctx.arc(ops[i + 1], ops[i + 2], ops[i + 3], 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        i += 4;
        break;
      case OP.RECTANGLE: {
        const x = ops[i + 1], y = ops[i + 2], w = ops[i + 3] - x, h = ops[i + 4] - y;
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);
        i += 5;
        break;
      }
      case OP.LINE:
        ctx.beginPath();
        ctx.moveTo(ops[i + 1], ops[i + 2]);
        ctx.lineTo(ops[i + 3], ops[i + 4]);
        ctx.stroke();
        i += 5;
        break;
      case OP.ARC:
        ctx.beginPath();
        ctx.arc(ops[i + 1], ops[i + 2], ops[i + 3], deg2rad(ops[i + 4]), deg2rad(ops[i + 5]));
        ctx.fill();
        ctx.stroke();
        i += 6;
        break;
      case OP.POLYGON: {
        const n = ops[i + 1];
        const first = i + 2;
        ctx.beginPath();
        ctx.moveTo(ops[first], ops[first + 1]);
        for (let p = first + 2; p < first + n; p += 2) {
          ctx.lineTo(ops[p], ops[p + 1]);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        i += 2 + n;
        break;
      }
      case OP.PRINT:
        console.log('Print:' + strings[ops[i + 1]]);
        i += 2;
        break;
      default:
        console.warn('Unknown drawing operation', ops[i], 'at', i);
        i = ops.length;
    }
  }

  ctx.restore();

  // Composite the buffer onto the visible canvas.
  // In animation mode, only do this when explicitly requested (i.e. per-frame).
  if (!isAnimation || present) {
    drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    drawCtx.drawImage(bufferCanvas, 0, 0);
    if (isSafari) {
      drawCanvas.getContext('2d').getImageData(0, 0, 1, 1); // Force repaint
    }
  }
}

// ---------------------------------------------------------------------------
// Resize handling
// ---------------------------------------------------------------------------

/**
 * Synchronise the internal canvas resolutions to the element's current
 * CSS size × device pixel ratio.
 *
 * Should be called on window `resize` events so the buffer and visible canvas
 * stay in sync with layout changes.
 */
export function resizeCanvases() {
  const rect = drawCanvas.getBoundingClientRect();
  const dpr  = window.devicePixelRatio || 1;

  // Match canvas internal size to actual visible size * device pixel ratio.
  const width  = Math.floor(rect.width  * dpr);
  const height = Math.floor(rect.height * dpr);

  if (drawCanvas.width !== width || drawCanvas.height !== height) {
    drawCanvas.width    = width;
    drawCanvas.height   = height;
    bufferCanvas.width  = width;
    bufferCanvas.height = height;
  }
}
