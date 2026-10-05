/**
 * console-panel.js
 *
 * The console under the canvas: `print()` output, run status and errors.
 *
 *   - Each line shows the time since the program started.
 *   - Identical `print()` lines in a row collapse into one with a ×N count.
 *   - Colors in printed text (`color(r, g, b, a)`) get a swatch.
 *   - Errors show their line; clicking it calls `onJump(row, column)`.
 *   - Only the last `maxEntries` lines are kept.
 *   - Lines are stored as data and re-rendered by `render()`, so they follow
 *     a language switch.
 */

import { t, translateError, errorKind, getLanguage } from './i18n.js';

const COLOR_PATTERN = /color\((\d+), (\d+), (\d+), (\d+)\)/g;

/**
 * Format a time offset as `mm:ss.mmm`.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor(total / 1000) % 60;
  const millis = total % 1000;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

/**
 * Format a run duration, e.g. `85 ms` or `1.25 s`.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (ms < 1000) return t('ms', Math.round(ms));
  const seconds = new Intl.NumberFormat(getLanguage(), { maximumFractionDigits: 2 }).format(ms / 1000);
  return t('seconds', seconds);
}

/**
 * Append `text` to `parent`, adding a color swatch before each `color(r, g, b, a)`.
 *
 * @param {HTMLElement} parent
 * @param {string} text
 */
function appendPrinted(parent, text) {
  let last = 0;
  for (const match of text.matchAll(COLOR_PATTERN)) {
    parent.append(text.slice(last, match.index));
    const [, r, g, b, a] = match;
    const swatch = document.createElement('span');
    swatch.className = 'console__swatch';
    swatch.style.backgroundColor = `rgba(${r}, ${g}, ${b}, ${a / 255})`;
    parent.append(swatch, match[0]);
    last = match.index + match[0].length;
  }
  parent.append(text.slice(last));
}

/**
 * Create the console in the list element `el`.
 *
 * @param {HTMLElement} el
 * @param {{ onJump?: (row: number, column: number) => void, maxEntries?: number, now?: () => number, onActivity?: (kind: string) => void }} [options]
 */
export function createConsole(el, { onJump = () => {}, maxEntries = 1000, now = () => performance.now(), onActivity = () => {} } = {}) {
  /** @type {Array<{ kind: string, time: number, text?: string, count?: number, key?: string, params?: any[], code?: number, message?: string, row?: number, column?: number, node?: HTMLElement }>} */
  let entries = [];
  let startedAt = now();

  function renderEntry(entry) {
    const li = document.createElement('li');
    li.className = `console__line console__line--${entry.kind}`;

    const time = document.createElement('span');
    time.className = 'console__time';
    time.textContent = formatElapsed(entry.time);
    li.append(time);

    const body = document.createElement('span');
    body.className = 'console__text';

    if (entry.kind === 'print') {
      appendPrinted(body, entry.text);
    } else if (entry.kind === 'info') {
      body.textContent = t(entry.key, ...entry.params.map(param => (typeof param === 'function' ? param() : param)));
    } else {
      if (entry.row > 0) {
        const loc = document.createElement('button');
        loc.type = 'button';
        loc.className = 'console__loc';
        loc.textContent = t('line', entry.row);
        loc.title = t('goToLine', entry.row);
        loc.addEventListener('click', () => onJump(entry.row, entry.column));
        li.append(loc);
      }
      const kind = document.createElement('span');
      kind.className = 'console__kind';
      kind.textContent = entry.code ? errorKind(entry.code) + ':' : t('error') + ':';
      body.append(kind, ' ', entry.code ? translateError(entry.message) : entry.message);
    }
    li.append(body);

    if (entry.count > 1) {
      const count = document.createElement('span');
      count.className = 'console__count';
      count.textContent = '×' + entry.count;
      count.title = t('repeated', entry.count);
      li.append(count);
    }
    entry.node = li;
    return li;
  }

  /** Lines whose ×N count changed since they were drawn. */
  const stale = new Set();
  /** Evict DOM rows after measuring whether the reader was following output. */
  const expiredNodes = new Set();
  let scheduled = false;

  /**
   * Draw new and changed lines. Runs once per batch of output (a microtask
   * after the first change), so a loop of prints costs one layout.
   */
  function flush() {
    scheduled = false;
    const follow = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
    for (const node of expiredNodes) node.remove();
    expiredNodes.clear();
    for (const entry of stale) {
      if (entry.node) entry.node.replaceWith(renderEntry(entry));
    }
    stale.clear();
    const fresh = entries.filter(entry => !entry.node);
    if (fresh.length) el.append(...fresh.map(renderEntry));
    if (follow && !el.hidden) el.scrollTop = el.scrollHeight;
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(flush);
  }

  function add(entry) {
    entry.time = now() - startedAt;
    entries.push(entry);
    if (entries.length > maxEntries) {
      const removed = entries.shift();
      if (removed.node) expiredNodes.add(removed.node);
      stale.delete(removed);
    }
    schedule();
    if (entry.kind !== 'info') onActivity(entry.kind);
  }

  return {
    /** Restart the clock that line times are measured from. */
    start() {
      startedAt = now();
    },

    /** Add a line of program output. */
    print(text) {
      const last = entries[entries.length - 1];
      if (last?.kind === 'print' && last.text === text) {
        last.count += 1;
        onActivity('print');
        if (last.node) stale.add(last);
        schedule();
        return;
      }
      add({ kind: 'print', text, count: 1 });
    },

    /**
     * Add a status line with the UI string `key`. A function param is called
     * on every render, so values like durations follow a language switch.
     */
    info(key, ...params) {
      add({ kind: 'info', key, params });
    },

    /**
     * Add a compiler or runtime error.
     *
     * @param {{ error_code: number, start_row: number, start_column: number, get_error_message(): string }} err
     */
    error(err) {
      add({ kind: 'error', code: err.error_code, message: err.get_error_message(), row: err.start_row, column: err.start_column });
    },

    /** Add an error without a source location, e.g. an internal failure. */
    message(text) {
      add({ kind: 'error', code: 0, message: text, row: 0, column: 0 });
    },

    clear() {
      entries = [];
      stale.clear();
      expiredNodes.clear();
      el.replaceChildren();
    },

    /** Redraw every line, e.g. after a language switch. */
    render() {
      stale.clear();
      expiredNodes.clear();
      el.replaceChildren(...entries.map(renderEntry));
    },

    /** Draw pending lines now instead of at the end of the current task. */
    flush,

    /** The lines currently kept, for tests. */
    get entries() {
      return entries;
    },
  };
}
