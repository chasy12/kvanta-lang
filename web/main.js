/**
 * main.js
 *
 * Entry point for the Quanta web IDE.
 *
 * Responsibilities:
 *   - Create and configure the CodeMirror 6 editor with Quanta language support.
 *   - Compile Quanta source via the Rust/WASM `Compiler` on every keystroke
 *     (debounced 1 s) and on explicit Run.
 *   - Run the program in the WASM runtime, which hands drawing commands to the
 *     canvas runtime (`canvas-runtime.js`) and paces frames itself.
 *   - Wire up keyboard and mouse events so the running program can react to input.
 *   - Show print() output, run status and errors in the console under the canvas.
 *   - Switch the interface between English and Ukrainian.
 *   - Share programs as links (`#code=...`) and load them on open.
 *   - Handle file load / save and canvas image export.
 */

// CodeMirror bits (via esm.sh, no local install needed)
//import { EditorView, lineNumbers, highlightActiveLine } from "@codemirror/view";
//import { EditorState } from "@codemirror/state";
//import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
//import { indentOnInput } from "@codemirror/language";
import { oneDark, oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import {barf, dracula} from 'thememirror';
//import { autocompletion } from "@codemirror/autocomplete";
import {EditorState, RangeSetBuilder, EditorSelection, Compartment} from "@codemirror/state"

import {
  EditorView, keymap, highlightSpecialChars, drawSelection,
  highlightActiveLine, dropCursor, rectangularSelection,
  crosshairCursor, lineNumbers, highlightActiveLineGutter,
  Decoration, ViewPlugin
} from "@codemirror/view"
import {
  defaultHighlightStyle, syntaxHighlighting, indentOnInput,
  bracketMatching, foldGutter, foldKeymap, indentUnit
} from "@codemirror/language"
import {
  defaultKeymap, history, historyKeymap
} from "@codemirror/commands"
import {
  autocompletion, closeBrackets,
  closeBracketsKeymap, completionKeymap
} from "@codemirror/autocomplete"
import { linter, setDiagnostics } from "@codemirror/lint";
// Language support (your Lezer parser compiled to quanta.js)
import { quanta, quantaSyntax, quantaLanguageSupport } from "./quanta-support.ts";

import { quantaTheme } from "./custom-theme";

// Canvas runtime (drawCommands + utilities)
import { drawCommands, isAnimationMode, setup, checkIsCancelled, cancelNow, setIsSafari, setPrintHandler } from "./canvas-runtime.js";
import { createFpsCounter } from "./fps-counter.js";
import { encodeCode, decodeCode, isSharedHash } from "./share-link.js";
import { createConsole, formatDuration } from "./console-panel.js";
import { t, translateError, getLanguage, setLanguage, onLanguageChange, applyTranslations } from "./i18n.js";

// WASM glue (wasm-pack output); adjust crate name/path
import initWasm, { Compiler } from "../quanta-lang/pkg/quanta_lang.js";
//import { rustHighlighting } from "../grammar/highlight.js";

const runBtn = document.getElementById("runBtn");
const canvas = document.getElementById("canvas");
const shareBtn = document.getElementById("shareBtn");
/** Frame rate readout, shown only while an animation is running. */
const fpsCounter = createFpsCounter(document.getElementById("fpsCounter"), { format: (fps) => t("fps", fps) });
/** print() output, run status and errors. */
const consolePanel = createConsole(document.getElementById("consoleLines"), {
  onJump: (row, column) => jumpTo(row, column),
});
setPrintHandler((text) => consolePanel.print(text));

/** The live WASM runtime instance; `undefined` when no program is executing. */
let runtime = undefined;
/** True while a program is running (controls the Run/Stop button state). */
let isRunning = false;
/** Incremented on every Run so a finished older run doesn't reset the UI of a newer one. */
let currentRun = 0;

// ---------------------------------------------------------------------------
// Editor configuration
// ---------------------------------------------------------------------------

const fourSpaceIndent = indentUnit.of("    "); // 4 spaces

/**
 * Keymap extension that inserts four spaces on Tab instead of a real tab
 * character, keeping indentation consistent with the language convention.
 */
const insertFourSpaces = keymap.of([{
  key: "Tab",
  run: ({ state, dispatch }) => {
    dispatch(
      state.replaceSelection("    ") // 4 spaces
    );
    return true; // handled
  }
}]);

/** Compartment that allows hot-swapping the font-size theme extension. */
const fontSizeCompartment = new Compartment();

/**
 * Keymap extension that preserves leading indentation on Enter.
 *
 * Extra rules:
 *   - If the current line ends with `{`, the new line gets an extra 4-space indent.
 *   - If the current line ends with `{}` and the cursor is between the braces,
 *     both an indented line and a closing line are inserted.
 */
const newlineSameIndent = keymap.of([{
  key: "Enter",
  run: (view) => {
    const { state } = view;
    const tr = state.changeByRange(range => {
      const line = state.doc.lineAt(range.head);
      let leadingWS = (line.text.match(/^[ \t]*/) || [""])[0]; // copy tabs/spaces exactly
      let extra = "";
      if (line.text.trimEnd().endsWith("{")) {
          if (range.head === line.to) {
          // increase indent after {
          leadingWS += "    "; // add 4 spaces

        }
      }
      if (line.text.trimEnd().endsWith("{}")) {
        if (range.head === line.to - 1) {
        // increase indent after {
          extra += "\n" + leadingWS; // add 4 spaces
          leadingWS += "    "
        }
      }
      const insert = "\n" + leadingWS + extra;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.cursor(range.from + leadingWS.length + 1)
      };
    });
    view.dispatch(tr, { userEvent: "input" });
    return true;
  }
}]);

// ---------------------------------------------------------------------------
// Diagnostics helpers
// ---------------------------------------------------------------------------

/** The error shown in the editor, so it can be shown again in another language. */
let shownError = null;

/**
 * Display a compiler/runtime error as a CodeMirror inline diagnostic.
 *
 * @param {import("@codemirror/view").EditorView} editor - The active EditorView.
 * @param {{ start_row: number, start_column: number, end_row: number, end_column: number, get_error_message(): string }} err
 */
export function showError(editor, err) {
  if (err.start_row > editor.state.doc.lines || err.end_row > editor.state.doc.lines) {
    showOk(editor);
    return;
  }
  let diagnostics = [];
  const from_line = editor.state.doc.line(Math.max(1, err.start_row));
  const from = Math.min(from_line.to, from_line.from + err.start_column);
  const to_line = editor.state.doc.line(Math.max(1, err.end_row));
  const to = Math.min(to_line.to, to_line.from + err.end_column);
  diagnostics.push({
    from: from,
    to: to, // adjust for token length if needed
    severity: "error",
    message: translateError(err.get_error_message())
  });

  shownError = err;
  editor.dispatch(setDiagnostics(editor.state, diagnostics));
}

/**
 * Show an error in the console. Clicking its line number moves the cursor to it.
 *
 * @param {{ error_code: number, start_row: number, start_column: number, get_error_message(): string }} err
 */
export function reportError(err) {
  consolePanel.error(err);
}

/**
 * Show an error that has no source location (e.g. an internal failure).
 *
 * @param {string} message
 */
export function reportMessage(message) {
  consolePanel.message(message);
}

/** Move the cursor to `row` (1-based) and `column` and focus the editor. */
function jumpTo(row, column) {
  const doc = editor.state.doc;
  const line = doc.line(Math.min(doc.lines, Math.max(1, row)));
  const pos = Math.min(line.to, line.from + column);
  editor.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  editor.focus();
}

/**
 * Clear all inline diagnostics from the editor.
 *
 * @param {import("@codemirror/view").EditorView} editor
 */
export function showOk(editor) {
  shownError = null;
  editor.dispatch(setDiagnostics(editor.state, []));
}

// ---------------------------------------------------------------------------
// Editor initial content
// ---------------------------------------------------------------------------

const STORAGE_KEY = "quanta-editor-code";

let savedCode = null;
try { savedCode = localStorage.getItem(STORAGE_KEY); } catch {}
/** Program from a shared link (`#code=...`), if the page was opened with one. */
const sharedCode = await decodeCode(location.hash);
/** Shared program first, then the saved one, then this default. */
const startCode = sharedCode ?? (savedCode || `func mouse(int z, int y) {
    setFigureColor(Color::Red);
    rectangle(z, y, z+100, y+100);
    x = x + 10;
}

func keyboard(int key) {
    if (key == Key::Space) {
        setFigureColor(Color::Blue);
    } else {
      if (key == Key::A) {
          setFigureColor(Color::Black);
      } else {
          setFigureColor(Color::Yellow);
      }
    }
    x = x - 10;
}

global {
    int x = 320;
}

func main() {
   setLineColor(Color::Green);
   for i in (0..10000) {
      circle(x, 240, i % 100);
   }
   rectangle(0, 0, 100, 100);
}

`);

// ---------------------------------------------------------------------------
// Background compile (on typing)
// ---------------------------------------------------------------------------

/**
 * Compile `src` with a fresh WASM `Compiler` instance and show any error
 * as an inline diagnostic in the editor.
 * Called in the background while the user types; does not start execution.
 *
 * @param {{ view: import("@codemirror/view").EditorView }} editor - EditorView or update object.
 * @param {string} src - Full source text to compile.
 */
async function tryCompile(editor, src) {
  await initWasm();
  let idle_compiler = Compiler.new();
  const compilation_result = await idle_compiler.compile_code(src);   // Rust returns drawing commands (string)
   if (compilation_result.error_code != 0) {
    const err = compilation_result.get_error();
    showError(editor.view, err);
  //   runBtn.disabled = false;
  //   return;
   } else {
  //   showOk(editor);
   }
}

/** Handle for the debounce timer used by `onTyping`. */
let typingTimer = null;

/**
 * CodeMirror update listener that debounces background compilation.
 * On every document change it resets the 1-second timer, then compiles and
 * persists the source to localStorage when the user pauses typing.
 */
const onTyping = EditorView.updateListener.of(update => {
  if (update.docChanged) {
    shownError = null;
    update.view.dispatch(setDiagnostics(update.state, []));
    // Once the shared program is edited it is the user's own: drop the link
    // from the address bar so a reload shows the saved edits.
    if (isSharedHash(location.hash)) {
      window.history.replaceState(null, "", location.pathname + location.search);
    }
    clearTimeout(typingTimer);

    // schedule a new one
    typingTimer = setTimeout(() => {
      const code = update.state.doc.toString();

      tryCompile(update, code);
      try { localStorage.setItem(STORAGE_KEY, editor.state.doc.toString()); } catch {}

    }, 1000); // 1000ms = 1 second pause
  }
});

// ---------------------------------------------------------------------------
// Font-size controls
// ---------------------------------------------------------------------------

/**
 * Build a CodeMirror theme that applies `sizePx` to editor content and gutters.
 *
 * @param {number} sizePx - Font size in pixels.
 * @returns {import("@codemirror/view").Extension}
 */
export function fontSizeTheme(sizePx) {
  return EditorView.theme({
    ".cm-content": { fontSize: sizePx + "px" },
    ".cm-line":    { fontSize: sizePx + "px" },
    ".cm-gutters": { fontSize: sizePx + "px" }
  });
}

// Keep track of current size
let currentFontSize = 18;
let fontSizeExt = fontSizeTheme(currentFontSize);

/**
 * Keymap extension for runtime font-size adjustment:
 *   - `Mod-=`  → increase font size by 1 px.
 *   - `Mod--`  → decrease font size by 1 px (minimum 8 px).
 */
const fontSizeKeys = keymap.of([
  {
    key: "Mod-=",
    run: (view) => {
      currentFontSize += 1;
      view.dispatch({
        effects: fontSizeCompartment.reconfigure(fontSizeTheme(currentFontSize))
      });
      return true;
    }
  },
  {
    key: "Mod--",
    run: (view) => {
      currentFontSize = Math.max(8, currentFontSize - 1);
      view.dispatch({
        effects: fontSizeCompartment.reconfigure(fontSizeTheme(currentFontSize))
      });
      return true;
    }
  }
]);

// ---------------------------------------------------------------------------
// Safari detection
// ---------------------------------------------------------------------------

/** True when the page is running in Safari (detected via user-agent). */
let itIsSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

setIsSafari(itIsSafari);

// ---------------------------------------------------------------------------
// Editor instantiation
// ---------------------------------------------------------------------------

const editor = new EditorView({
  state: EditorState.create({
    doc: startCode,
     extensions: [
    // A line number gutter
    lineNumbers(),
    // A gutter with code folding markers
     foldGutter(),
    // // Replace non-printable characters with placeholders
     highlightSpecialChars(),
    // // The undo history
     history(),
    // // Replace native cursor/selection with our own
     drawSelection(),
    // // Show a drop cursor when dragging over the editor
    // dropCursor(),
    // // Allow multiple cursors/selections
    // EditorState.allowMultipleSelections.of(true),
    // // Re-indent lines when typing specific input
     indentOnInput(),
    // // Highlight syntax with a default style
    //syntaxHighlighting(rustHighlighting),
    // // Highlight matching brackets near cursor
     bracketMatching(),
    // // Automatically close brackets
     closeBrackets(),
    // // Load the autocompletion system
     autocompletion(),
    // // Allow alt-drag to select rectangular regions
    // rectangularSelection(),
    // // Change the cursor to a crosshair when holding alt
    // crosshairCursor(),
    // // Style the current line specially
     highlightActiveLine(),
    // // Style the gutter for current line specially
     highlightActiveLineGutter(),
    quantaTheme,
    quantaLanguageSupport,
    //keymap.of([{key: "Tab", run: acceptCompletion}]),
    // Highlight text that matches the selected text
    //highlightSelectionMatches(),
    onTyping,
    insertFourSpaces,
    fourSpaceIndent,
    newlineSameIndent,
    fontSizeCompartment.of(fontSizeTheme(currentFontSize)),
    fontSizeKeys,
    keymap.of([
      // Closed-brackets aware backspace
      ...closeBracketsKeymap,
      // A large set of basic bindings
      ...defaultKeymap,
      // Redo/undo keys
      ...historyKeymap,
      // Code folding bindings
      ...foldKeymap,
      // Autocompletion keys
      ...completionKeymap,
      // Keys related to the linter system
      //...lintKeymap
    ])
  ]
    // extensions: [
    //   lineNumbers(),
    //   highlightActiveLine(),
    //   indentOnInput(),
    //   history(),
    //   autocompletion(),
    //   quanta(),
    //
    //   oneDark
    // ]
  }),
  parent: document.getElementById("editor")
});

// ---------------------------------------------------------------------------
// Execution helpers
// ---------------------------------------------------------------------------

/** Clear all inline diagnostics from the global editor instance. */
function clearErrors() {
  editor.dispatch(setDiagnostics(editor.state, []));
}

/**
 * Stop the running program, clear the runtime reference and restore the idle UI.
 *
 * @param {boolean} [announce=true] - Note in the console that the program was stopped.
 */
function doStop(announce = true) {
  if (announce && isRunning) consolePanel.info('stopped');
  runtime?.stop();
  runtime = undefined;
  cancelNow();
  fpsCounter.reset();
  setIdleUI();
}

/**
 * Forward a keyboard event key string to the running program's `keyboard` handler.
 *
 * @param {string} key - Key value string (e.g. `"a"`, `"Enter"`, `"ArrowUp"`).
 */
async function executeKey(key) {
  let res = runtime.execute_key(key);
}

/**
 * Forward canvas-relative coordinates to the running program's `mouse` handler.
 *
 * @param {number} x - X position in logical canvas units (0–1000).
 * @param {number} y - Y position in logical canvas units (0–1000).
 */
async function executeMouse(x, y) {
  let res = runtime.execute_mouse(x, y);
}

// window.addEventListener('keydown', (e) => {
//   if (!runtime || !runtime.execute_key) return;

//   try {
//     (async () => {runtime.execute_key(e.key);})(); // pass string like 'a', 'Enter', etc.
//   } catch (err) {
//     console.warn('Keyboard runtime error:', err);
//   }
// });

/**
 * Compile and execute the current editor source.
 *
 * Flow:
 *   1. Stop any previous program, reset cancellation state and canvas.
 *   2. Compile with a fresh WASM `Compiler`; show error and abort on failure.
 *   3. Give the WASM runtime `drawCommands` as its renderer and await `execute()`.
 *      The runtime calls the renderer whenever it has drawing to show and
 *      handles `frame()`, `sleep()` and `setFps()` timing itself.
 *   4. Show the runtime error, if any, and restore idle UI state when done.
 */
function doRun() {
  const runId = ++currentRun;
  (async () => {
    try {
      runtime?.stop();
      runtime = undefined;
      cancelNow(false);
      fpsCounter.reset();
      isRunning = true;
      runBtn.disabled = true;
      consolePanel.clear();
      consolePanel.start();
      setup();
      await initWasm();
      const src = editor.state.doc.toString();
      let compiler = Compiler.new();
      const compilation_result = await compiler.compile_code(src);   // Rust returns drawing commands (string)
      if (compilation_result.error_code != 0) {
        const err = compilation_result.get_error();
        showError(editor, err);
        reportError(err);
        runBtn.disabled = false;
        return;
      } else {
        showOk(editor);
      }
      setRunningUI();
      consolePanel.info('started');
      const startedAt = performance.now();
      const activeRuntime = compilation_result.get_runtime();
      runtime = activeRuntime;
      // An error in a keyboard or mouse handler ends the program.
      activeRuntime.set_error_handler((err) => {
        if (runId !== currentRun) return;
        reportError(err);
        try {
          showError(editor, err);
        } finally {
          doStop(false);
        }
      });
      activeRuntime.set_renderer((ops, strings, present) => {
        drawCommands(ops, strings, present);
        if (present && isAnimationMode()) {
          fpsCounter.tick(performance.now());
        }
      });
      await activeRuntime.execute();
      if (runId !== currentRun || checkIsCancelled()) { return; }
      const err = activeRuntime.get_runtime_error();
      if (err.error_code != 0) {
        showError(editor, err);
        reportError(err);
      } else {
        const duration = performance.now() - startedAt;
        consolePanel.info('finished', () => formatDuration(duration));
      }
    } catch (e) {
      console.error(e);
      reportMessage(e?.message ?? String(e));
    } finally {
      if (runId === currentRun) {
        fpsCounter.reset();
        setIdleUI();
        runBtn.disabled = false;
      }
    }
  })();
}

// ---------------------------------------------------------------------------
// UI state helpers
// ---------------------------------------------------------------------------

/** Show `key`'s text on `button` and keep it when the language changes. */
function setButtonText(button, key) {
  button.dataset.i18n = key;
  button.textContent = t(key);
}

/** Switch the Run button to "Stop" and focus the canvas. */
function setRunningUI() {
  isRunning = true;
  setButtonText(runBtn, 'stop');
  runBtn.dataset.state = 'stop';
  runBtn.disabled = false;
  canvas.focus();
}

/** Switch the Run button back to "Run your program!" and mark execution idle. */
function setIdleUI() {
  isRunning = false;
  setButtonText(runBtn, 'run');
  runBtn.dataset.state = 'run';
  runBtn.disabled = false;
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

/** Toggle between running and stopping the program when the button is clicked. */
runBtn.addEventListener('click', () => {
  if (!isRunning) {
    doRun();
  } else {
    doStop();
  }
});

/**
 * Forward keyboard events to the running program.
 * Only active when the canvas element has focus, so editor shortcuts
 * are not accidentally captured.
 */
window.addEventListener('keydown', (e) => {
  if (!runtime) return;
  if (document.activeElement !== canvas) return;
  try {
    executeKey(e.key); // pass string like 'a', 'Enter', etc.
  } catch (err) {
    console.warn('Keyboard runtime error:', err);
  }
});

document.getElementById("consoleClear").addEventListener('click', () => consolePanel.clear());

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------

const languageButtons = document.querySelectorAll('[data-lang]');

/** Mark the button of the current language as pressed. */
function showLanguage() {
  for (const button of languageButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.lang === getLanguage()));
  }
}

for (const button of languageButtons) {
  button.addEventListener('click', () => setLanguage(button.dataset.lang));
}

onLanguageChange(() => {
  showLanguage();
  consolePanel.render();
  if (shownError) showError(editor, shownError);
});

applyTranslations();
showLanguage();

// ---------------------------------------------------------------------------
// Share links
// ---------------------------------------------------------------------------

/** Put the program in the address bar as `#code=...` and copy that link. */
shareBtn.addEventListener('click', async () => {
  const url = location.origin + location.pathname + location.search
    + await encodeCode(editor.state.doc.toString());
  window.history.replaceState(null, "", url);
  try {
    await navigator.clipboard.writeText(url);
    setButtonText(shareBtn, 'linkCopied');
    setTimeout(() => setButtonText(shareBtn, 'share'), 2000);
  } catch {
    prompt(t('promptCopyLink'), url);
  }
});

/** Load a shared program when a link is pasted into an already open tab. */
window.addEventListener('hashchange', async () => {
  const code = await decodeCode(location.hash);
  if (code === null) return;
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: code } });
});

// ---------------------------------------------------------------------------
// Pane resizer (drag handle between editor and canvas)
// ---------------------------------------------------------------------------

const resizer = document.getElementById('resizer');
const panes = document.querySelector('.panes');
let isDragging = false;

resizer.addEventListener('mousedown', (e) => {
  isDragging = true;
  document.body.style.cursor = 'col-resize';
});

/** Update the CSS grid column sizes while the user drags the handle. */
window.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  const totalWidth = panes.getBoundingClientRect().width;
  const leftWidth = e.clientX;
  const rightWidth = totalWidth - leftWidth - 4; // 4 = resizer width
  panes.style.gridTemplateColumns = `${leftWidth}px 4px ${rightWidth}px`;
});

window.addEventListener('mouseup', () => {
  isDragging = false;
  document.body.style.cursor = '';
});

/**
 * Forward canvas click coordinates (normalised to 0–1000 logical units)
 * to the running program's `mouse` handler.
 */
document.getElementById("canvas").addEventListener('click', (e) => {
  if (!runtime) return;

  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width * 1000;
  const y = (e.clientY - rect.top) /rect.height * 1000;

  try {
    const dpr = window.devicePixelRatio || 1;

  // Match canvas internal size to actual visible size * device pixel ratio
    executeMouse(x, y);
  } catch (err) {
    console.warn('Mouse runtime error:', err);
  }
});

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

/**
 * Trigger a browser download of `text` as a plain-text file named `filename`.
 *
 * @param {string} filename - Suggested download filename.
 * @param {string} text     - File contents.
 */
export function downloadFile(filename, text) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Download the current editor source as a `.quanta` file. */
document.getElementById("downloadBtn").addEventListener("click", () => {
  const code = editor.state.doc.toString();

  // Ask user for filename
  let filename = prompt(t('promptFilename'), t('defaultFilename'));
  if (!filename) return; // user pressed Cancel

  // Ensure extension
  if (!filename.endsWith(".quanta")) {
    filename += ".quanta";
  }

  downloadFile(filename, code);
});

// Load file on demand
const fileInput = document.getElementById("fileInput");

/** Open the system file picker to load a `.quanta` source file. */
document.getElementById("loadBtn").addEventListener("click", () => {
  fileInput.value = ""; // reset so selecting the same file again still triggers
  fileInput.click();    // open system file picker
});

/** Export the current canvas contents as a JPEG image. */
document.getElementById("saveBtn").addEventListener("click", () => {
  const canvas = document.getElementById("canvas");
  const image = canvas.toDataURL("image/jpeg", 0.95); // 0.95 is quality

  const filename = prompt(t('promptPainting'), t('defaultPainting'));
  if (!filename) return; // user pressed Cancel

  const link = document.createElement("a");
  link.href = image;
  link.download = filename + ".jpg";
  link.click();
});

/** Read the selected file and replace the editor's content with its text. */
fileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: reader.result }
    });
  };
  reader.readAsText(file);
});

// // Ctrl/Cmd+Enter
// addEventListener("keydown", (e) => {
//   const isMac = navigator.platform.toLowerCase().includes("mac");
//   if ((isMac ? e.metaKey : e.ctrlKey) && e.key === "Enter") {
//     e.preventDefault();
//     doRun();
//   }
// });

//resizeCanvasToDisplaySize();
editor.focus();

//const observer = new ResizeObserver(() => resizeCanvasToDisplaySize());
//observer.observe(canvas);
