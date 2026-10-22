import {
  snippetCompletion, startCompletion,
  type Completion, type CompletionContext, type CompletionResult,
} from "@codemirror/autocomplete"
import {syntaxTree} from "@codemirror/language"
import {getLanguage} from "./i18n.js"

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
  {label: "break", type: "keyword"},
  {label: "continue", type: "keyword"},
  {label: "return", type: "keyword"},
  {label: "true", type: "keyword"},
  {label: "false", type: "keyword"},
  {label: "bool", type: "type"},
  {label: "int", type: "type"},
  {label: "float", type: "type"},
  {label: "string", type: "type"},
  {label: "color", type: "type"},
  {label: "array", type: "type"},
]

// Typing `Color` or `Key` continues with `::` and opens the list of names.
const NAMESPACES: Completion[] = ["Color", "Key"].map(name => ({
  label: name,
  type: "namespace",
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
  call("circle", "circle(${x}, ${y}, ${r})"),
  call("rectangle", "rectangle(${x1}, ${y1}, ${x2}, ${y2})"),
  call("line", "line(${x1}, ${y1}, ${x2}, ${y2})"),
  call("arc", "arc(${x}, ${y}, ${r}, ${a1}, ${a2})"),
  call("polygon", "polygon(${x1}, ${y1}, ${x2}, ${y2}, ${x3}, ${y3})"),
  call("text", "text(${x}, ${y}, ${\"Hello\"})"),
  call("setFigureColor", "setFigureColor(Color::${Red})"),
  call("setLineColor", "setLineColor(Color::${Black})"),
  call("setLineWidth", "setLineWidth(${3})"),
  call("setTextColor", "setTextColor(Color::${White})"),
  call("setTextSize", "setTextSize(${24})"),
  call("setTextFont", "setTextFont(\"${system-ui}\")"),
  call("setTextAlign", "setTextAlign(\"${center}\")"),
  call("setTextBold", "setTextBold(${true})"),
  call("setTextItalic", "setTextItalic(${true})"),
  call("setTextLineHeight", "setTextLineHeight(${1.2})"),
  call("setFps", "setFps(${30})"),
  call("sleep", "sleep(${1000})"),
  call("print", "print(${\"Hello\"})"),
  call("read", "read(${x})"),
  call("input", "input()"),
  call("len", "len(${arr})"),
  call("rgb", "rgb(${r}, ${g}, ${b})"),
  call("abs", "abs(${x})"),
  call("round", "round(${x})"),
  call("ceil", "ceil(${x})"),
  call("floor", "floor(${x})"),
  call("sqrt", "sqrt(${x})"),
  call("decimal", "decimal(${x})"),
  call("random", "random(${1}, ${10})"),
  call("animate", "animate()"),
  call("frame", "frame()"),
  call("clear", "clear()"),
]

function call(name: string, template: string): Completion {
  return snippetCompletion(template, {label: name, type: "function"})
}

function block(label: string, template: string, boost = 0): Completion {
  return snippetCompletion(template, {label, type: "text", boost})
}

// Blocks to build programs from: each field is a Tab stop.
const BLOCKS: Completion[] = [
  block("if", "if (${x > 0}) {\n    ${}\n}", 2),
  block("else", "else {\n    ${}\n}", 2),
  block("else if", "else if (${x > 0}) {\n    ${}\n}"),
  block("for", "for ${i} in (${0}..${10}) {\n    ${}\n}", 2),
  block("for each", "for ${v} in ${arr} {\n    ${}\n}"),
  block("while", "while (${x < 10}) {\n    ${}\n}", 2),
  block("while true", "while (true) {\n    ${}\n}"),
  block("func", "func ${f}(${}) {\n    ${}\n}", 2),
  block("func main", "func main() {\n    ${}\n}"),
  block("func result", "func ${f}(${int a}) -> ${int} {\n    return ${};\n}"),
  block("func mouse", "func mouse(int x, int y) {\n    ${}\n}"),
  block("func keyboard", "func keyboard(int key) {\n    if (key == Key::${Space}) {\n        ${}\n    }\n}"),
  block("global", "global {\n    ${int score = 0;}\n}", 1),
  block("animation", "animate();\nsetFps(${30});\nwhile (true) {\n    clear();\n    ${}\n    frame();\n}"),
  block("int variable", "int ${x} = ${0};"),
  block("float variable", "float ${x} = ${0.0};"),
  block("string variable", "string ${x} = \"${abc}\";"),
  block("bool variable", "bool ${x} = ${true};"),
  block("color variable", "color ${x} = Color::${Red};"),
  block("array variable", "array<int, ${3}> ${x} = {${1, 2, 3}};"),
]

export const staticCompletions: Completion[] = [
  ...BLOCKS, ...CALLS, ...KEYWORDS, ...NAMESPACES, ...COLORS,
]


// One short phrase per entry, in the interface language: [en, uk].
const HINTS: Record<string, [string, string]> = {
  "if": ["if", "якщо"],
  "else": ["otherwise", "інакше"],
  "else if": ["or if", "або якщо"],
  "for": ["repeat", "повторити"],
  "for each": ["each item", "кожен елемент"],
  "while": ["while true", "поки правда"],
  "while true": ["forever", "завжди"],
  "func": ["function", "функція"],
  "func main": ["start", "початок"],
  "func result": ["with result", "з результатом"],
  "func mouse": ["on click", "клік мишею"],
  "func keyboard": ["on key", "натискання клавіші"],
  "global": ["shared", "спільні змінні"],
  "animation": ["animation", "анімація"],
  "int variable": ["integer", "ціле число"],
  "float variable": ["decimal", "дробове число"],
  "string variable": ["text", "текст"],
  "bool variable": ["yes / no", "так / ні"],
  "color variable": ["color", "колір"],
  "array variable": ["list", "список"],
  "circle": ["circle", "коло"],
  "rectangle": ["rectangle", "прямокутник"],
  "line": ["line", "лінія"],
  "arc": ["arc", "дуга"],
  "polygon": ["polygon", "многокутник"],
  "text": ["write text", "написати текст"],
  "setFigureColor": ["fill color", "колір заливки"],
  "setLineColor": ["line color", "колір лінії"],
  "setLineWidth": ["line width", "товщина лінії"],
  "setFps": ["speed", "швидкість"],
  "sleep": ["wait, ms", "пауза, мс"],
  "print": ["to console", "в консоль"],
  "read": ["ask", "запитати"],
  "len": ["length", "довжина"],
  "rgb": ["own color", "свій колір"],
  "random": ["random", "випадкове"],
  "animate": ["animation", "анімація"],
  "frame": ["next frame", "наступний кадр"],
  "clear": ["clear", "очистити"],
}

function localized(options: readonly Completion[]): Completion[] {
  const index = getLanguage() === "uk" ? 1 : 0
  return options.map(option => {
    const hint = HINTS[option.label]
    return hint ? {...option, detail: hint[index]} : option
  })
}

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
    return {from: phrase.from, options: localized(BLOCKS.filter(b => b.label.includes(" "))), validFor: /^[\w ]*$/}
  }

  const word = context.matchBefore(/\w+/)
  if (!word && !context.explicit) return null
  return {
    from: word ? word.from : context.pos,
    options: [...declaredNames(context.state.doc.toString()), ...localized(staticCompletions)],
    validFor: /^\w*$/,
  }
}
