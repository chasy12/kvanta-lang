import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { createConsoleInput } from '../../web/console-input.js';
import { setLanguage } from '../../web/i18n.js';

let host, input;
function field() { return host.querySelector('input'); }
function submit(value) {
  field().value = value;
  host.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}
beforeEach(() => {
  setLanguage('en');
  host = document.createElement('div');
  document.body.append(host);
  input = createConsoleInput(host);
});
afterEach(() => { input?.cancel(); host.remove(); });

describe('console input', () => {
  it('waits for a valid integer and allows retrying an invalid value', async () => {
    const value = input.request('int');
    let settled = false;
    value.then(() => { settled = true; });
    expect(document.activeElement).toBe(field());
    submit('1.5');
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(field().getAttribute('aria-invalid')).toBe('true');
    expect(host.textContent).toContain('whole number');
    submit('-2147483648');
    await expect(value).resolves.toBe('-2147483648');
    expect(host.hidden).toBe(true);
  });

  it('rejects integer overflow and malformed numbers', async () => {
    const value = input.request('int');
    for (const raw of ['2147483648', '-2147483649', '1e2', '', '12abc']) {
      submit(raw);
      expect(field().getAttribute('aria-invalid')).toBe('true');
    }
    submit(' +42 ');
    await expect(value).resolves.toBe(' +42 ');
  });

  it('accepts decimal and exponent floats but rejects nonfinite f32 values', async () => {
    const value = input.request('float');
    for (const raw of ['', 'NaN', 'Infinity', '1e39', '0x10', '12abc']) {
      submit(raw);
      expect(field().getAttribute('aria-invalid')).toBe('true');
    }
    submit('-1.25e2');
    await expect(value).resolves.toBe('-1.25e2');
  });

  it.each([
    ['int', '42'], ['float', '1.25'], ['bool', 'true'],
  ])('matches runtime Unicode whitespace for %s input', async (kind, raw) => {
    const value = input.request(kind);
    submit(`\uFEFF${raw}`);
    expect(field().getAttribute('aria-invalid')).toBe('true');
    submit(`\u0085${raw}\u0085`);
    await expect(value).resolves.toBe(`\u0085${raw}\u0085`);
    expect(host.hidden).toBe(true);
  });

  it('accepts true/false booleans and preserves empty and whitespace strings', async () => {
    const bool = input.request('bool');
    submit('yes');
    expect(field().getAttribute('aria-invalid')).toBe('true');
    submit(' false ');
    await expect(bool).resolves.toBe(' false ');
    const blank = input.request('string');
    submit('');
    await expect(blank).resolves.toBe('');
    const text = input.request('string');
    submit('  привіт  ');
    await expect(text).resolves.toBe('  привіт  ');
  });

  it('queues concurrent requests in order without reusing values', async () => {
    const first = input.request('int');
    const second = input.request('string');
    submit('7');
    await expect(first).resolves.toBe('7');
    expect(field().value).toBe('');
    expect(host.textContent).toContain('string');
    submit('next');
    await expect(second).resolves.toBe('next');
  });

  it('cancels every pending request and keeps new requests independent', async () => {
    const first = input.request('int');
    const second = input.request('bool');
    input.cancel();
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
    expect(host.hidden).toBe(true);
    const next = input.request('string');
    submit('new run');
    await expect(next).resolves.toBe('new run');
  });

  it('translates a pending form without clearing entered text or validation', async () => {
    const value = input.request('int');
    submit('bad');
    setLanguage('uk');
    input.refresh();
    expect(field().value).toBe('bad');
    expect(host.textContent).toContain('Введіть int');
    expect(host.textContent).toContain('ціле число');
    submit('5');
    await expect(value).resolves.toBe('5');
  });
});
