import { describe, expect, it } from 'vitest';
import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { toggleLineComment } from '@codemirror/commands';
import { highlightTree, tagHighlighter, tags } from '@lezer/highlight';
import { parser } from '../../grammar/grammar.js';
import { quanta } from '../../web/quanta-support.ts';

function parseNodes(source) {
  const tree = parser.parse(source);
  const nodes = [];
  tree.iterate({ enter(node) { nodes.push({ name: node.name, value: source.slice(node.from, node.to) }); } });
  expect(nodes.filter(node => node.name === '⚠')).toEqual([]);
  return { tree, nodes };
}

describe('control flow and arrays in the editor', () => {
  it('parses and highlights else if, break and continue in real loop bodies', () => {
    const source = `for i in (0..10) {
      if (i == 2) { continue; }
      else if (i == 5) { break; }
      else if (i > 8) { circle(i, 0, 1); }
      else { circle(0, i, 1); }
    }`;
    const { tree, nodes } = parseNodes(source);
    expect(nodes.filter(node => node.name === 'IfExpression')).toHaveLength(3);
    const highlighted = [];
    highlightTree(tree, tagHighlighter([{ tag: tags.keyword, class: 'keyword' }]),
      (from, to) => highlighted.push(source.slice(from, to)));
    expect(highlighted).toEqual(expect.arrayContaining(['if', 'else', 'break', 'continue', 'for', 'in']));
  });

  it('parses bracket array declarations, initializers and array iteration', () => {
    const source = `int values[2] = {1, 2};
      int grid[2][3] = {{1, 2, 3}, {4, 5, 6}};
      float weights[3];
      bool enabled[2];
      string labels[2];
      color colors[2];
      for value in values { circle(value, len(grid), 10); }
      for row in grid { row[0] = 9; }
      grid[1][2] = len(values);`;
    const { nodes } = parseNodes(source);
    expect(nodes.filter(node => node.name === 'ArrayDimension').map(node => node.value))
      .toEqual(['[2]', '[2]', '[3]', '[3]', '[2]', '[2]', '[2]']);
  });

  it('keeps nested legacy arrays, expansion and text options valid', () => {
    parseNodes(`array<array<int, 3>, 2> grid = {{1, 2, 3}, {4, 5, 6}};
      array<int, 3> values = {0...};
      text(10, 20, "row", color: Color::Blue, size: len(values));`);
  });

  it('parses multidimensional bracket arrays in function parameters', () => {
    const { nodes } = parseNodes(`func sum(int values[2][3]) -> int { return len(values); }`);
    expect(nodes.filter(node => node.name === 'ArrayDimension').map(node => node.value)).toEqual(['[2]', '[3]']);
  });

  it.each(['break', 'continue', 'len', 'for', 'in', 'else', 'array'])('offers %s through language autocomplete', async label => {
    const source = label.slice(0, 2);
    const state = EditorState.create({ doc: source, extensions: [quanta()] });
    const context = new CompletionContext(state, source.length, true);
    const sources = state.languageDataAt('autocomplete', source.length);
    const completions = await Promise.all(sources.map(completion => completion(context)));
    expect(completions.flatMap(result => result?.options ?? []).map(item => item.label)).toContain(label);
  });

  it('declares // as the line comment token', () => {
    const state = EditorState.create({ doc: 'x', extensions: [quanta()] });
    expect(state.languageDataAt('commentTokens', 0)[0]).toEqual({ line: '//' });
  });

  it('toggles a line comment with // and removes it again', () => {
    let state = EditorState.create({ doc: 'circle(1, 2, 3);', extensions: [quanta()] });
    const run = () => toggleLineComment({ state, dispatch: tr => { state = tr.state; } });
    run();
    expect(state.doc.toString()).toBe('// circle(1, 2, 3);');
    run();
    expect(state.doc.toString()).toBe('circle(1, 2, 3);');
  });
});
