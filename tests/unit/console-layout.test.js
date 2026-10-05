import { describe, it, expect, beforeEach } from 'vitest';
import { createConsoleLayout } from '../../web/console-layout.js';
import { setLanguage } from '../../web/i18n.js';

let container, panel, toggle, clear, resize, layout;
beforeEach(() => {
  setLanguage('uk');
  container = document.createElement('div');
  container.innerHTML = '<section><button class="toggle"></button><button class="clear"></button><ol role="log"></ol></section><div class="resize"></div>';
  panel = container.querySelector('section');
  toggle = container.querySelector('.toggle');
  clear = container.querySelector('.clear');
  resize = container.querySelector('.resize');
  container.getBoundingClientRect = () => ({ height: 600, bottom: 600 });
  layout = createConsoleLayout({ container, panel, toggle, clear, resize });
});

describe('console layout', () => {
  it('collapses and reopens without losing the selected height', () => {
    resize.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowUp',bubbles:true}));
    const height = panel.style.getPropertyValue('--console-height');
    toggle.click();
    expect(panel.classList.contains('console--closed')).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(resize.hidden).toBe(true);
    expect(clear.hidden).toBe(true);
    toggle.click();
    expect(panel.classList.contains('console--closed')).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(panel.style.getPropertyValue('--console-height')).toBe(height);
  });

  it('indicates hidden output and gives errors priority until opened', () => {
    toggle.click();
    layout.notify('print');
    expect(toggle.dataset.activity).toBe('print');
    layout.notify('error');
    layout.notify('print');
    expect(toggle.dataset.activity).toBe('error');
    expect(toggle.getAttribute('aria-label')).toContain('нові помилки');
    layout.refresh();
    expect(toggle.dataset.activity).toBe('error');
    toggle.click();
    expect(toggle.dataset.activity).toBe('');
    layout.notify('error');
    expect(toggle.dataset.activity).toBe('');
  });

  it('shows the latest hidden information when reopened and retains position otherwise', () => {
    const lines = panel.querySelector('[role="log"]');
    Object.defineProperty(lines, 'scrollHeight', { get: () => 600 });
    lines.scrollTop = 20;
    toggle.click();
    toggle.click();
    expect(lines.scrollTop).toBe(20);
    toggle.click();
    layout.notify('error');
    toggle.click();
    expect(lines.scrollTop).toBe(600);
  });

  it('clears the hidden indicator when output is cleared', () => {
    toggle.click();
    layout.notify('error');
    layout.reset();
    expect(toggle.dataset.activity).toBe('');
  });

  it('adjusts height with arrow keys and clamps it to keep the canvas visible', () => {
    resize.dispatchEvent(new KeyboardEvent('keydown', {key:'Home',bubbles:true}));
    expect(panel.style.getPropertyValue('--console-height')).toBe('96px');
    resize.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown',bubbles:true}));
    expect(panel.style.getPropertyValue('--console-height')).toBe('96px');
    resize.dispatchEvent(new KeyboardEvent('keydown', {key:'End',bubbles:true}));
    expect(panel.style.getPropertyValue('--console-height')).toBe('420px');
    resize.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowUp',bubbles:true}));
    expect(panel.style.getPropertyValue('--console-height')).toBe('420px');
    expect(resize.getAttribute('aria-valuenow')).toBe('420');
  });

  it('resizes with pointer dragging and stops on pointer cancellation', () => {
    const event = (name, y) => {
      const e = new Event(name, {bubbles:true});
      Object.defineProperties(e, {clientY:{value:y},pointerId:{value:1},button:{value:0}});
      return e;
    };
    resize.dispatchEvent(event('pointerdown', 400));
    resize.dispatchEvent(event('pointermove', 320));
    expect(panel.style.getPropertyValue('--console-height')).toBe('272px');
    resize.dispatchEvent(event('pointercancel', 320));
    resize.dispatchEvent(event('pointermove', 100));
    expect(panel.style.getPropertyValue('--console-height')).toBe('272px');
  });
});
