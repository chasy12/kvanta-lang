import { describe, expect, it } from 'vitest';
import { parser } from '../../grammar/grammar.js';
import { rawCompletionItems } from '../../web/quanta-support.ts';

describe('text support in the editor', () => {
  it('recognizes string literals and named text options', () => {
    const source = String.raw`text(1,2,"Hello \"world\"",size:20,color:Color::Blue)`;
    const tree = parser.parse(source);
    const nodes = [];
    tree.iterate({ enter(node) { nodes.push({ name: node.name, value: source.slice(node.from, node.to) }); } });
    expect(nodes.filter(node => node.name === 'String').map(node => node.value)).toEqual([String.raw`"Hello \"world\""`]);
    expect(nodes.filter(node => node.name === 'NamedArgument').map(node => node.value)).toEqual(['size:20', 'color:Color::Blue']);
    expect(nodes.filter(node => node.name === '⚠')).toEqual([]);
  });

  it('offers string and text commands in autocomplete', () => {
    const labels = rawCompletionItems.map(item => item.label);
    expect(labels).toEqual(expect.arrayContaining(['string', 'text', 'setTextColor', 'setTextSize', 'setTextFont', 'setTextAlign', 'setTextBold', 'setTextItalic', 'setTextLineHeight']));
  });

  it('recognizes string conversions alongside string declarations', () => {
    const source = 'string label = "Score: " + string(42); text(10, 20, string(7));';
    const nodes = [];
    parser.parse(source).iterate({ enter(node) { nodes.push({ name: node.name, value: source.slice(node.from, node.to) }); } });
    expect(nodes.filter(node => node.name === '⚠')).toEqual([]);
    expect(nodes.filter(node => node.name === 'FuncName').map(node => node.value)).toEqual(['string', 'text', 'string']);
  });
});
