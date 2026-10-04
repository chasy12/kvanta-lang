import { describe, it, expect, beforeEach } from 'vitest';
import { createFpsCounter } from '../../web/fps-counter.js';

describe('createFpsCounter', () => {
  let el;
  let counter;

  beforeEach(() => {
    el = document.createElement('div');
    el.hidden = true;
    counter = createFpsCounter(el, { intervalMs: 500 });
  });

  it('shows itself on the first frame', () => {
    counter.tick(0);
    expect(el.hidden).toBe(false);
  });

  it('reports the frame rate once the interval has passed', () => {
    for (let i = 0; i <= 30; i++) counter.tick(i * (1000 / 60));
    expect(el.textContent).toBe('60 fps');
  });

  it('keeps the previous reading until the interval has passed', () => {
    for (let i = 0; i <= 30; i++) counter.tick(i * (1000 / 60));
    counter.tick(520);
    expect(el.textContent).toBe('60 fps');
  });

  it('measures a lower rate', () => {
    for (let i = 0; i <= 15; i++) counter.tick(i * (1000 / 30));
    expect(el.textContent).toBe('30 fps');
  });

  it('hides itself and starts over after reset', () => {
    for (let i = 0; i <= 30; i++) counter.tick(i * (1000 / 60));
    counter.reset();
    expect(el.hidden).toBe(true);

    counter.tick(10_000);
    expect(el.hidden).toBe(false);
    expect(el.textContent).toBe('– fps');
  });
});
