import { t } from './i18n.js';

const FLOAT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const ERROR_KEYS = { int: 'invalidInt', float: 'invalidFloat', bool: 'invalidBool' };

function trimInput(raw) {
  return raw.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
}

function valid(kind, raw) {
  // Rust str::trim uses Unicode White_Space, which differs from JS trim.
  const text = trimInput(raw);
  switch (kind) {
    case 'int': return /^[+-]?\d+$/.test(text) && Number(text) >= -2147483648 && Number(text) <= 2147483647;
    case 'float': return FLOAT.test(text) && Number.isFinite(Math.fround(Number(text)));
    case 'bool': return text === 'true' || text === 'false';
    case 'string': return true;
    default: return false;
  }
}

function validation(kinds, raw) {
  if (kinds.length === 1) {
    return valid(kinds[0], raw) ? null : { kind: kinds[0] };
  }
  const text = trimInput(raw);
  const values = text ? text.split(/\p{White_Space}+/u) : [];
  if (values.length !== kinds.length) return { count: values.length };
  const index = kinds.findIndex((kind, index) => !valid(kind, values[index]));
  return index === -1 ? null : { kind: kinds[index], position: index + 1 };
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
  let invalid = null;

  function refresh() {
    const pending = queue[0];
    host.hidden = !pending;
    if (!pending) return;
    const kind = pending.kinds.length === 1 ? pending.kinds[0] : null;
    caption.textContent = kind ? t('enterInput', kind) : t('enterInputs', pending.kinds.length, pending.kinds.join(' '));
    button.textContent = t('submitInput');
    field.inputMode = kind === 'int' ? 'numeric' : kind === 'float' ? 'decimal' : 'text';
    field.placeholder = kind === 'bool' ? 'true / false' : '';
    field.setAttribute('aria-invalid', String(Boolean(invalid)));
    error.hidden = !invalid;
    error.textContent = '';
    if (invalid) {
      if (invalid.count !== undefined) error.textContent = t('inputCount', pending.kinds.length, invalid.count);
      else {
        const message = t(ERROR_KEYS[invalid.kind] ?? 'invalidInput');
        error.textContent = invalid.position ? t('inputValue', invalid.position, message) : message;
      }
    }
  }

  function next() {
    invalid = null;
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
    invalid = validation(pending.kinds, raw);
    if (invalid) {
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
      const kinds = Array.isArray(kind) ? [...kind] : [kind];
      if (!kinds.length || kinds.some(kind => !['int', 'float', 'bool', 'string'].includes(kind)) ||
          (kinds.length > 1 && kinds.includes('string'))) return Promise.reject(new Error(t('invalidInput')));
      return new Promise(resolve => {
        queue.push({ kinds, resolve });
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
