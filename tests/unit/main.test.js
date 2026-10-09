/**
 * Tests for the utility functions and event handlers in web/main.js.
 *
 * Strategy
 * --------
 * • The WASM compiler is mocked (it cannot run in Node/jsdom).
 * • canvas-runtime is mocked so we can spy on calls like `setup` and `cancelNow`.
 * • All required DOM elements (runBtn, editor, resizer, …) are pre-created
 *   in tests/setup.js, which runs before the module is imported.
 * • Exported utilities (fontSizeTheme, downloadFile, reportError,
 *   reportMessage, showError, showOk) are imported and tested directly.
 * • DOM event handlers are exercised by dispatching events on the real elements.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { diagnosticCount, forEachDiagnostic } from '@codemirror/lint';

// ---------------------------------------------------------------------------
// Module mocks – Vitest hoists these before any imports.
// ---------------------------------------------------------------------------

const mockRuntime = vi.hoisted(() => ({
  set_renderer: vi.fn(),
  execute: vi.fn(() => Promise.resolve()),
  stop: vi.fn(),
  execute_key: vi.fn(),
  execute_mouse: vi.fn(),
  set_error_handler: vi.fn(),
  set_input_handler: vi.fn(),
  get_runtime_error: vi.fn(() => ({ error_code: 0 })),
}));

const mockRecorder = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  present: vi.fn(),
  setWaitingForUser: vi.fn(),
  canSave: vi.fn(() => false),
  save: vi.fn(),
  stats: vi.fn(),
  options: null,
}));

vi.mock('../../web/gif/recorder.js', () => ({
  createRecorder: vi.fn((options) => {
    mockRecorder.options = options;
    return mockRecorder;
  }),
}));

vi.mock('../../quanta-lang/pkg/quanta_lang.js', () => {
  return {
    default: vi.fn().mockResolvedValue(undefined), // initWasm
    Compiler: {
      new: vi.fn(() => ({
        check_code: vi.fn().mockResolvedValue({ error_code: 0, get_errors: () => [] }),
        compile_code: vi.fn().mockResolvedValue({
          error_code: 0,
          get_error: vi.fn(),
          get_runtime: vi.fn(() => mockRuntime),
        }),
      })),
    },
  };
});

vi.mock('../../web/canvas-runtime.js', () => ({
  drawCommands: vi.fn(),
  isAnimationMode: vi.fn(() => false),
  setup: vi.fn(),
  checkIsCancelled: vi.fn(() => false),
  cancelNow: vi.fn(),
  setIsSafari: vi.fn(),
  setPrintHandler: vi.fn(),
  setPresentHandler: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import {
  fontSizeTheme,
  downloadFile,
  reportError,
  reportMessage,
  showError,
  showErrors,
  verifySource,
  showOk,
} from '../../web/main.js';

import { setup, cancelNow, drawCommands, isAnimationMode, setPrintHandler, setPresentHandler } from '../../web/canvas-runtime.js';
import { setLanguage } from '../../web/i18n.js';

/** The print() handler main.js registered on load (captured before mocks are cleared). */
const printHandler = setPrintHandler.mock.calls[0]?.[0];

/** The present handler main.js registered on load. */
const presentHandler = setPresentHandler.mock.calls[0]?.[0];

/** Text of each console line, once pending lines are drawn. */
beforeEach(() => setLanguage('en'));

async function consoleText() {
  await Promise.resolve();
  return [...document.getElementById('consoleLines').children].map(li => li.textContent);
}

// ============================================================
// fontSizeTheme
// ============================================================

describe('fontSizeTheme', () => {
  it('returns a truthy CodeMirror extension', () => {
    expect(fontSizeTheme(16)).toBeTruthy();
  });

  it('returns an object', () => {
    expect(typeof fontSizeTheme(18)).toBe('object');
  });

  it('returns a distinct value for each call', () => {
    // EditorView.theme() creates a new StyleModule each time
    expect(fontSizeTheme(14)).not.toBe(fontSizeTheme(20));
  });

  it('does not throw for minimum-sized fonts', () => {
    expect(() => fontSizeTheme(1)).not.toThrow();
  });

  it('does not throw for large fonts', () => {
    expect(() => fontSizeTheme(72)).not.toThrow();
  });
});

// ============================================================
// downloadFile
// ============================================================

describe('downloadFile', () => {
  let capturedAnchor;

  beforeEach(() => {
    capturedAnchor = undefined;
    global.URL.createObjectURL = vi.fn(() => 'blob:fake-url');
    global.URL.revokeObjectURL = vi.fn();

    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = origCreate(tag);
      if (tag === 'a') {
        capturedAnchor = el;
        el.click = vi.fn();
      }
      return el;
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('calls URL.createObjectURL with a Blob', () => {
    downloadFile('test.txt', 'hello world');
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
  });

  it('creates a plain-text Blob', () => {
    downloadFile('test.txt', 'hello');
    const blob = URL.createObjectURL.mock.calls[0][0];
    expect(blob.type).toBe('text/plain');
  });

  it('sets the anchor href to the object URL', () => {
    downloadFile('file.txt', 'data');
    expect(capturedAnchor.href).toBe('blob:fake-url');
  });

  it('sets the correct download filename', () => {
    downloadFile('program.quanta', 'code');
    expect(capturedAnchor.download).toBe('program.quanta');
  });

  it('triggers a click on the anchor element', () => {
    downloadFile('file.txt', 'content');
    expect(capturedAnchor.click).toHaveBeenCalled();
  });

  it('revokes the object URL after clicking', () => {
    downloadFile('file.txt', 'content');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake-url');
  });
});

// ============================================================
// reportError / reportMessage
// ============================================================

describe('reportError', () => {
  const makeErr = (msg = 'bad token', sr = 2, sc = 4, er = 2, ec = 9) => ({
    error_code: 4,
    start_row: sr,
    start_column: sc,
    end_row: er,
    end_column: ec,
    get_error_message: () => msg,
  });

  beforeEach(() => document.getElementById('consoleClear').click());

  it('shows the line, kind and message in the console', async () => {
    reportError(makeErr('Division by 0', 5, 12, 5, 15));
    const [line] = await consoleText();
    expect(line).toContain('Line 5');
    expect(line).toContain('Runtime error: Division by 0');
  });

  it('does not open a native alert', () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    reportError(makeErr());
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it('reportMessage shows text without a line', async () => {
    reportMessage('boom');
    const [line] = await consoleText();
    expect(line).toContain('Error: boom');
    expect(document.querySelector('.console__loc')).toBeNull();
  });

  it('the Clear button empties the console', async () => {
    reportMessage('boom');
    document.getElementById('consoleClear').click();
    expect(await consoleText()).toEqual([]);
  });
});

// ============================================================
// showError
// ============================================================

describe('showError', () => {
  it('calls editor.dispatch once', () => {
    const state = EditorState.create({ doc: 'hello\nworld\n' });
    const dispatchSpy = vi.fn();
    const err = {
      start_row: 1,
      start_column: 1,
      end_row: 1,
      end_column: 4,
      get_error_message: () => 'test',
    };
    showError({ state, dispatch: dispatchSpy }, err);
    expect(dispatchSpy).toHaveBeenCalledOnce();
  });

  it('clamps column to line boundaries when column exceeds line length', () => {
    // "hi\n" = line 1 from:0, to:2  →  column 999 should be clamped to 2
    const state = EditorState.create({ doc: 'hi\nbye\n' });
    const dispatchSpy = vi.fn();
    const err = {
      start_row: 1,
      start_column: 999,
      end_row: 1,
      end_column: 999,
      get_error_message: () => 'overflow',
    };
    expect(() => showError({ state, dispatch: dispatchSpy }, err)).not.toThrow();
    expect(dispatchSpy).toHaveBeenCalledOnce();
  });

  it('handles start_row = 0 (below minimum) without throwing', () => {
    const state = EditorState.create({ doc: 'code' });
    const dispatchSpy = vi.fn();
    const err = {
      start_row: 0,
      start_column: 0,
      end_row: 0,
      end_column: 2,
      get_error_message: () => 'zero row',
    };
    expect(() => showError({ state, dispatch: dispatchSpy }, err)).not.toThrow();
  });
});

// ============================================================
// showOk
// ============================================================

describe('showOk', () => {
  it('calls editor.dispatch once', () => {
    const state = EditorState.create({ doc: 'code' });
    const dispatchSpy = vi.fn();
    showOk({ state, dispatch: dispatchSpy });
    expect(dispatchSpy).toHaveBeenCalledOnce();
  });

  it('does not throw on an empty document', () => {
    const state = EditorState.create({ doc: '' });
    const dispatchSpy = vi.fn();
    expect(() => showOk({ state, dispatch: dispatchSpy })).not.toThrow();
  });
});

// ============================================================
// downloadBtn click handler
// ============================================================

describe('downloadBtn – click handler', () => {
  afterEach(() => vi.restoreAllMocks());

  it('calls window.prompt to ask for a filename', () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue(null);
    document.getElementById('downloadBtn').click();
    expect(promptSpy).toHaveBeenCalled();
  });

  it('does not create a download when prompt is cancelled', () => {
    vi.spyOn(window, 'prompt').mockReturnValue(null);
    global.URL.createObjectURL = vi.fn();
    document.getElementById('downloadBtn').click();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('appends .quanta to a bare filename', () => {
    vi.spyOn(window, 'prompt').mockReturnValue('myprogram');
    global.URL.createObjectURL = vi.fn(() => 'blob:u');
    global.URL.revokeObjectURL = vi.fn();
    let captured = null;
    const orig = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = orig(tag);
      if (tag === 'a') { captured = el; el.click = vi.fn(); }
      return el;
    });
    document.getElementById('downloadBtn').click();
    expect(captured.download).toBe('myprogram.quanta');
  });

  it('preserves an existing .quanta extension', () => {
    vi.spyOn(window, 'prompt').mockReturnValue('code.quanta');
    global.URL.createObjectURL = vi.fn(() => 'blob:u');
    global.URL.revokeObjectURL = vi.fn();
    let captured = null;
    const orig = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = orig(tag);
      if (tag === 'a') { captured = el; el.click = vi.fn(); }
      return el;
    });
    document.getElementById('downloadBtn').click();
    expect(captured.download).toBe('code.quanta');
  });

  it('triggers a download click when a name is provided', () => {
    vi.spyOn(window, 'prompt').mockReturnValue('prog');
    global.URL.createObjectURL = vi.fn(() => 'blob:u');
    global.URL.revokeObjectURL = vi.fn();
    let anchorClicked = false;
    const orig = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = orig(tag);
      if (tag === 'a') el.click = vi.fn(() => { anchorClicked = true; });
      return el;
    });
    document.getElementById('downloadBtn').click();
    expect(anchorClicked).toBe(true);
  });
});

// ============================================================
// loadBtn click handler
// ============================================================

describe('loadBtn – click handler', () => {
  it('triggers a click on the hidden file input', () => {
    const fileInput = document.getElementById('fileInput');
    const clickSpy = vi.spyOn(fileInput, 'click').mockImplementation(() => {});
    document.getElementById('loadBtn').click();
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });
});

// ============================================================
// saveBtn click handler
// ============================================================

describe('saveBtn – click handler', () => {
  afterEach(() => vi.restoreAllMocks());

  it('calls canvas.toDataURL with JPEG format and 0.95 quality', () => {
    vi.spyOn(window, 'prompt').mockReturnValue('painting');
    const canvasEl = document.getElementById('canvas');
    const toDataURLSpy = vi.spyOn(canvasEl, 'toDataURL').mockReturnValue(
      'data:image/jpeg;base64,',
    );
    const orig = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = orig(tag);
      if (tag === 'a') el.click = vi.fn();
      return el;
    });
    document.getElementById('saveBtn').click();
    expect(toDataURLSpy).toHaveBeenCalledWith('image/jpeg', 0.95);
  });

  it('appends .jpg to the chosen filename', () => {
    vi.spyOn(window, 'prompt').mockReturnValue('myart');
    const canvasEl = document.getElementById('canvas');
    vi.spyOn(canvasEl, 'toDataURL').mockReturnValue(
      'data:image/jpeg;base64,x',
    );
    let captured = null;
    const orig = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = orig(tag);
      if (tag === 'a') { captured = el; el.click = vi.fn(); }
      return el;
    });
    document.getElementById('saveBtn').click();
    expect(captured.download).toBe('myart.jpg');
  });

  it('aborts without triggering a download when prompt is cancelled', () => {
    vi.spyOn(window, 'prompt').mockReturnValue(null);
    const canvasEl = document.getElementById('canvas');
    vi.spyOn(canvasEl, 'toDataURL').mockReturnValue('data:image/jpeg;base64,');
    let anchorClicked = false;
    const orig = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = orig(tag);
      if (tag === 'a') el.click = vi.fn(() => { anchorClicked = true; });
      return el;
    });
    document.getElementById('saveBtn').click();
    expect(anchorClicked).toBe(false);
  });
});

// ============================================================
// Pane resizer
// ============================================================

describe('Pane resizer', () => {
  let panesEl;

  beforeEach(() => {
    panesEl = document.querySelector('.panes');
    vi.spyOn(panesEl, 'getBoundingClientRect').mockReturnValue({
      width: 1000,
      top: 0,
      left: 0,
      right: 1000,
      bottom: 600,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Reset drag state so tests stay independent.
    window.dispatchEvent(new MouseEvent('mouseup'));
    panesEl.style.gridTemplateColumns = '';
  });

  it('updates gridTemplateColumns while dragging', () => {
    document.getElementById('resizer').dispatchEvent(
      new MouseEvent('mousedown'),
    );
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 400 }));
    // leftWidth=400, rightWidth=1000-400-4=596
    expect(panesEl.style.gridTemplateColumns).toBe('400px 4px 596px');
  });

  it('computes the right-pane width as totalWidth − leftWidth − 4', () => {
    document.getElementById('resizer').dispatchEvent(
      new MouseEvent('mousedown'),
    );
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 200 }));
    expect(panesEl.style.gridTemplateColumns).toBe('200px 4px 796px');
  });

  it('does not update gridTemplateColumns before dragging starts', () => {
    panesEl.style.gridTemplateColumns = 'initial';
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 400 }));
    expect(panesEl.style.gridTemplateColumns).toBe('initial');
  });

  it('stops updating after mouseup', () => {
    document.getElementById('resizer').dispatchEvent(
      new MouseEvent('mousedown'),
    );
    window.dispatchEvent(new MouseEvent('mouseup'));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 400 }));
    // gridTemplateColumns should not have been updated after mouseup
    expect(panesEl.style.gridTemplateColumns).toBe('');
  });

  it('resets the document cursor on mouseup', () => {
    document.getElementById('resizer').dispatchEvent(
      new MouseEvent('mousedown'),
    );
    expect(document.body.style.cursor).toBe('col-resize');
    window.dispatchEvent(new MouseEvent('mouseup'));
    expect(document.body.style.cursor).toBe('');
  });
});

// ============================================================
// runBtn click handler
// ============================================================

describe('runBtn – click handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('preserves the icon and updates the tooltip through Run, Stop and language changes', async () => {
    const button = document.getElementById('runBtn');
    const previousMarkup = button.innerHTML;
    const previousKey = button.getAttribute('data-i18n');
    const previousTitleKey = button.getAttribute('data-i18n-title');
    const previousTitle = button.getAttribute('title');
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const label = document.createElement('span');
    label.dataset.i18n = 'run';
    label.textContent = 'Run';
    button.removeAttribute('data-i18n');
    button.dataset.i18nTitle = 'run';
    button.title = 'Run';
    button.replaceChildren(icon, label);
    mockRuntime.execute.mockReturnValueOnce(new Promise(() => {}));

    try {
      button.click();
      await vi.waitFor(() => expect(button.textContent).toBe('Stop'));
      expect(button.contains(icon)).toBe(true);
      expect(button.title).toBe('Stop');
      setLanguage('uk');
      expect(button.textContent).toBe('Зупинити');
      expect(button.title).toBe('Зупинити');
      expect(button.contains(icon)).toBe(true);
      button.click();
      expect(button.textContent).toBe('Запустити');
      expect(button.title).toBe('Запустити');
      expect(button.contains(icon)).toBe(true);
    } finally {
      if (button.dataset.state === 'stop') button.click();
      button.innerHTML = previousMarkup;
      if (previousKey === null) button.removeAttribute('data-i18n');
      else button.setAttribute('data-i18n', previousKey);
      if (previousTitleKey === null) button.removeAttribute('data-i18n-title');
      else button.setAttribute('data-i18n-title', previousTitleKey);
      if (previousTitle === null) button.removeAttribute('title');
      else button.setAttribute('title', previousTitle);
      setLanguage('en');
    }
  });

  it('calls cancelNow(false) at the start of a run', async () => {
    document.getElementById('runBtn').click();
    await vi.waitFor(
      () => expect(cancelNow).toHaveBeenCalledWith(false),
      { timeout: 2000 },
    );
  });

  it('calls setup() on the canvas runtime', async () => {
    document.getElementById('runBtn').click();
    await vi.waitFor(
      () => expect(setup).toHaveBeenCalled(),
      { timeout: 2000 },
    );
  });

  it('gives the runtime a renderer that forwards to drawCommands', async () => {
    document.getElementById('runBtn').click();
    await vi.waitFor(() => expect(mockRuntime.execute).toHaveBeenCalled(), { timeout: 2000 });

    const renderer = mockRuntime.set_renderer.mock.calls[0][0];
    const ops = new Float64Array([3, 1, 2, 3]);
    renderer(ops, ['msg'], true);
    expect(drawCommands).toHaveBeenCalledWith(ops, ['msg'], true);
  });

  it('shows the fps counter only for presented frames in animation mode', async () => {
    const fps = document.getElementById('fpsCounter');
    mockRuntime.execute.mockReturnValueOnce(new Promise(() => {})); // keep running
    document.getElementById('runBtn').click();
    await vi.waitFor(() => expect(mockRuntime.set_renderer).toHaveBeenCalled(), { timeout: 2000 });
    const renderer = mockRuntime.set_renderer.mock.calls.at(-1)[0];

    renderer(new Float64Array(), [], true);
    expect(fps.hidden).toBe(true); // not animating

    isAnimationMode.mockReturnValue(true);
    renderer(new Float64Array(), [], false);
    expect(fps.hidden).toBe(true); // not a presented frame

    renderer(new Float64Array(), [], true);
    expect(fps.hidden).toBe(false);

    document.getElementById('runBtn').click(); // Stop
    expect(fps.hidden).toBe(true);
    isAnimationMode.mockReturnValue(false);
  });

  it('shows the runtime error in the console once the program finishes with one', async () => {
    mockRuntime.get_runtime_error.mockReturnValueOnce({
      error_code: 4,
      start_row: 1, start_column: 0, end_row: 1, end_column: 1,
      get_error_message: () => 'Division by 0',
    });

    document.getElementById('runBtn').click();
    await vi.waitFor(
      async () => expect((await consoleText()).at(-1)).toContain('Line 1Runtime error: Division by 0'),
      { timeout: 2000 },
    );
  });

  it('notes the start and the duration of a run that finishes', async () => {
    document.getElementById('runBtn').click();
    await vi.waitFor(
      async () => expect((await consoleText()).at(-1)).toMatch(/Finished in \d+ ms$/),
      { timeout: 2000 },
    );
    expect((await consoleText())[0]).toContain('Program started');
  });

  it('sends print() output to the console', async () => {
    expect(printHandler).toBeTypeOf('function');
    document.getElementById('consoleClear').click();
    printHandler('hello');
    printHandler('hello');
    const [line] = await consoleText();
    expect(line).toContain('hello');
    expect(line).toContain('×2');
  });

  it('clears the previous output when the program is run again', async () => {
    reportMessage('old');
    document.getElementById('runBtn').click();
    await vi.waitFor(() => expect(setup).toHaveBeenCalled(), { timeout: 2000 });
    expect((await consoleText()).join()).not.toContain('old');
  });

  it('moves the cursor to the error when its line is clicked', async () => {
    document.getElementById('consoleClear').click();
    reportError({
      error_code: 2,
      start_row: 2, start_column: 3, end_row: 2, end_column: 4,
      get_error_message: () => 'oops',
    });
    await consoleText();
    document.querySelector('.console__loc').click();
    const view = EditorView.findFromDOM(document.getElementById('editor'));
    const head = view.state.selection.main.head;
    expect(view.state.doc.lineAt(head).number).toBe(2);
    expect(head - view.state.doc.line(2).from).toBe(2);
  });

  it('stops the program and shows the error when an event handler fails', async () => {
    const runBtn = document.getElementById('runBtn');
    mockRuntime.execute.mockReturnValueOnce(new Promise(() => {})); // keeps running
    runBtn.click();
    await vi.waitFor(() => expect(runBtn.dataset.state).toBe('stop'), { timeout: 2000 });

    const onError = mockRuntime.set_error_handler.mock.calls.at(-1)[0];
    onError({
      error_code: 4,
      start_row: 3, start_column: 0, end_row: 3, end_column: 1,
      get_error_message: () => 'Division by 0',
    });

    expect(mockRuntime.stop).toHaveBeenCalled();
    expect(runBtn.dataset.state).toBe('run');
    const lines = await consoleText();
    expect(lines.at(-1)).toContain('Division by 0');
    expect(lines.join()).not.toContain('Stopped');
  });

  it('reports and stops a handler error after the source is shortened', async () => {
    const runBtn = document.getElementById('runBtn');
    const view = EditorView.findFromDOM(document.getElementById('editor'));
    const original = view.state.doc.toString();
    try {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length,
        insert: 'func mouse(int x, int y) {\n int z = 1 / 0;\n}\nfunc main() { while (true) {} }' } });
      mockRuntime.execute.mockReturnValueOnce(new Promise(() => {}));
      runBtn.click();
      await vi.waitFor(() => expect(runBtn.dataset.state).toBe('stop'));
      const onError = mockRuntime.set_error_handler.mock.calls.at(-1)[0];
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'print(1);' } });
      expect(() => onError({
        error_code: 4, start_row: 2, start_column: 4, end_row: 2, end_column: 18,
        get_error_message: () => 'Division by 0',
      })).not.toThrow();
      expect(mockRuntime.stop).toHaveBeenCalled();
      expect(runBtn.dataset.state).toBe('run');
      expect((await consoleText()).at(-1)).toContain('Line 2Runtime error: Division by 0');
      expect(diagnosticCount(view.state)).toBe(0);
      expect(() => setLanguage('uk')).not.toThrow();
    } finally {
      setLanguage('en');
      if (runBtn.dataset.state === 'stop') runBtn.click();
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: original } });
    }
  });

  it('reports and stops even when highlighting an event error fails', async () => {
    const runBtn = document.getElementById('runBtn');
    const view = EditorView.findFromDOM(document.getElementById('editor'));
    mockRuntime.execute.mockReturnValueOnce(new Promise(() => {}));
    runBtn.click();
    await vi.waitFor(() => expect(runBtn.dataset.state).toBe('stop'));
    const onError = mockRuntime.set_error_handler.mock.calls.at(-1)[0];
    const spy = vi.spyOn(view, 'dispatch').mockImplementationOnce(() => {
      throw new Error('highlight failed');
    });
    try {
      expect(() => onError({
        error_code: 4, start_row: 1, start_column: 0, end_row: 1, end_column: 1,
        get_error_message: () => 'Division by 0',
      })).toThrow('highlight failed');
      expect(mockRuntime.stop).toHaveBeenCalled();
      expect(runBtn.dataset.state).toBe('run');
      expect((await consoleText()).at(-1)).toContain('Division by 0');
    } finally {
      spy.mockRestore();
      if (runBtn.dataset.state === 'stop') runBtn.click();
    }
  });

  it('stops the runtime and restores the Run button when Stop is clicked', async () => {
    const runBtn = document.getElementById('runBtn');
    mockRuntime.execute.mockReturnValueOnce(new Promise(() => {})); // never finishes

    runBtn.click();
    await vi.waitFor(() => expect(runBtn.dataset.state).toBe('stop'), { timeout: 2000 });

    runBtn.click();
    expect(mockRuntime.stop).toHaveBeenCalled();
    expect(cancelNow).toHaveBeenCalledWith();
    expect(runBtn.dataset.state).toBe('run');
    expect((await consoleText()).at(-1)).toContain('Stopped');
  });
});

// ============================================================
// Language switch
// ============================================================

describe('console controls', () => {
  it('keeps hidden output and errors indicated until the console is opened', async () => {
    const toggle = document.getElementById('consoleToggle');
    toggle.click();
    try {
      printHandler('hidden output');
      expect(toggle.dataset.activity).toBe('print');
      reportError({
        error_code: 4, start_row: 1, start_column: 0, end_row: 1, end_column: 1,
        get_error_message: () => 'Division by 0',
      });
      setLanguage('uk');
      expect(toggle.dataset.activity).toBe('error');
      expect(toggle.getAttribute('aria-label')).toContain('нові помилки');
      expect(document.getElementById('consoleLines').hidden).toBe(true);
      toggle.click();
      expect(toggle.dataset.activity).toBe('');
      expect(document.getElementById('consoleLines').hidden).toBe(false);
      expect((await consoleText()).join()).toContain('hidden output');
      expect((await consoleText()).join()).toContain('Ділення на 0');
    } finally {
      if (toggle.getAttribute('aria-expanded') === 'false') toggle.click();
      setLanguage('en');
    }
  });
});

describe('keyboard forwarding', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends the physical key on a Ukrainian layout', async () => {
    const runBtn = document.getElementById('runBtn');
    mockRuntime.execute.mockReturnValueOnce(new Promise(() => {}));
    runBtn.click();
    await vi.waitFor(() => expect(runBtn.dataset.state).toBe('stop'));
    try {
      const canvas = document.getElementById('canvas');
      canvas.tabIndex = 0; // focusable, as in index.html
      canvas.focus();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ф', code: 'KeyA' }));
      expect(mockRuntime.execute_key).toHaveBeenCalledWith('a');
    } finally {
      if (runBtn.dataset.state === 'stop') runBtn.click();
    }
  });
});

describe('shareBtn', () => {
  afterEach(() => vi.useRealTimers());

  it('shows the copied state for two seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const writeText = vi.fn().mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const button = document.getElementById('shareBtn');

    button.click();
    await vi.waitFor(() => expect(button.dataset.state).toBe('copied'));
    expect(writeText).toHaveBeenCalledOnce();
    expect(button.textContent).toBe('Link copied');

    vi.advanceTimersByTime(2000);
    expect(button.dataset.state).toBeUndefined();
    expect(button.textContent).toBe('Share');
  });
});

describe('language switch', () => {
  afterEach(() => setLanguage('en'));

  it('translates the buttons, the console and errors to Ukrainian', async () => {
    const runBtn = document.getElementById('runBtn');
    document.getElementById('consoleClear').click();
    reportError({
      error_code: 4,
      start_row: 1, start_column: 0, end_row: 1, end_column: 1,
      get_error_message: () => 'Division by 0',
    });
    await consoleText();

    document.querySelector('[data-lang="uk"]').click();

    expect(runBtn.textContent).toBe('Запустити');
    expect(document.documentElement.lang).toBe('uk');
    expect(document.querySelector('[data-lang="uk"]').getAttribute('aria-pressed')).toBe('true');
    expect((await consoleText())[0]).toContain('Рядок 1');
    expect((await consoleText())[0]).toContain('Помилка виконання: Ділення на 0');
  });

  it('remembers the choice', () => {
    setLanguage('uk');
    expect(localStorage.getItem('quanta-language')).toBe('uk');
  });
});


function diagnosticsOf(state) {
  const errors = [];
  forEachDiagnostic(state, (error, from, to) => errors.push({ message: error.message, from, to }));
  return errors;
}
function errorAt(row, start, end, message = 'Division by 0') {
  return { error_code: 3, start_row: row, start_column: start, end_row: row, end_column: end, get_error_message: () => message };
}

describe('batch diagnostics', () => {
  it('marks every error in one update at exact 1-based source coordinates', () => {
    let state = EditorState.create({ doc: 'bad();\nwrong();' });
    let updates = 0;
    const view = { get state() { return state; }, dispatch(spec) { updates++; state = state.update(spec).state; } };
    showErrors(view, [errorAt(1, 1, 4), errorAt(2, 1, 6)]);
    expect(updates).toBe(1);
    expect(diagnosticsOf(state).map(({ from, to }) => [from, to])).toEqual([[0, 3], [7, 12]]);
  });

  it('maps Unicode scalar columns to UTF-16 without splitting emoji', () => {
    let state = EditorState.create({ doc: 'print("😀ї"); wrong();' });
    const view = { get state() { return state; }, dispatch(spec) { state = state.update(spec).state; } };
    showErrors(view, [errorAt(1, 14, 19)]);
    const [{ from, to }] = diagnosticsOf(state);
    expect(state.doc.sliceString(from, to)).toBe('wrong');
  });

  it('keeps valid errors when another location belongs to an older longer source', () => {
    let state = EditorState.create({ doc: 'bad();' });
    const view = { get state() { return state; }, dispatch(spec) { state = state.update(spec).state; } };
    showErrors(view, [errorAt(20, 1, 5), errorAt(1, 1, 4)]);
    expect(diagnosticsOf(state).map(({ from, to }) => [from, to])).toEqual([[0, 3]]);
  });

  it('shows all Run verification errors in the problem list and console', async () => {
    const { Compiler } = await import('../../quanta-lang/pkg/quanta_lang.js');
    const errors = [errorAt(1, 1, 4), errorAt(2, 1, 4)];
    Compiler.new.mockReturnValueOnce({ compile_code: async () => ({ error_code: 3, get_errors: () => errors }) });
    const view = EditorView.findFromDOM(document.getElementById('editor'));
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'bad();\nwrong();' } });
    document.getElementById('runBtn').click();
    await vi.waitFor(() => expect(diagnosticCount(view.state)).toBe(2));
    expect((await consoleText()).filter(text => text.includes('Division by 0'))).toHaveLength(2);
    expect(document.querySelector('.cm-panel-lint')).toBeNull();
    expect(document.getElementById('runBtn').dataset.state).toBe('run');
  });

  it('shows background check errors in the console, replacing the previous check', async () => {
    const { Compiler } = await import('../../quanta-lang/pkg/quanta_lang.js');
    const view = EditorView.findFromDOM(document.getElementById('editor'));
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'bad();\nwrong();' } });
    document.getElementById('consoleClear').click();
    Compiler.new.mockReturnValueOnce({ check_code: async () => ({ error_code: 3, get_errors: () => [errorAt(1, 1, 4, 'First'), errorAt(2, 1, 6, 'Second')] }) });
    await verifySource(view, view.state.doc.toString());
    expect(await consoleText()).toEqual(['Line 1Type error: First', 'Line 2Type error: Second']);
    expect(document.querySelector('.cm-panel-lint')).toBeNull();
    Compiler.new.mockReturnValueOnce({ check_code: async () => ({ error_code: 3, get_errors: () => [errorAt(2, 1, 6, 'Second')] }) });
    await verifySource(view, view.state.doc.toString());
    expect(await consoleText()).toEqual(['Line 2Type error: Second']);
    Compiler.new.mockReturnValueOnce({ check_code: async () => ({ error_code: 0, get_errors: () => [] }) });
    await verifySource(view, view.state.doc.toString());
    expect(await consoleText()).toEqual([]);
  });

  it('replaces Run verification errors with the next background check', async () => {
    const { Compiler } = await import('../../quanta-lang/pkg/quanta_lang.js');
    const view = EditorView.findFromDOM(document.getElementById('editor'));
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'bad();\nwrong();' } });
    Compiler.new.mockReturnValueOnce({ compile_code: async () => ({ error_code: 3, get_errors: () => [errorAt(1, 1, 4, 'Old')] }) });
    document.getElementById('runBtn').click();
    await vi.waitFor(async () => expect(await consoleText()).toEqual(['Line 1Type error: Old']));
    Compiler.new.mockReturnValueOnce({ check_code: async () => ({ error_code: 3, get_errors: () => [errorAt(2, 1, 6, 'New')] }) });
    await verifySource(view, view.state.doc.toString());
    expect(await consoleText()).toEqual(['Line 2Type error: New']);
  });

  it('retains runtime error marks when a background check finishes later', async () => {
    const { Compiler } = await import('../../quanta-lang/pkg/quanta_lang.js');
    const view = EditorView.findFromDOM(document.getElementById('editor'));
    let resolve;
    Compiler.new.mockReturnValueOnce({ check_code: () => new Promise(done => { resolve = done; }) });
    const verification = verifySource(view, view.state.doc.toString());
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    showError(view, { ...errorAt(1, 1, 4), error_code: 4 });
    resolve({ error_code: 0, get_errors: () => [] });
    await verification;
    expect(diagnosticCount(view.state)).toBe(1);
    await verifySource(view, view.state.doc.toString());
    expect(diagnosticCount(view.state)).toBe(1);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'print(1);' } });
    await verifySource(view, view.state.doc.toString());
    expect(diagnosticCount(view.state)).toBe(0);
  });

  it('clears successful background checks and ignores results after an edit', async () => {
    const { Compiler } = await import('../../quanta-lang/pkg/quanta_lang.js');
    const view = EditorView.findFromDOM(document.getElementById('editor'));
    showErrors(view, [errorAt(1, 1, 2)]);
    Compiler.new.mockReturnValueOnce({ check_code: async () => ({ error_code: 0, get_errors: () => [] }) });
    await verifySource(view, view.state.doc.toString());
    expect(diagnosticCount(view.state)).toBe(0);
    let resolve;
    const pending = new Promise(done => { resolve = done; });
    Compiler.new.mockReturnValueOnce({ check_code: () => pending });
    const verification = verifySource(view, view.state.doc.toString());
    await Promise.resolve();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'print(1);' } });
    resolve({ error_code: 3, get_errors: () => [errorAt(1, 1, 4)] });
    await verification;
    expect(diagnosticCount(view.state)).toBe(0);
  });
});


describe('runtime input UI', () => {
  function submit(value) {
    const host = document.getElementById('consoleInput');
    host.querySelector('input').value = value;
    host.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  }

  it('opens a closed console, retains input through Clear and close, and cancels on Stop', async () => {
    let finish;
    mockRuntime.execute.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    document.getElementById('runBtn').click();
    await vi.waitFor(() => expect(document.getElementById('runBtn').dataset.state).toBe('stop'));
    const toggle = document.getElementById('consoleToggle');
    if (toggle.getAttribute('aria-expanded') === 'true') toggle.click();
    const handler = mockRuntime.set_input_handler.mock.calls.at(-1)[0];
    const pending = handler('int');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const field = document.querySelector('#consoleInput input');
    field.value = '12';
    document.getElementById('consoleClear').click();
    toggle.click();
    toggle.click();
    expect(field.value).toBe('12');
    document.getElementById('runBtn').click();
    await expect(pending).resolves.toBeNull();
    expect(document.getElementById('consoleInput').hidden).toBe(true);
    finish();
    await Promise.resolve();
  });

  it('keeps Stop available for pending event input when main finishes', async () => {
    let finish;
    mockRuntime.execute.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    document.getElementById('runBtn').click();
    await vi.waitFor(() => expect(document.getElementById('runBtn').dataset.state).toBe('stop'));
    const handler = mockRuntime.set_input_handler.mock.calls.at(-1)[0];
    const pending = handler('string');
    finish();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.getElementById('runBtn').dataset.state).toBe('stop');
    submit('event');
    await expect(pending).resolves.toBe('event');
    expect(document.getElementById('runBtn').dataset.state).toBe('run');
    const later = handler('bool');
    expect(document.getElementById('runBtn').dataset.state).toBe('stop');
    document.getElementById('runBtn').click();
    await expect(later).resolves.toBeNull();
    await expect(handler('int')).resolves.toBeNull();
    expect(document.getElementById('consoleInput').hidden).toBe(true);
  });
});

describe('GIF recording', () => {
  const runBtn = () => document.getElementById('runBtn');
  const saveGifBtn = () => document.getElementById('saveGifBtn');
  const gifMeter = () => document.getElementById('gifMeter');
  const MB = 1024 * 1024;

  function submit(value) {
    const host = document.getElementById('consoleInput');
    host.querySelector('input').value = value;
    host.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  }

  /** Make the next anchor click a no-op and return a getter for that anchor. */
  function captureDownload() {
    let anchor = null;
    URL.createObjectURL = vi.fn(() => 'blob:gif');
    URL.revokeObjectURL = vi.fn();
    const create = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = create(tag);
      if (tag === 'a') { anchor = el; el.click = vi.fn(); }
      return el;
    });
    return () => anchor;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockRecorder.canSave.mockReturnValue(false);
    // Known enabled state: a disabled button would ignore the clicks below.
    mockRecorder.options.onStats({ frames: 2, lengthMs: 0, bytes: 0, limit: null });
    document.getElementById('consoleClear').click();
  });
  afterEach(() => vi.restoreAllMocks());

  it('forwards each shown picture to the recorder', () => {
    const visible = document.getElementById('canvas');
    presentHandler(visible);
    expect(mockRecorder.present).toHaveBeenCalledWith(visible);
  });

  it('starts a new recording on Run and stops capturing on Stop', async () => {
    mockRuntime.execute.mockReturnValueOnce(new Promise(() => {}));
    runBtn().click();
    await vi.waitFor(() => expect(runBtn().dataset.state).toBe('stop'));
    expect(mockRecorder.start).toHaveBeenCalledTimes(1);
    expect(mockRecorder.stop).not.toHaveBeenCalled();
    runBtn().click();
    expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
  });

  it('tells the recorder when the program waits for the user', async () => {
    let finish;
    mockRuntime.execute.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    runBtn().click();
    await vi.waitFor(() => expect(runBtn().dataset.state).toBe('stop'));
    const handler = mockRuntime.set_input_handler.mock.calls.at(-1)[0];
    const pending = handler('int');
    expect(mockRecorder.setWaitingForUser).toHaveBeenLastCalledWith(true);
    submit('5');
    await pending;
    expect(mockRecorder.setWaitingForUser).toHaveBeenLastCalledWith(false);
    finish();
    await vi.waitFor(() => expect(runBtn().dataset.state).toBe('run'));
    expect(mockRecorder.setWaitingForUser).toHaveBeenLastCalledWith(true);
  });

  it('enables Save GIF and shows the readout once two frames are recorded', () => {
    const { onStats } = mockRecorder.options;
    onStats({ frames: 1, lengthMs: 0, bytes: 100, limit: null });
    expect(saveGifBtn().disabled).toBe(true);
    expect(gifMeter().hidden).toBe(true);
    onStats({ frames: 2, lengthMs: 24_000, bytes: 3.1 * MB, limit: null });
    expect(saveGifBtn().disabled).toBe(false);
    expect(gifMeter().hidden).toBe(false);
    expect(gifMeter().textContent).toBe('GIF 0:24 · 3.1 MB');
    onStats({ frames: 0, lengthMs: 0, bytes: 0, limit: null });
    expect(saveGifBtn().disabled).toBe(true);
    expect(gifMeter().hidden).toBe(true);
  });

  it('saves the GIF under the chosen name and reports it in the console', async () => {
    mockRecorder.canSave.mockReturnValue(true);
    let finishSave;
    mockRecorder.save.mockReturnValue(new Promise(resolve => { finishSave = resolve; }));
    vi.spyOn(window, 'prompt').mockReturnValue('bounce');
    const anchor = captureDownload();

    saveGifBtn().click();
    expect(saveGifBtn().disabled).toBe(true);
    mockRecorder.options.onStats({ frames: 5, lengthMs: 1000, bytes: 1000, limit: null });
    expect(saveGifBtn().disabled).toBe(true);

    finishSave({ bytes: new Uint8Array([1, 2, 3]), lengthMs: 60_000, size: 8.4 * MB, limit: 'time' });
    await vi.waitFor(() => expect(anchor()?.download).toBe('bounce.gif'));
    expect(URL.createObjectURL.mock.calls[0][0].type).toBe('image/gif');
    expect(anchor().click).toHaveBeenCalled();
    await vi.waitFor(async () => expect((await consoleText()).at(-1)).toContain('GIF saved: first 1:00, 8.4 MB (time limit reached).'));
    expect(saveGifBtn().disabled).toBe(false);
  });

  it('ends the clip at the click, not after the name prompt', async () => {
    mockRecorder.canSave.mockReturnValue(true);
    mockRecorder.save.mockRejectedValue(new Error('stop here'));
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
    vi.spyOn(window, 'prompt').mockImplementation(() => {
      clock.mockReturnValue(9000);
      return 'slow';
    });
    saveGifBtn().click();
    expect(mockRecorder.save).toHaveBeenCalledWith(1000);
    await vi.waitFor(async () => expect((await consoleText()).at(-1)).toContain('stop here'));
  });

  it('does nothing when the name prompt is cancelled', () => {
    mockRecorder.canSave.mockReturnValue(true);
    vi.spyOn(window, 'prompt').mockReturnValue(null);
    saveGifBtn().click();
    expect(window.prompt).toHaveBeenCalled();
    expect(mockRecorder.save).not.toHaveBeenCalled();
  });

  it('does not double a .gif extension typed in any case', async () => {
    mockRecorder.canSave.mockReturnValue(true);
    mockRecorder.save.mockResolvedValue({ bytes: new Uint8Array([1]), lengthMs: 1000, size: MB, limit: null });
    vi.spyOn(window, 'prompt').mockReturnValue('Clip.GIF');
    const anchor = captureDownload();
    saveGifBtn().click();
    await vi.waitFor(() => expect(anchor()?.download).toBe('Clip.GIF'));
  });

  it('reports a failed save in the console', async () => {
    mockRecorder.canSave.mockReturnValue(true);
    mockRecorder.save.mockRejectedValue(new Error('boom'));
    vi.spyOn(window, 'prompt').mockReturnValue('broken');
    saveGifBtn().click();
    await vi.waitFor(async () => expect((await consoleText()).at(-1)).toContain('Could not save GIF: boom'));
  });
});
