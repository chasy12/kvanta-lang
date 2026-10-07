/**
 * Tests for index.html: icon-only buttons keep a translated accessible name.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyTranslations, setLanguage, STRINGS } from '../../web/i18n.js';

const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');

function loadPage() {
  return new DOMParser().parseFromString(html, 'text/html');
}

function accessibleName(button) {
  return (button.getAttribute('aria-label') ?? button.textContent).trim();
}

const ICON_BUTTONS = ['loadBtn', 'downloadBtn', 'shareBtn', 'runBtn', 'saveBtn', 'consoleClear'];

describe('index.html icon buttons', () => {
  afterEach(() => setLanguage('en'));

  for (const lang of ['en', 'uk']) {
    it(`have a name and tooltip in ${lang}`, () => {
      setLanguage(lang);
      const page = loadPage();
      applyTranslations(page);
      const strings = Object.values(STRINGS[lang]);
      for (const id of ICON_BUTTONS) {
        const button = page.getElementById(id);
        expect(button, id).toBeTruthy();
        expect(strings, `${id} name`).toContain(accessibleName(button));
        expect(strings, `${id} title`).toContain(button.title);
      }
    });
  }

  it('describes the logo as decorative next to the brand text', () => {
    expect(loadPage().querySelector('.brand__logo').getAttribute('alt')).toBe('');
  });
});
