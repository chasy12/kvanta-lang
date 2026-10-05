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
import { diagnosticCount } from '@codemirror/lint';

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
  get_runtime_error: vi.fn(() => ({ error_code: 0 })),
}));

vi.mock('../../quanta-lang/pkg/quanta_lang.js', () => {
  return {
    default: vi.fn().mockResolvedValue(undefined), // initWasm
    Compiler: {
      new: vi.fn(() => ({
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
  showOk,
} from '../../web/main.js';

import { setup, cancelNow, drawCommands, isAnimationMode, setPrintHandler } from '../../web/canvas-runtime.js';
import { setLanguage } from '../../web/i18n.js';

/** The print() handler main.js registered on load (captured before mocks are cleared). */
const printHandler = setPrintHandler.mock.calls[0]?.[0];

/** Text of each console line, once pending lines are drawn. */
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
    expect(head - view.state.doc.line(2).from).toBe(3);
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

    expect(runBtn.textContent).toBe('Запустити програму!');
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
