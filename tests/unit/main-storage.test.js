import { it, expect, vi } from 'vitest';
import { EditorView } from '@codemirror/view';

vi.mock('../../quanta-lang/pkg/quanta_lang.js', () => ({
  default: vi.fn().mockResolvedValue(undefined),
  Compiler: { new: () => ({ check_code: async () => ({ error_code: 0, get_errors: () => [] }) }) },
}));

it('starts the editor and switches language when storage is blocked', async () => {
  const storage = {
    getItem: vi.fn(() => { throw new DOMException('Blocked', 'SecurityError'); }),
    setItem: vi.fn(() => { throw new DOMException('Blocked', 'SecurityError'); }),
  };
  vi.stubGlobal('localStorage', storage);
  vi.spyOn(navigator, 'language', 'get').mockReturnValue('uk-UA');
  document.getElementById('runBtn').dataset.i18n = 'run';
  let view;
  try {
    await import('../../web/main.js');
    view = EditorView.findFromDOM(document.getElementById('editor'));
    expect(view).toBeTruthy();
    expect(view.state.doc.length).toBeGreaterThan(0);
    expect(document.getElementById('runBtn').textContent).toBe('Запустити програму!');
    document.querySelector('[data-lang="en"]').click();
    expect(document.getElementById('runBtn').textContent).toBe('Run your program!');
    vi.useFakeTimers();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'print(1);' } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(storage.setItem).toHaveBeenCalledWith('quanta-editor-code', 'print(1);');

  } finally {
    view?.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
