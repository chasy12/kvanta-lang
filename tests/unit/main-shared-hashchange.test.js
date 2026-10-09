/**
 * Pasting a share link into an already open tab (hashchange) must not replace
 * the editor's program unless the user agrees.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { encodeCode } from '../../web/share-link.js';
import { STRINGS } from '../../web/i18n.js';

vi.mock('../../quanta-lang/pkg/quanta_lang.js', () => ({
  default: vi.fn().mockResolvedValue(undefined),
  Compiler: { new: () => ({ check_code: async () => ({ error_code: 0, get_errors: () => [] }) }) },
}));

const MINE = 'func main() {\n    print("mine");\n}\n';
const SHARED = 'func main() {\n    print("theirs");\n}\n';

let view;
let confirmSpy;

/** Make the address bar carry `hash` and let main.js react to it. */
async function pasteLink(hash) {
  history.replaceState(null, '', '/' + hash);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  // decodeCode is asynchronous.
  await new Promise(resolve => setTimeout(resolve, 50));
}

function setEditor(text) {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}

beforeEach(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
  confirmSpy = vi.fn(() => true);
  vi.stubGlobal('confirm', confirmSpy);
  history.replaceState(null, '', '/');
  await import('../../web/main.js');
  view = EditorView.findFromDOM(document.getElementById('editor'));
});

afterEach(() => {
  history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
});

describe('pasting a share link into an open tab', () => {
  it('asks before replacing a different program', async () => {
    setEditor(MINE);
    await pasteLink(await encodeCode(SHARED));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect([STRINGS.en.confirmOpenShared, STRINGS.uk.confirmOpenShared]).toContain(confirmSpy.mock.calls[0][0]);
  });

  it('replaces the program when the user agrees', async () => {
    setEditor(MINE);
    confirmSpy.mockReturnValue(true);
    await pasteLink(await encodeCode(SHARED));
    expect(view.state.doc.toString()).toBe(SHARED);
  });

  it('leaves the editor alone and drops the link when the user declines', async () => {
    setEditor(MINE);
    confirmSpy.mockReturnValue(false);
    await pasteLink(await encodeCode(SHARED));
    expect(view.state.doc.toString()).toBe(MINE);
    expect(location.hash).toBe('');
  });

  it('does not ask when the editor is empty', async () => {
    setEditor('  \n');
    await pasteLink(await encodeCode(SHARED));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe(SHARED);
  });

  it('does not ask when the editor already holds that program', async () => {
    setEditor(SHARED + '\n');
    await pasteLink(await encodeCode(SHARED));
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('ignores a link that holds no program', async () => {
    setEditor(MINE);
    await pasteLink('#code=not*valid');
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe(MINE);
  });
});
