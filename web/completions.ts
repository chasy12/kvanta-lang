import {
  snippetCompletion, startCompletion,
  type Completion, type CompletionContext, type CompletionResult,
} from "@codemirror/autocomplete"
import {syntaxTree} from "@codemirror/language"

const COLOR_NAMES = [
  "Red", "DarkRed", "LightRed",
  "Green", "DarkGreen", "LightGreen",
  "Blue", "DarkBlue", "LightBlue",
  "Yellow", "DarkYellow", "LightYellow",
  "Orange", "DarkOrange", "LightOrange",
  "Pink", "LightPink", "HotPink",
  "Purple", "Violet", "DarkViolet", "LightViolet",
  "Brown", "DarkBrown", "LightBrown",
  "Cyan", "DarkCyan", "LightCyan",
  "Black", "Gray", "DarkGray", "LightGray", "White",
  "Background", "Transparent", "Random",
]

const KEY_NAMES = [
  "Space", "Enter", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ",
]

const KEYWORDS: Completion[] = [
  {label: "in", type: "keyword"},
  {label: "break", type: "keyword", info: "break; exits the innermost loop"},
  {label: "continue", type: "keyword", info: "continue; starts the next iteration of the innermost loop"},
  {label: "return", type: "keyword"},
  {label: "true", type: "keyword"},
  {label: "false", type: "keyword"},
  {label: "bool", type: "type"},
  {label: "int", type: "type"},
  {label: "float", type: "type"},
  {label: "string", type: "type", info: "Declare a string variable, or use string(value) to convert a value to text."},
  {label: "color", type: "type"},
  {label: "array", type: "type", info: "array<int, 2> values = {1, 2}; or int values[2];"},
]

// Typing `Color` or `Key` continues with `::` and opens the list of names.
const NAMESPACES: Completion[] = ["Color", "Key"].map(name => ({
  label: name,
  type: "namespace",
  detail: "…::",
  apply: (view, _completion, from, to) => {
    view.dispatch({
      changes: {from, to, insert: `${name}::`},
      selection: {anchor: from + name.length + 2},
      userEvent: "input.complete",
    })
    startCompletion(view)
  },
}))

const COLORS: Completion[] = COLOR_NAMES.map(name => ({label: `Color::${name}`, type: "constant"}))

// Calls whose arguments the child fills in with Tab.
const CALLS: Completion[] = [
  call("circle", "circle(${x}, ${y}, ${radius})", "x, y, radius"),
  call("rectangle", "rectangle(${x1}, ${y1}, ${x2}, ${y2})", "x1, y1, x2, y2"),
  call("line", "line(${x1}, ${y1}, ${x2}, ${y2})", "x1, y1, x2, y2"),
  call("arc", "arc(${x}, ${y}, ${radius}, ${from}, ${to})", "x, y, radius, from, to"),
  call("polygon", "polygon(${x1}, ${y1}, ${x2}, ${y2}, ${x3}, ${y3})", "3 or more points"),
  call("text", "text(${x}, ${y}, ${\"Hello\"})", "x, y, content"),
  call("setFigureColor", "setFigureColor(Color::${Red})", "fill color"),
  call("setLineColor", "setLineColor(Color::${Black})", "outline color"),
  call("setLineWidth", "setLineWidth(${3})", "outline width"),
  call("setTextColor", "setTextColor(Color::${White})"),
  call("setTextSize", "setTextSize(${24})"),
  call("setTextFont", "setTextFont(\"${system-ui}\")"),
  call("setTextAlign", "setTextAlign(\"${center}\")", "left, center or right"),
  call("setTextBold", "setTextBold(${true})"),
  call("setTextItalic", "setTextItalic(${true})"),
  call("setTextLineHeight", "setTextLineHeight(${1.2})"),
  call("setFps", "setFps(${30})", "frames per second"),
  call("sleep", "sleep(${1000})", "milliseconds"),
  call("print", "print(${\"Hello\"})"),
  call("read", "read(${variable})", "read a value from the console"),
  call("input", "input()"),
  call("len", "len(${array})", "number of elements"),
  call("rgb", "rgb(${r}, ${g}, ${b})", "0–255 each"),
  call("abs", "abs(${x})"),
  call("round", "round(${x})"),
  call("ceil", "ceil(${x})"),
  call("floor", "floor(${x})"),
  call("sqrt", "sqrt(${x})"),
  call("decimal", "decimal(${x})", "int to float"),
  call("random", "random(${1}, ${10})", "random int from a to b"),
  call("animate", "animate()", "start animation mode"),
  call("frame", "frame()", "show the frame and wait for the next"),
  call("clear", "clear()", "clear the canvas"),
]

function call(name: string, template: string, detail = ""): Completion {
  return snippetCompletion(template, {label: name, type: "function", detail})
}

function block(label: string, template: string, detail: string, boost = 0): Completion {
  return snippetCompletion(template, {label, type: "text", detail, boost})
}

// Blocks to build programs from: each field is a Tab stop.
const BLOCKS: Completion[] = [
  block("if", "if (${condition}) {\n    ${}\n}", "if block", 2),
  block("else", "else {\n    ${}\n}", "else block", 2),
  block("else if", "else if (${condition}) {\n    ${}\n}", "else if block"),
  block("for", "for ${i} in (${0}..${10}) {\n    ${}\n}", "repeat a number of times", 2),
  block("for each", "for ${item} in ${values} {\n    ${}\n}", "go through an array"),
  block("while", "while (${condition}) {\n    ${}\n}", "repeat while true", 2),
  block("while true", "while (true) {\n    ${}\n}", "repeat forever"),
  block("func", "func ${name}(${}) {\n    ${}\n}", "function", 2),
  block("func main", "func main() {\n    ${}\n}", "program start"),
  block("func result", "func ${name}(${int a}) -> ${int} {\n    return ${};\n}", "function with a result"),
  block("func mouse", "func mouse(int x, int y) {\n    ${}\n}", "on mouse click"),
  block("func keyboard", "func keyboard(int key) {\n    if (key == Key::${Space}) {\n        ${}\n    }\n}", "on key press"),
  block("global", "global {\n    ${int score = 0;}\n}", "variables for all functions", 1),
  block("animation", "animate();\nsetFps(${30});\nwhile (true) {\n    clear();\n    ${}\n    frame();\n}", "animation loop"),
  block("int variable", "int ${name} = ${0};", "whole number"),
  block("float variable", "float ${name} = ${0.0};", "decimal number"),
  block("string variable", "string ${name} = \"${text}\";", "text"),
  block("bool variable", "bool ${name} = ${true};", "true or false"),
  block("color variable", "color ${name} = Color::${Red};", "color"),
  block("array variable", "array<int, ${3}> ${name} = {${1, 2, 3}};", "list of values"),
]

export const staticCompletions: Completion[] = [
  ...BLOCKS, ...CALLS, ...KEYWORDS, ...NAMESPACES, ...COLORS,
]

const TYPE_WORDS = "int|float|bool|string|color"
const DECLARATION = new RegExp(`\\b(?:${TYPE_WORDS})\\s+([A-Za-z_]\\w*)|\\barray<[^>]*>\\s+([A-Za-z_]\\w*)|\\bfor\\s+([A-Za-z_]\\w*)\\s+in\\b`, "g")
const FUNCTION = /\bfunc\s+([A-Za-z_]\w*)\s*\(/g
const PARAMETER = new RegExp(`(?:\\(|,)\\s*(?:${TYPE_WORDS}|array<[^>]*>)\\s+([A-Za-z_]\\w*)`, "g")
const RESERVED = new Set(["main", "mouse", "keyboard"])

/** Names the child already declared, so they can be completed instead of retyped. */
export function declaredNames(source: string): Completion[] {
  const names = new Map<string, Completion>()
  for (const match of source.matchAll(DECLARATION)) {
    const name = match[1] ?? match[2] ?? match[3]
    names.set(name, {label: name, type: "variable", boost: 3})
  }
  for (const match of source.matchAll(PARAMETER)) {
    names.set(match[1], {label: match[1], type: "variable", boost: 3})
  }
  for (const match of source.matchAll(FUNCTION)) {
    if (RESERVED.has(match[1])) continue
    names.set(match[1], snippetCompletion(`${match[1]}(\${})`, {label: match[1], type: "function", boost: 3}))
  }
  return [...names.values()]
}

function insideCommentOrString(context: CompletionContext): boolean {
  const line = context.state.doc.lineAt(context.pos)
  const before = line.text.slice(0, context.pos - line.from)
  if (/\/\//.test(before)) return true
  const node = syntaxTree(context.state).resolveInner(context.pos, -1)
  return node.name === "LineComment" || node.name === "String"
}

export function quantaCompletionSource(context: CompletionContext): CompletionResult | null {
  if (insideCommentOrString(context)) return null

  const member = context.matchBefore(/\b(Color|Key)::\w*/)
  if (member) {
    const split = member.text.indexOf("::") + 2
    const names = member.text.startsWith("Color") ? COLOR_NAMES : KEY_NAMES
    return {
      from: member.from + split,
      options: names.map(name => ({label: name, type: "constant"})),
      validFor: /^\w*$/,
    }
  }

  const phrase = context.matchBefore(/\b(?:else|for|while|func|int|float|string|bool|color|array) \w*/)
  if (phrase) {
    return {from: phrase.from, options: BLOCKS.filter(b => b.label.includes(" ")), validFor: /^[\w ]*$/}
  }

  const word = context.matchBefore(/\w+/)
  if (!word && !context.explicit) return null
  return {
    from: word ? word.from : context.pos,
    options: [...declaredNames(context.state.doc.toString()), ...staticCompletions],
    validFor: /^\w*$/,
  }
}
