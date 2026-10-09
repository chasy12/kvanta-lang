/**
 * Opening a shared link (`#code=...`) must not overwrite the program saved in
 * this browser unless the user agrees.
 *
 * The load path runs when main.js is imported, so each test sets the URL hash
 * and localStorage first and then imports a fresh copy of the module.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { encodeCode } from '../../web/share-link.js';
import { STRINGS } from '../../web/i18n.js';

vi.mock('../../quanta-lang/pkg/quanta_lang.js', () => ({
  default: vi.fn().mockResolvedValue(undefined),
  Compiler: { new: () => ({ check_code: async () => ({ error_code: 0, get_errors: () => [] }) }) },
}));

const SAVED = 'func main() {\n    print("mine");\n}\n';
const SHARED = 'func main() {\n    print("theirs");\n}\n';

let views = [];
let storage;
let confirmSpy;

/** Import a fresh main.js and return its editor text. */
async function openPage({ saved, hash }) {
  storage = {
    getItem: vi.fn(() => saved ?? null),
    setItem: vi.fn(),
  };
  vi.stubGlobal('localStorage', storage);
  history.replaceState(null, '', '/' + (hash ?? ''));
  vi.resetModules();
  await import('../../web/main.js');
  const view = EditorView.findFromDOM(document.getElementById('editor'));
  views.push(view);
  return view.state.doc.toString();
}

beforeEach(() => {
  confirmSpy = vi.fn(() => true);
  vi.stubGlobal('confirm', confirmSpy);
  confirmSpy = globalThis.confirm;
});

afterEach(() => {
  for (const view of views) view.destroy();
  views = [];
  history.replaceState(null, '', '/');
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('opening a shared link', () => {
  it('asks before replacing a different saved program', async () => {
    await openPage({ saved: SAVED, hash: await encodeCode(SHARED) });
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect([STRINGS.en.confirmOpenShared, STRINGS.uk.confirmOpenShared]).toContain(confirmSpy.mock.calls[0][0]);
  });

  it('opens the shared program when the user agrees', async () => {
    confirmSpy.mockReturnValue(true);
    const text = await openPage({ saved: SAVED, hash: await encodeCode(SHARED) });
    expect(text).toBe(SHARED);
    expect(location.hash).toContain('#code=');
  });

  it('opens the saved program and drops the link when the user declines', async () => {
    confirmSpy.mockReturnValue(false);
    const text = await openPage({ saved: SAVED, hash: await encodeCode(SHARED) });
    expect(text).toBe(SAVED);
    expect(location.hash).toBe('');
  });

  it('never overwrites the saved program when the user declines', async () => {
    confirmSpy.mockReturnValue(false);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await openPage({ saved: SAVED, hash: await encodeCode(SHARED) });
    const view = views.at(-1);
    view.dispatch({ changes: { from: view.state.doc.length, insert: '// edit\n' } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(storage.setItem).toHaveBeenCalledWith('quanta-editor-code', SAVED + '// edit\n');
  });

  it('opens the shared program without asking when nothing is saved', async () => {
    const text = await openPage({ saved: null, hash: await encodeCode(SHARED) });
    expect(text).toBe(SHARED);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('opens the shared program without asking when the saved one is blank', async () => {
    const text = await openPage({ saved: '  \n', hash: await encodeCode(SHARED) });
    expect(text).toBe(SHARED);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('opens the shared program without asking when it matches the saved one apart from trailing whitespace', async () => {
    const text = await openPage({ saved: SAVED + '\n\n  ', hash: await encodeCode(SAVED) });
    expect(text).toBe(SAVED);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('does not ask when the page has no shared link', async () => {
    const text = await openPage({ saved: SAVED });
    expect(text).toBe(SAVED);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('falls back to the saved program for a link that is too large, without asking', async () => {
    const text = await openPage({ saved: SAVED, hash: await encodeCode('a'.repeat(1_000_001)) });
    expect(text).toBe(SAVED);
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});
