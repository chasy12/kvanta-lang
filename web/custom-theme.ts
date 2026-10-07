import {createTheme} from 'thememirror';
import {tags as t} from '@lezer/highlight';

export const quantaTheme = createTheme({
	variant: 'dark',
	settings: {
		background: 'var(--editor-bg)',
		foreground: 'var(--text)',
		caret: 'var(--focus)',
		selection: 'var(--editor-selection)',
		lineHighlight: 'var(--editor-active-line)',
		gutterBackground: 'var(--editor-bg)',
		gutterForeground: 'var(--muted)',
	},
	styles: [
		{
			tag: t.comment,
			color: 'var(--syntax-comment)',
		},
		{
			tag: t.variableName,
			color: 'var(--syntax-variable)',
		},
		{
			tag: [t.string, t.special(t.brace)],
			color: 'var(--syntax-value)',
		},
		{
			tag: t.number,
			color: 'var(--syntax-value)',
		},
		{
			tag: t.bool,
			color: 'var(--syntax-value)',
		},
		{
			tag: t.null,
			color: 'var(--syntax-keyword)',
		},
		{
			tag: t.keyword,
			color: 'var(--syntax-keyword)',
		},
        {
            tag: t.function(t.variableName),
            color: 'var(--syntax-function)',
        },
        {
            tag: t.paren,
            color: 'var(--syntax-bracket)',
        },
		{
			tag: t.operator,
			color: 'var(--syntax-operator)',
		},
		{
			tag: t.moduleKeyword,
			color: 'var(--syntax-function)',
		},
		{
			tag: t.definition(t.typeName),
			color: 'var(--syntax-function)',
		},
		{
			tag: t.typeName,
			color: 'var(--syntax-keyword)',
		},
        {
			tag: t.definitionKeyword,
			color: 'var(--syntax-keyword)',
		},
		{
			tag: t.angleBracket,
			color: 'var(--syntax-bracket)',
		},
		{
			tag: t.tagName,
			color: 'var(--syntax-variable)',
		},
		{
			tag: t.attributeName,
			color: 'var(--syntax-variable)',
		},
	],
});