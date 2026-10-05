/**
 * Tests for web/i18n.js and the error translations in web/error-messages.js.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { STRINGS, t, setLanguage, translateError, templateToRegex, errorKind } from '../../web/i18n.js';
import { ERROR_MESSAGES_UK } from '../../web/error-messages.js';

const ROOT = resolve(__dirname, '../..');
/** Sources that are not compiled into the interpreter. */
const NOT_BUILT = ['tests.rs', 'linear_execution.rs', 'linear_runtime.rs'];

function rustFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return rustFiles(path);
    return entry.name.endsWith('.rs') && !NOT_BUILT.includes(entry.name) ? [path] : [];
  });
}

/** Every error message format string in the Rust sources. */
function rustErrorTemplates() {
  const templates = new Set();
  const pattern = /Error::(?:parse|logic|type_er|runtime)\(\s*(?:format!\(|String::from\()\s*"((?:[^"\\]|\\.)*)"/g;
  for (const file of [...rustFiles(join(ROOT, 'quanta-lang/src')), ...rustFiles(join(ROOT, 'quanta_parser/src'))]) {
    const code = readFileSync(file, 'utf8')
      .split('\n')
      .filter(line => !line.trim().startsWith('//'))
      .join('\n');
    for (const match of code.matchAll(pattern)) templates.add(match[1]);
  }
  return [...templates];
}

afterEach(() => setLanguage('en'));

describe('error translations', () => {
  it('cover every error message in the Rust sources', () => {
    const templates = rustErrorTemplates();
    expect(templates.length).toBeGreaterThan(50);
    const missing = templates.filter(template => !(template in ERROR_MESSAGES_UK));
    expect(missing).toEqual([]);
  });

  it('only use values the English message has', () => {
    for (const [en, uk] of Object.entries(ERROR_MESSAGES_UK)) {
      const count = (en.match(/\{(?::\?)?\}/g) ?? []).length;
      for (const [, i] of uk.matchAll(/\{(\d+)\}/g)) {
        expect(Number(i), `${uk}`).toBeLessThan(count);
      }
    }
  });

  it('templateToRegex matches the formatted message and captures its values', () => {
    const regex = templateToRegex("Wrong number of arguments for command '{}': got {}, expected {}");
    expect(regex.exec("Wrong number of arguments for command 'circle': got 2, expected 3").slice(1))
      .toEqual(['circle', '2', '3']);
    expect(templateToRegex("Probably missing a ')' or a '}}'").test("Probably missing a ')' or a '}'")).toBe(true);
  });
});

describe('translateError', () => {
  it('leaves English messages unchanged', () => {
    expect(translateError('Division by 0')).toBe('Division by 0');
  });

  it('translates messages with values into Ukrainian', () => {
    setLanguage('uk');
    expect(translateError('Division by 0')).toBe('Ділення на 0');
    expect(translateError("Cannot assign expression of type 'float' to variable 'x' of type 'int'!"))
      .toBe("Не можна присвоїти вираз типу 'float' змінній 'x' типу 'int'!");
    expect(translateError('Variable y is not defined!')).toBe('Змінну y не оголошено!');
  });

  it('prefers the most specific message', () => {
    setLanguage('uk');
    expect(translateError('Function f has no return type defined, but returns int'))
      .toBe('У функції f не вказано тип результату, але вона повертає int');
    expect(translateError("Unknown function 'g'")).toBe("Невідома функція 'g'");
  });

  it("translates the parser's wording", () => {
    setLanguage('uk');
    expect(translateError("ERROR expected statement or block on line 'x = ;'"))
      .toBe("Помилка: очікується команда або блок у рядку 'x = ;'");
  });

  it('translates grammar terms without changing the quoted source', () => {
    setLanguage('uk');
    expect(translateError("ERROR expected expression on line 'int expression = ;'"))
      .toBe("Помилка: очікується вираз у рядку 'int expression = ;'");
    expect(translateError("ERROR expected type_name on line 'func main('"))
      .toBe("Помилка: очікується назва типу у рядку 'func main('");
    expect(translateError("ERROR unexpected EOI on line 'expression'"))
      .toBe("Помилка: неочікуваний елемент: кінець програми у рядку 'expression'");
  });

  it('returns unknown messages unchanged', () => {
    setLanguage('uk');
    expect(translateError('Something new')).toBe('Something new');
  });
});

describe('t', () => {
  it('fills in values', () => {
    expect(t('line', 7)).toBe('Line 7');
    setLanguage('uk');
    expect(t('line', 7)).toBe('Рядок 7');
  });

  it('has a Ukrainian text for every English one', () => {
    expect(Object.keys(STRINGS.uk).sort()).toEqual(Object.keys(STRINGS.en).sort());
  });

  it('names error kinds', () => {
    expect(errorKind(1)).toBe('Syntax error');
    expect(errorKind(4)).toBe('Runtime error');
    setLanguage('uk');
    expect(errorKind(3)).toBe('Помилка типів');
  });
});


describe('language on reload', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('restores the saved choice even when the browser uses English', async () => {
    localStorage.setItem('quanta-language', 'uk');
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
    const i18n = await import('../../web/i18n.js');
    expect(i18n.getLanguage()).toBe('uk');
  });

  it('uses Ukrainian browser language when the saved choice is invalid', async () => {
    localStorage.setItem('quanta-language', 'invalid');
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('uk-UA');
    const i18n = await import('../../web/i18n.js');
    expect(i18n.getLanguage()).toBe('uk');
  });

  it('follows Ukrainian browser language on the first visit', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('uk-UA');
    const i18n = await import('../../web/i18n.js');
    expect(i18n.getLanguage()).toBe('uk');
  });

  it('keeps language switching usable when storage access fails', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
    vi.stubGlobal('localStorage', {
      getItem() { throw new Error('storage blocked'); },
      setItem() { throw new Error('storage blocked'); },
    });
    const i18n = await import('../../web/i18n.js');
    expect(i18n.getLanguage()).toBe('en');
    expect(() => i18n.setLanguage('uk')).not.toThrow();
    expect(i18n.t('run')).toBe('Запустити програму!');
  });
});
