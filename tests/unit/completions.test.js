/**
 * Tests for the autocompletion data and source in completions.ts.
 */
import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { staticCompletions, declaredNames, quantaCompletionSource } from '../../web/completions.ts';
import { quantaLanguageSupport } from '../../web/quanta-support.ts';

const labels = staticCompletions.map(item => item.label);

function complete(doc, explicit = false) {
  const pos = doc.indexOf('|');
  const state = EditorState.create({
    doc: doc.replace('|', ''),
    extensions: [quantaLanguageSupport],
  });
  return quantaCompletionSource(new CompletionContext(state, pos, explicit));
}

const optionLabels = result => result.options.map(o => o.label);

describe('staticCompletions', () => {
  it('every entry has a non-empty label and a type', () => {
    for (const item of staticCompletions) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(typeof item.type).toBe('string');
    }
  });

  it('has no duplicate labels', () => {
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('offers the control-flow and function templates', () => {
    for (const label of ['if', 'else if', 'for', 'for each', 'while', 'func', 'func main', 'func mouse', 'func keyboard', 'global', 'animation']) {
      expect(labels).toContain(label);
    }
  });

  it('offers drawing calls with argument placeholders', () => {
    for (const label of ['circle', 'rectangle', 'line', 'text', 'setFigureColor']) {
      expect(labels).toContain(label);
    }
  });

  it('only completes colors with their Color:: prefix', () => {
    expect(labels).toContain('Color::Red');
    expect(labels).not.toContain('Red');
  });
});

describe('declaredNames', () => {
  it('finds variables, loop variables, parameters and functions', () => {
    const source = `
global { int score = 0; }
func add(int a, float b) -> int { return a; }
func main() {
    array<int, 3> nums = {1, 2, 3};
    for i in (0..3) {}
    for n in nums {}
}`;
    const names = declaredNames(source).map(c => c.label);
    for (const name of ['score', 'a', 'b', 'add', 'nums', 'i', 'n']) {
      expect(names).toContain(name);
    }
    expect(names).not.toContain('main');
  });
});

describe('quantaCompletionSource', () => {
  it('suggests templates while typing a word', () => {
    const result = complete('func main() {\n    wh|\n}');
    expect(optionLabels(result)).toContain('while');
    expect(result.from).toBe('func main() {\n    '.length);
  });

  it('suggests variables the program declared', () => {
    const result = complete('int score = 0;\nsc|');
    expect(optionLabels(result)).toContain('score');
  });

  it('lists only color names after Color::', () => {
    const result = complete('setFigureColor(Color::Bl|');
    expect(optionLabels(result)).toContain('Blue');
    expect(optionLabels(result)).not.toContain('circle');
    expect(result.from).toBe('setFigureColor(Color::'.length);
  });

  it('lists key names after Key::', () => {
    const result = complete('if (key == Key::|');
    expect(optionLabels(result)).toEqual(expect.arrayContaining(['Space', 'ArrowUp', 'A']));
  });

  it('offers the two-word templates after their first word', () => {
    const result = complete('else i|');
    expect(optionLabels(result)).toContain('else if');
    expect(result.from).toBe(0);
  });

  it('stays quiet inside comments and when nothing is typed', () => {
    expect(complete('// ci|')).toBeNull();
    expect(complete('|')).toBeNull();
    expect(complete('|', true)).not.toBeNull();
  });
});
