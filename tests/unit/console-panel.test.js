/**
 * Tests for web/console-panel.js.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createConsole, formatElapsed, formatDuration, MAX_LINE_CHARS } from '../../web/console-panel.js';
import { setLanguage } from '../../web/i18n.js';

let el;
let clock;
let panel;

function lines() {
  panel.flush();
  return [...el.children];
}

beforeEach(() => {
  el = document.createElement('ol');
  clock = 0;
  panel = createConsole(el, { now: () => clock, maxEntries: 3 });
});

beforeEach(() => setLanguage('en'));
afterEach(() => setLanguage('en'));

describe('formatting', () => {
  it('formatElapsed shows minutes, seconds and milliseconds', () => {
    expect(formatElapsed(0)).toBe('00:00.000');
    expect(formatElapsed(61234.9)).toBe('01:01.234');
  });

  it('formatDuration uses ms below a second and seconds above', () => {
    expect(formatDuration(85.4)).toBe('85 ms');
    expect(formatDuration(1250)).toBe('1.25 s');
    setLanguage('uk');
    expect(formatDuration(1250)).toBe('1,25 с');
  });
});

describe('createConsole', () => {
  it('shows printed text with the time since start', () => {
    panel.start();
    clock = 1500;
    panel.print('hello');
    const [line] = lines();
    expect(line.querySelector('.console__time').textContent).toBe('00:01.500');
    expect(line.querySelector('.console__text').textContent).toBe('hello');
  });

  it('collapses repeated lines into one with a count', () => {
    panel.print('a');
    lines();
    panel.print('a');
    panel.print('a');
    const all = lines();
    expect(all).toHaveLength(1);
    expect(all[0].querySelector('.console__count').textContent).toBe('×3');
  });

  it('keeps only the last lines', () => {
    for (const text of ['1', '2', '3', '4', '5']) panel.print(text);
    expect(lines().map(li => li.querySelector('.console__text').textContent)).toEqual(['3', '4', '5']);
  });

  it('does not start following when a batch evicts lines being read', () => {
    Object.defineProperties(el, {
      clientHeight: { get: () => 20 },
      scrollHeight: { get: () => el.children.length * 20 },
    });
    for (const text of ['one', 'two', 'three']) panel.print(text);
    lines();
    el.scrollTop = 0;
    panel.print('four');
    panel.print('five');
    lines();
    expect(el.scrollTop).toBe(0);
  });

  it('does not overwrite the saved scroll position while the log is hidden', () => {
    Object.defineProperties(el, {
      clientHeight: { get: () => el.hidden ? 0 : 20 },
      scrollHeight: { get: () => el.hidden ? 0 : el.children.length * 20 },
    });
    for (const text of ['one', 'two', 'three']) panel.print(text);
    lines();
    el.scrollTop = 20;
    el.hidden = true;
    panel.print('four');
    lines();
    expect(el.scrollTop).toBe(20);
  });

  it('continues following at the bottom when history rolls over', () => {
    Object.defineProperties(el, {
      clientHeight: { get: () => 20 },
      scrollHeight: { get: () => el.children.length * 20 },
    });
    for (const text of ['one', 'two', 'three']) panel.print(text);
    lines();
    el.scrollTop = 40;
    panel.print('four');
    panel.print('five');
    lines();
    expect(el.scrollTop).toBe(el.scrollHeight);
  });

  it('adds a swatch for printed colors', () => {
    panel.print('c = color(255, 0, 0, 255)');
    const swatch = lines()[0].querySelector('.console__swatch');
    expect(swatch.style.backgroundColor).toBe('rgb(255, 0, 0)');
    expect(lines()[0].querySelector('.console__text').textContent).toBe('c = color(255, 0, 0, 255)');
  });

  it('draws lines once per batch', async () => {
    panel.print('x');
    panel.print('y');
    expect(el.children).toHaveLength(0);
    await Promise.resolve();
    expect(el.children).toHaveLength(2);
  });

  it('re-renders status lines and errors in the new language', () => {
    panel.info('stopped');
    panel.error({ error_code: 4, start_row: 2, start_column: 0, get_error_message: () => 'Division by 0' });
    expect(lines().map(li => li.textContent)).toEqual([
      '00:00.000Stopped',
      '00:00.000Line 2Runtime error: Division by 0',
    ]);
    setLanguage('uk');
    panel.render();
    expect(lines().map(li => li.textContent)).toEqual([
      '00:00.000Зупинено',
      '00:00.000Рядок 2Помилка виконання: Ділення на 0',
    ]);
  });

  it('formats function params when rendering', () => {
    panel.info('finished', () => formatDuration(1500));
    expect(lines()[0].textContent).toBe('00:00.000Finished in 1.5 s');
    setLanguage('uk');
    panel.render();
    expect(lines()[0].textContent).toBe('00:00.000Завершено за 1,5 с');
  });

  it('calls onJump with the error location', () => {
    const jumps = [];
    panel = createConsole(el, { onJump: (row, column) => jumps.push([row, column]) });
    panel.error({ error_code: 1, start_row: 4, start_column: 7, get_error_message: () => "Probably missing ';'" });
    lines()[0].querySelector('.console__loc').click();
    expect(jumps).toEqual([[4, 7]]);
  });
});


describe('check problems', () => {
  const problem = (row, message) => ({ error_code: 1, start_row: row, start_column: 1, get_error_message: () => message });

  it('replaces the previous check instead of piling up, after program output', () => {
    panel.print('out');
    panel.problems([problem(2, "Probably missing ';'"), problem(5, 'Division by 0')]);
    expect(lines()).toHaveLength(3);
    panel.problems([problem(7, 'Division by 0')]);
    expect(lines().map(li => li.textContent)).toEqual(['00:00.000out', 'Line 7Syntax error: Division by 0']);
    panel.problems([]);
    expect(lines().map(li => li.textContent)).toEqual(['00:00.000out']);
  });

  it('shows no run time, since a check is not part of a run', () => {
    panel.problems([problem(1, 'Division by 0')]);
    expect(lines()[0].querySelector('.console__time').textContent).toBe('');
  });

  it('keeps output printed after the check when the next check replaces it', () => {
    panel.problems([problem(1, 'Division by 0')]);
    lines();
    panel.print('later');
    panel.problems([]);
    expect(lines().map(li => li.textContent)).toEqual(['00:00.000later']);
  });
});


describe('console activity', () => {
  it('notifies for repeated prints and errors, but not run statuses', () => {
    const activity = [];
    panel = createConsole(el, { onActivity: kind => activity.push(kind) });
    panel.info('started');
    panel.print('x');
    panel.print('x');
    panel.error({ error_code: 4, start_row: 1, get_error_message: () => 'Division by 0' });
    panel.message('Internal failure');
    expect(activity).toEqual(['print', 'print', 'error', 'error']);
  });
});

describe('very long lines', () => {
  const text = (li) => li.querySelector('.console__text').textContent;

  it('cuts a long printed line at the limit and says how much was left out', () => {
    panel.print('x'.repeat(MAX_LINE_CHARS + 2345));
    const [line] = lines();
    expect(text(line)).toBe('x'.repeat(MAX_LINE_CHARS) + '… (+2345 characters)');
  });

  it('keeps only the cut text in memory', () => {
    panel.print('y'.repeat(1_300_000));
    expect(panel.entries[0].text.length).toBe(MAX_LINE_CHARS);
  });

  it('leaves a line of exactly the limit alone', () => {
    panel.print('x'.repeat(MAX_LINE_CHARS));
    expect(text(lines()[0])).toBe('x'.repeat(MAX_LINE_CHARS));
  });

  it('still merges identical long lines into one with a count', () => {
    const long = 'z'.repeat(50_000);
    panel.print(long);
    panel.print(long);
    panel.print(long);
    const all = lines();
    expect(all).toHaveLength(1);
    expect(all[0].querySelector('.console__count').textContent).toBe('×3');
  });

  it('does not merge a cut line with a shorter one that shares its start', () => {
    panel.print('x'.repeat(MAX_LINE_CHARS + 5));
    panel.print('x'.repeat(MAX_LINE_CHARS));
    expect(lines()).toHaveLength(2);
  });

  it('does not split a character made of two UTF-16 units', () => {
    panel.print('a'.repeat(MAX_LINE_CHARS - 1) + '😀' + 'b'.repeat(10));
    const shown = text(lines()[0]);
    expect(shown.startsWith('a'.repeat(MAX_LINE_CHARS - 1) + '…')).toBe(true);
    expect(shown).not.toMatch(/[\ud800-\udbff]…/);
  });

  it('words the note in the current language', () => {
    panel.print('x'.repeat(MAX_LINE_CHARS + 7));
    lines();
    setLanguage('uk');
    panel.render();
    expect(text([...el.children][0]).endsWith('… (ще 7 символів)')).toBe(true);
  });

  it('keeps every stored line small however much is printed', () => {
    const big = 'q'.repeat(200_000);
    for (let i = 0; i < 50; i++) panel.print(big + i);
    lines();
    for (const entry of panel.entries) expect(entry.text.length).toBeLessThanOrEqual(MAX_LINE_CHARS);
  });
});
