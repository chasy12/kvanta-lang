import { vi } from 'vitest';

// Populate the DOM that canvas-runtime.js queries at module load time.
const canvas = document.createElement('canvas');
canvas.id = 'canvas';
canvas.width = 1000;
canvas.height = 1000;
document.body.appendChild(canvas);

// --------------------------------------------------------------------------
// DOM elements required by web/main.js at module load time.
// --------------------------------------------------------------------------

const runBtn = document.createElement('button');
runBtn.id = 'runBtn';
document.body.appendChild(runBtn);

const editorDiv = document.createElement('div');
editorDiv.id = 'editor';
document.body.appendChild(editorDiv);

const resizer = document.createElement('div');
resizer.id = 'resizer';
document.body.appendChild(resizer);

const panesDiv = document.createElement('div');
panesDiv.className = 'panes';
document.body.appendChild(panesDiv);

const downloadBtn = document.createElement('button');
downloadBtn.id = 'downloadBtn';
document.body.appendChild(downloadBtn);

const loadBtn = document.createElement('button');
loadBtn.id = 'loadBtn';
document.body.appendChild(loadBtn);

const saveBtn = document.createElement('button');
saveBtn.id = 'saveBtn';
document.body.appendChild(saveBtn);

const shareBtn = document.createElement('button');
shareBtn.id = 'shareBtn';
document.body.appendChild(shareBtn);

const consoleLines = document.createElement('ol');
consoleLines.id = 'consoleLines';
consoleLines.dataset.i18nEmpty = 'consoleEmpty';
document.body.appendChild(consoleLines);

const consoleClear = document.createElement('button');
consoleClear.id = 'consoleClear';
document.body.appendChild(consoleClear);

for (const lang of ['en', 'uk']) {
  const button = document.createElement('button');
  button.dataset.lang = lang;
  document.body.appendChild(button);
}

const resultWrap = document.createElement('div');
resultWrap.id = 'resultWrap';
document.body.append(resultWrap);
const consolePanel = document.createElement('section');
consolePanel.id = 'consolePanel';
const consoleToggle = document.createElement('button');
consoleToggle.id = 'consoleToggle';
const consoleResize = document.createElement('div');
consoleResize.id = 'consoleResize';
resultWrap.append(consoleResize, consolePanel);
consolePanel.append(consoleToggle, consoleClear, consoleLines);
consoleLines.setAttribute('role', 'log');
const consoleInput = document.createElement('div');
consoleInput.id = 'consoleInput';
consoleInput.hidden = true;
consolePanel.append(consoleInput);

const fpsCounter = document.createElement('div');
fpsCounter.id = 'fpsCounter';
fpsCounter.hidden = true;
document.body.appendChild(fpsCounter);

const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.id = 'fileInput';
document.body.appendChild(fileInput);

// ResizeObserver stub - jsdom does not provide this API but CodeMirror 6
// checks for its existence when mounting an EditorView.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// jsdom has no layout, so Range lacks the measuring methods CodeMirror calls
// when it scrolls the cursor into view.
if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [];
  Range.prototype.getBoundingClientRect = () => ({
    width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0,
  });
}

// Mock canvas 2D context (jsdom does not implement CanvasRenderingContext2D).
function createMockCtx() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    drawImage: vi.fn(),
    setTransform: vi.fn(),
    getImageData: vi.fn(() => ({ data: [] })),
    lineJoin: '',
    lineCap: '',
    lineWidth: 1,
    strokeStyle: '',
    fillStyle: '',
  };
}

const drawCtx = createMockCtx();
let bufferCtx = null;
const contextByCanvas = new WeakMap();

/**
 * Return a stable mocked 2D context per canvas element.
 * The visible canvas (#canvas) always maps to drawCtx, while each
 * off-screen canvas gets its own context instance.
 * The first off-screen context is exposed as __mockBufferCtx.
 */
HTMLCanvasElement.prototype.getContext = function getContext() {
  if (this.id === 'canvas') return drawCtx;

  if (!contextByCanvas.has(this)) {
    const ctx = createMockCtx();
    contextByCanvas.set(this, ctx);
    if (!bufferCtx) {
      bufferCtx = ctx;
    }
  }

  return contextByCanvas.get(this);
};

HTMLCanvasElement.prototype.getBoundingClientRect = () => ({
  width: 500, height: 500, top: 0, left: 0, right: 500, bottom: 500,
});

// Expose on globalThis so drawing-commands tests can inspect calls.
globalThis.__mockDrawCtx = drawCtx;
Object.defineProperty(globalThis, '__mockBufferCtx', { get: () => bufferCtx });

