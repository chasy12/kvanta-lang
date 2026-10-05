import { t } from './i18n.js';

const FLOAT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const ERROR_KEYS = { int: 'invalidInt', float: 'invalidFloat', bool: 'invalidBool' };

function valid(kind, raw) {
  // Rust str::trim uses Unicode White_Space, which differs from JS trim.
  const text = raw.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
  switch (kind) {
    case 'int': return /^[+-]?\d+$/.test(text) && Number(text) >= -2147483648 && Number(text) <= 2147483647;
    case 'float': return FLOAT.test(text) && Number.isFinite(Math.fround(Number(text)));
    case 'bool': return text === 'true' || text === 'false';
    case 'string': return true;
    default: return false;
  }
}

/** One console form serves concurrent runtime requests in arrival order. */
export function createConsoleInput(host, { onRequest = () => {}, onSubmit = () => {} } = {}) {
  const form = document.createElement('form');
  form.className = 'console__input-form';
  const label = document.createElement('label');
  const caption = document.createElement('span');
  const field = document.createElement('input');
  field.type = 'text';
  field.autocomplete = 'off';
  field.spellcheck = false;
  label.append(caption, field);
  const button = document.createElement('button');
  button.type = 'submit';
  button.className = 'console__submit';
  const error = document.createElement('div');
  error.className = 'console__input-error';
  error.id = `${host.id || 'consoleInput'}Error`;
  field.setAttribute('aria-describedby', error.id);
  error.setAttribute('role', 'alert');
  form.append(label, button, error);
  host.replaceChildren(form);
  host.hidden = true;
  let queue = [];
  let invalid = false;

  function refresh() {
    const pending = queue[0];
    host.hidden = !pending;
    if (!pending) return;
    caption.textContent = t('enterInput', pending.kind);
    button.textContent = t('submitInput');
    field.inputMode = pending.kind === 'int' ? 'numeric' : pending.kind === 'float' ? 'decimal' : 'text';
    field.placeholder = pending.kind === 'bool' ? 'true / false' : '';
    field.setAttribute('aria-invalid', String(invalid));
    error.hidden = !invalid;
    error.textContent = invalid ? t(ERROR_KEYS[pending.kind] ?? 'invalidInput') : '';
  }

  function next() {
    invalid = false;
    field.value = '';
    refresh();
    if (queue.length) {
      onRequest();
      field.focus();
    }
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    const pending = queue[0];
    if (!pending) return;
    const raw = field.value;
    if (!valid(pending.kind, raw)) {
      invalid = true;
      refresh();
      field.focus();
      return;
    }
    queue.shift();
    pending.resolve(raw);
    onSubmit(raw);
    next();
  });

  return {
    request(kind) {
      if (!['int', 'float', 'bool', 'string'].includes(kind)) return Promise.reject(new Error(t('invalidInput')));
      return new Promise(resolve => {
        queue.push({ kind, resolve });
        if (queue.length === 1) next();
      });
    },
    cancel() {
      const cancelled = queue;
      queue = [];
      for (const pending of cancelled) pending.resolve(null);
      next();
    },
    refresh,
  };
}
