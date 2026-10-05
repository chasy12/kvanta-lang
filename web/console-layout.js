import { t } from './i18n.js';

/** Collapse the console, mark hidden output, and resize it within the result pane. */
export function createConsoleLayout({ container, panel, toggle, clear, resize }) {
  const lines = panel.querySelector('[role="log"]');
  let open = true;
  let activity = '';
  let height = null;
  let drag = null;

  function bounds() {
    const available = container.getBoundingClientRect().height;
    const max = Math.round(available * 0.7);
    return { available, min: Math.min(panel.querySelector('#consoleInput:not([hidden])') ? 160 : 96, max), max };
  }

  function setHeight(value) {
    const { available, min, max } = bounds();
    if (!available) return;
    height = Math.max(min, Math.min(max, Math.round(value)));
    panel.style.setProperty('--console-height', `${height}px`);
    resize.setAttribute('aria-valuemin', String(min));
    resize.setAttribute('aria-valuemax', String(max));
    resize.setAttribute('aria-valuenow', String(height));
  }

  function refresh() {
    panel.classList.toggle('console--closed', !open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.dataset.activity = activity;
    const label = t(open ? 'closeConsole' : 'openConsole');
    toggle.setAttribute('aria-label', activity ? `${label}, ${t(activity === 'error' ? 'newErrors' : 'newOutput')}` : label);
    toggle.title = label;
    resize.setAttribute('aria-label', t('resizeConsole'));
    resize.hidden = !open;
    clear.hidden = !open;
    if (lines) lines.hidden = !open;
    setHeight(height ?? bounds().available * 0.32);
  }

  toggle.addEventListener('click', () => {
    open = !open;
    drag = null;
    const revealLatest = open && activity !== '';
    if (open) activity = '';
    refresh();
    if (revealLatest && lines) lines.scrollTop = lines.scrollHeight;
  });

  resize.addEventListener('keydown', event => {
    if (!open) return;
    const { available, min, max } = bounds();
    const current = height ?? available * 0.32;
    const value = { ArrowUp: current + 20, ArrowDown: current - 20, Home: min, End: max }[event.key];
    if (value === undefined) return;
    event.preventDefault();
    setHeight(value);
  });

  resize.addEventListener('pointerdown', event => {
    if (!open || event.button !== 0) return;
    event.preventDefault();
    resize.focus();
    drag = { id: event.pointerId, y: event.clientY, height: height ?? bounds().available * 0.32 };
    resize.setPointerCapture?.(event.pointerId);
  });
  resize.addEventListener('pointermove', event => {
    if (drag?.id !== event.pointerId) return;
    setHeight(drag.height + drag.y - event.clientY);
  });
  function endDrag(event) {
    if (drag?.id !== event.pointerId) return;
    drag = null;
    if (resize.hasPointerCapture?.(event.pointerId)) resize.releasePointerCapture(event.pointerId);
  }
  resize.addEventListener('pointerup', endDrag);
  resize.addEventListener('pointercancel', endDrag);
  resize.addEventListener('lostpointercapture', () => { drag = null; });
  new ResizeObserver(refresh).observe(container);
  refresh();

  return {
    reveal() {
      open = true;
      activity = '';
      refresh();
      if (lines) lines.scrollTop = lines.scrollHeight;
    },
    notify(kind) {
      if (open || activity === kind || activity === 'error') return;
      activity = kind;
      refresh();
    },
    reset() { activity = ''; refresh(); },
    refresh,
  };
}
