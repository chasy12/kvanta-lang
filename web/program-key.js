/**
 * program-key.js
 *
 * Names a key press for the running program by the key's position, so
 * `Key::A` means the A key on any layout (Ukrainian, with Shift, …).
 */

/**
 * @param {{ key: string, code: string }} event - A `keydown` event.
 * @returns {string} The key name the runtime understands (`"a"`, `"1"`, `" "`, `"ArrowUp"`, …).
 */
export function programKey({ key, code }) {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].toLowerCase();
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(code);
  if (digit) return digit[1];
  if (code === 'Space') return ' ';
  if (code === 'Enter' || code === 'NumpadEnter') return 'Enter';
  if (code.startsWith('Arrow')) return code;
  return key;
}
