/**
 * Tests for web/program-key.js: keys reach programs by position, whatever the layout.
 */
import { describe, it, expect } from 'vitest';
import { programKey } from '../../web/program-key.js';

describe('programKey', () => {
  it.each([
    [{ key: 'a', code: 'KeyA' }, 'a'],
    [{ key: 'ф', code: 'KeyA' }, 'a'],
    [{ key: 'A', code: 'KeyA' }, 'a'],
    [{ key: 'я', code: 'KeyZ' }, 'z'],
    [{ key: '!', code: 'Digit1' }, '1'],
    [{ key: '7', code: 'Numpad7' }, '7'],
    [{ key: ' ', code: 'Space' }, ' '],
    [{ key: 'Enter', code: 'NumpadEnter' }, 'Enter'],
    [{ key: 'ArrowUp', code: 'ArrowUp' }, 'ArrowUp'],
  ])('maps %o to %s', (event, expected) => {
    expect(programKey(event)).toBe(expected);
  });

  it('falls back to the typed character for keys without a fixed position', () => {
    expect(programKey({ key: 'Escape', code: 'Escape' })).toBe('Escape');
    expect(programKey({ key: 'a', code: '' })).toBe('a');
  });
});
