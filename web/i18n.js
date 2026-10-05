/**
 * i18n.js
 *
 * Interface language (English or Ukrainian).
 *
 *   - `t(key, ...params)` returns a UI string; `{0}`, `{1}`, … are replaced by params.
 *   - Elements with `data-i18n="key"` get their text from `t(key)`, and
 *     `data-i18n-title` / `data-i18n-aria-label` / `data-i18n-empty` set those attributes.
 *   - `translateError` translates compiler and runtime error messages.
 *   - The choice is saved in localStorage; the first visit uses Ukrainian.
 */

import { ERROR_MESSAGES_UK } from './error-messages.js';

const STORAGE_KEY = 'quanta-language';

export const LANGUAGES = ['en', 'uk'];

export const STRINGS = {
  en: {
    pageTitle: 'Kvanta – IDE',
    language: 'Language',
    download: 'Download',
    load: 'Load from file',
    saveImage: 'Save Image',
    share: 'Share',
    shareTitle: 'Copy a link that opens this program',
    linkCopied: 'Link copied',
    run: 'Run your program!',
    stop: 'Stop',
    source: 'Source',
    result: 'Result',
    console: 'Console',
    openConsole: 'Open console',
    closeConsole: 'Close console',
    resizeConsole: 'Resize console',
    newOutput: 'new output',
    newErrors: 'new errors',
    enterInput: 'Enter {0}',
    submitInput: 'Submit',
    enteredInput: 'Input: {0}',
    invalidInt: 'Enter a whole number from -2147483648 to 2147483647',
    invalidFloat: 'Enter a finite decimal number',
    invalidBool: 'Enter true or false',
    invalidInput: 'Invalid input type',
    diagnostics: 'Problems',
    closeProblems: 'Close problems',
    clear: 'Clear',
    consoleEmpty: 'print() output and errors appear here',
    started: 'Program started',
    finished: 'Finished in {0}',
    stopped: 'Stopped',
    line: 'Line {0}',
    goToLine: 'Go to line {0}',
    syntaxError: 'Syntax error',
    error: 'Error',
    typeError: 'Type error',
    runtimeError: 'Runtime error',
    repeated: 'Repeats: {0}',
    ms: '{0} ms',
    seconds: '{0} s',
    fps: '{0} fps',
    promptFilename: 'Enter filename:',
    defaultFilename: 'program',
    promptPainting: 'Enter painting name:',
    defaultPainting: 'painting',
    promptCopyLink: 'Copy this link:',
  },
  uk: {
    pageTitle: 'Kvanta – IDE',
    language: 'Мова',
    download: 'Зберегти файл',
    load: 'Відкрити файл',
    saveImage: 'Зберегти малюнок',
    share: 'Поділитися',
    shareTitle: 'Скопіювати посилання на цю програму',
    linkCopied: 'Посилання скопійовано',
    run: 'Запустити програму!',
    stop: 'Зупинити',
    source: 'Код',
    result: 'Результат',
    console: 'Консоль',
    openConsole: 'Відкрити консоль',
    closeConsole: 'Закрити консоль',
    resizeConsole: 'Змінити розмір консолі',
    newOutput: 'новий вивід',
    newErrors: 'нові помилки',
    enterInput: 'Введіть {0}',
    submitInput: 'Ввести',
    enteredInput: 'Ввід: {0}',
    invalidInt: 'Введіть ціле число від -2147483648 до 2147483647',
    invalidFloat: 'Введіть скінченне дробове число',
    invalidBool: 'Введіть true або false',
    invalidInput: 'Невідомий тип вводу',
    diagnostics: 'Проблеми',
    closeProblems: 'Закрити список проблем',
    clear: 'Очистити',
    consoleEmpty: 'Тут з’являться вивід print() і помилки',
    started: 'Програму запущено',
    finished: 'Завершено за {0}',
    stopped: 'Зупинено',
    line: 'Рядок {0}',
    goToLine: 'Перейти до рядка {0}',
    syntaxError: 'Синтаксична помилка',
    error: 'Помилка',
    typeError: 'Помилка типів',
    runtimeError: 'Помилка виконання',
    repeated: 'Повторів: {0}',
    ms: '{0} мс',
    seconds: '{0} с',
    fps: '{0} кадр/с',
    promptFilename: 'Назва файлу:',
    defaultFilename: 'програма',
    promptPainting: 'Назва малюнка:',
    defaultPainting: 'малюнок',
    promptCopyLink: 'Скопіюйте посилання:',
  },
};

let current = initialLanguage();
const listeners = new Set();

function initialLanguage() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (LANGUAGES.includes(saved)) return saved;
  } catch {}
  return 'uk';
}

/** Replace `{0}`, `{1}`, … in `template` with `params`. */
function fill(template, params) {
  return template.replace(/\{(\d+)\}/g, (match, i) => (i < params.length ? String(params[i]) : match));
}

/** @returns {'en' | 'uk'} */
export function getLanguage() {
  return current;
}

/**
 * Switch the interface language, retranslate the page and notify listeners.
 *
 * @param {'en' | 'uk'} lang
 */
export function setLanguage(lang) {
  if (!LANGUAGES.includes(lang)) return;
  current = lang;
  try { localStorage.setItem(STORAGE_KEY, lang); } catch {}
  applyTranslations();
  for (const listener of listeners) listener(lang);
}

/**
 * Call `listener(lang)` after every language switch.
 *
 * @param {(lang: string) => void} listener
 */
export function onLanguageChange(listener) {
  listeners.add(listener);
}

/**
 * UI string for `key` in the current language.
 *
 * @param {string} key
 * @param {...*} params - Values for `{0}`, `{1}`, …
 * @returns {string}
 */
export function t(key, ...params) {
  const template = STRINGS[current][key] ?? STRINGS.en[key] ?? key;
  return fill(template, params);
}

/**
 * Translate every `data-i18n*` element under `root` and the document language.
 *
 * @param {ParentNode} [root=document]
 */
export function applyTranslations(root = document) {
  document.documentElement.lang = current;
  document.title = t('pageTitle');
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const attr of ['title', 'aria-label', 'empty']) {
    for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) {
      const target = attr === 'empty' ? 'data-empty' : attr;
      el.setAttribute(target, t(el.getAttribute(`data-i18n-${attr}`)));
    }
  }
}

// ---------------------------------------------------------------------------
// Error messages
// ---------------------------------------------------------------------------

/**
 * Turn a Rust format string into a regex that matches the messages it
 * produces, capturing each `{}` / `{:?}` value.
 *
 * @param {string} template
 * @returns {RegExp}
 */
export function templateToRegex(template) {
  const source = template.replace(/\{\{|\}\}|\{(?::\?)?\}|[.*+?^$()|[\]\\{}]/g, token => {
    if (token === '{{') return '\\{';
    if (token === '}}') return '\\}';
    if (token === '{}' || token === '{:?}') return '([\\s\\S]*?)';
    return '\\' + token;
  });
  return new RegExp('^' + source + '$');
}

/** Error translations, most specific (longest fixed text) first. */
const errorPatterns = Object.entries(ERROR_MESSAGES_UK)
  .map(([en, uk]) => ({ en, uk, regex: templateToRegex(en), fixedLength: en.replace(/\{(?::\?)?\}/g, '').length }))
  .sort((a, b) => b.fixedLength - a.fixedLength);

/**
 * Translate the parser's own wording inside "ERROR … on line …" messages,
 * e.g. "expected statement or block".
 *
 * @param {string} text
 * @returns {string}
 */
const PARSER_TERMS_UK = {
  document: 'програма', source_file: 'код програми',
  expression: 'вираз', statement: 'команда', block: 'блок',
  global_block: 'блок глобальних змінних', strong_init: 'оголошення змінної',
  forest: 'набір функцій', bracket_block: 'блок у фігурних дужках',
  newline: 'новий рядок', WHITESPACE: 'пробіл',
  fn_arg: 'параметр функції', fn_arg_list: 'список параметрів',
  fn_header: 'заголовок функції', function: 'функція',
  command: 'виклик функції', function_call: 'виклик функції',
  params: 'аргументи', init_statement: 'оголошення або присвоєння',
  initialization: 'присвоєння', const_key: 'ключове слово const',
  if_statement: 'умова if', else_block: 'блок else',
  for_statement: 'цикл for', range: 'діапазон', numVar: 'число або змінна',
  while_statement: 'цикл while', return_statement: 'команда return',
  type_name: 'назва типу', primitive_type: 'простий тип', array_type: 'тип масиву',
  number: 'число', monadicExpr: 'унарний вираз', dyadicExpr: 'бінарний вираз',
  parenth_expr: 'вираз у дужках', box: 'індекс у квадратних дужках',
  noun: 'змінна або елемент масиву', term: 'значення', operator: 'оператор',
  string_literal: 'рядок', array_literal: 'масив', expanded_array_literal: 'розширюваний масив',
  boolean: 'логічне значення', color: 'колір', key: 'клавіша',
  integer: 'ціле число', decimal: 'дробове число', ident: 'назва', COMMENT: 'коментар',
  SOI: 'початок програми', EOI: 'кінець програми',
};

function translateParserDetail(text) {
  return text
    .replace(/^unexpected /, 'неочікуваний елемент: ')
    .replace(/^expected /, 'очікується ')
    .replace(/, or /g, ' або ')
    .replace(/ or /g, ' або ')
    .replace(/\b[A-Za-z_][A-Za-z_0-9]*\b/g, word => PARSER_TERMS_UK[word] ?? word);
}

/**
 * Translate a compiler or runtime error message into the current language.
 * Messages without a translation are returned unchanged.
 *
 * @param {string} message
 * @returns {string}
 */
export function translateError(message) {
  if (current === 'en') return message;
  for (const { en, uk, regex } of errorPatterns) {
    const match = regex.exec(message);
    if (!match) continue;
    const values = match.slice(1);
    if (en === "ERROR {} on line '{}'") values[0] = translateParserDetail(values[0]);
    return fill(uk, values);
  }
  return message;
}

/**
 * Name of an error kind from its `error_code` (1 parse, 2 logic, 3 type, 4 runtime).
 *
 * @param {number} code
 * @returns {string}
 */
export function errorKind(code) {
  return t({ 1: 'syntaxError', 3: 'typeError', 4: 'runtimeError' }[code] ?? 'error');
}
