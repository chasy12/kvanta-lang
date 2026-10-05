/**
 * Tests for web/console-panel.js.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createConsole, formatElapsed, formatDuration } from '../../web/console-panel.js';
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
