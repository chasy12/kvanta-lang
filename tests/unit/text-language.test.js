import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import initWasm, { Compiler } from '../../quanta-lang/pkg/quanta_lang.js';
import { cancelNow, drawCommands, setPrintHandler } from '../../web/canvas-runtime.js';

const ctx = globalThis.__mockBufferCtx;
let drawn;

beforeAll(async () => {
  await initWasm({ module_or_path: readFileSync('quanta-lang/pkg/quanta_lang_bg.wasm') });
});

beforeEach(() => {
  cancelNow(false);
  drawn = [];
  ctx.fillText = vi.fn((content, x, y) => {
    drawn.push({ content, x, y, color: ctx.fillStyle, font: ctx.font, align: ctx.textAlign, baseline: ctx.textBaseline });
  });
});

async function compile(source) {
  const compiler = Compiler.new();
  try {
    return await compiler.compile_code(source);
  } finally {
    compiler.free();
  }
}

async function run(source) {
  const result = await compile(source);
  expect(result.error_code, result.error_code ? result.get_error_message() : "").toBe(0);
  const runtime = result.get_runtime();
  result.free();
  try {
    runtime.set_renderer(drawCommands);
    await runtime.execute();
    const error = runtime.get_runtime_error();
    try {
      expect(error.error_code, error.get_error_message()).toBe(0);
    } finally {
      error.free();
    }
    return drawn;
  } finally {
    runtime.stop();
    runtime.free();
  }
}

describe('strings and canvas text through the WASM interpreter', () => {
  it('draws Unicode text using the initial defaults', async () => {
    await run('string message = "Привіт 🌍"; text(100, 200, message);');
    expect(drawn).toEqual([{ content: 'Привіт 🌍', x: 100, y: 200, color: '#ffffffff', font: 'normal normal 24px system-ui', align: 'left', baseline: 'top' }]);
  });

  it('concatenates and compares strings in user functions and string arrays', async () => {
    await run(`
      global { string greeting = "Hello"; }
      func label(string name) -> string { return greeting + ", " + name; }
      func main() {
        array<string, 2> names = {"Kvanta", "world"};
        string message = label(names[0]);
        if (message == "Hello, Kvanta" && names[1] != "Kvanta") {
          text(10, 20, message);
        }
        message = "Changed";
        names[1] = message;
        text(10, 50, names[1]);
      }
    `);
    expect(drawn.map(item => item.content)).toEqual(['Hello, Kvanta', 'Changed']);
  });

  it('decodes quotes, backslashes, tabs and newlines without treating string contents as comments', async () => {
    await run(String.raw`text(10, 20, "\"Привіт\" \\ //\tworld\nNext");`);
    expect(drawn.map(item => item.content)).toEqual(['"Привіт" \\ //\tworld', 'Next']);
    expect(drawn[0].y).toBe(20);
    expect(drawn[1].y).toBeCloseTo(48.8);
  });

  it('keeps setter defaults after a draw with partial named overrides', async () => {
    await run(`
      setTextColor(Color::Blue);
      setTextSize(40);
      setTextAlign("center");
      setTextBold(true);
      text(500, 100, "Default");
      text(500, 200, "Override", bold: false, color: Color::Red, size: 20);
      text(500, 300, "Default again");
    `);
    expect(drawn.map(({ color, font, align }) => ({ color, font, align }))).toEqual([
      { color: '#2e73e6ff', font: 'normal bold 40px system-ui', align: 'center' },
      { color: '#e92331ff', font: 'normal normal 20px system-ui', align: 'center' },
      { color: '#2e73e6ff', font: 'normal bold 40px system-ui', align: 'center' },
    ]);
  });

  it('sets fonts, italics and line spacing and accepts expression overrides', async () => {
    await run(`
      setTextFont("monospace");
      setTextItalic(true);
      setTextLineHeight(1.5);
      int size = 20;
      text(10, 30, "One\\nTwo", size: size * 2, align: "right");
      text(10, 200, "Three\\nFour", font: "serif", italic: false, lineHeight: 2.0);
    `);
    expect(drawn.map(({ content, y, font, align }) => ({ content, y, font, align }))).toEqual([
      { content: 'One', y: 30, font: 'italic normal 40px monospace', align: 'right' },
      { content: 'Two', y: 90, font: 'italic normal 40px monospace', align: 'right' },
      { content: 'Three', y: 200, font: 'normal normal 24px serif', align: 'left' },
      { content: 'Four', y: 248, font: 'normal normal 24px serif', align: 'left' },
    ]);
  });

  it('shares defaults across functions and preserves them across frame flushes', async () => {
    vi.stubGlobal('requestAnimationFrame', callback => setTimeout(() => callback(performance.now()), 0));
    try {
      await run(`
        func configure() { setTextSize(36); setTextColor(Color::Green); }
        func main() {
          configure(); animate(); setFps(0);
          text(1, 2, "Frame one", size: 18); frame();
          clear(); text(1, 2, "Frame two"); frame();
        }
      `);
      expect(drawn.map(({ content, color, font }) => ({ content, color, font }))).toEqual([
        { content: 'Frame one', color: '#7eb786ff', font: 'normal normal 18px system-ui' },
        { content: 'Frame two', color: '#7eb786ff', font: 'normal normal 36px system-ui' },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('starts each program with fresh text defaults', async () => {
    await run('setTextSize(80); setTextBold(true); text(1, 2, "First");');
    await run('text(1, 2, "Second");');
    expect(drawn.at(-1).font).toBe('normal normal 24px system-ui');
  });

  it.each([
    ['42', '42'],
    ['-7', '-7'],
    ['3.5', '3.5'],
    ['true', 'true'],
    ['false', 'false'],
    ['Color::Blue', 'color(46, 115, 230, 255)'],
    ['{1, 2, 3}', '{1, 2, 3}'],
    ['{{1, 2}, {3, 4}}', '{{1, 2}, {3, 4}}'],
    ['{"hello", "world"}', '{"hello", "world"}'],
    ['{}', '{}'],
    ['"Привіт 🌍"', 'Привіт 🌍'],
    ['""', ''],
  ])('formats %s consistently in text() and string()', async (value, expected) => {
    await run(`text(10, 20, ${value}); text(10, 50, string(${value}));`);
    expect(drawn.map(item => item.content)).toEqual([expected, expected]);
  });

  it('builds labels with explicit conversion while keeping numbers numeric', async () => {
    await run(`
      int score = 42;
      string label = "Score: " + string(score);
      text(10, 20, score, color: Color::Blue, size: 40);
      text(10, 60, label);
      score = score + 1;
      text(10, 100, score);
    `);
    expect(drawn.map(item => item.content)).toEqual(['42', 'Score: 42', '43']);
    expect(drawn[0].color).toBe('#2e73e6ff');
    expect(drawn[0].font).toBe('normal normal 40px system-ui');
  });

  it('converts indexed values and user function results', async () => {
    await run(`
      global { string label = string(42); }
      func number() -> int { return 7; }
      func converted(int value) -> string { return string(value); }
      func main() {
        int values[2] = {10, 20};
        text(10, 20, "Value: " + string(values[1] + number()));
        text(10, 60, converted(number()));
        text(10, 100, label);
      }
    `);
    expect(drawn.map(item => item.content)).toEqual(['Value: 27', '7', '42']);
  });

  it('prints variables with the same display formatting and preserves string whitespace', async () => {
    const output = vi.fn();
    setPrintHandler(output);
    try {
      await run('string name = "Artem"; int score = 42; print("Score:", score, name, true, {1, 2}); print("  hello  ");');
      expect(output.mock.calls).toEqual([
        ['Score: 42 Artem true {1, 2}'],
        ['  hello  '],
      ]);
    } finally {
      setPrintHandler(text => console.log(text));
    }
  });

  it('formats expanded arrays after their declared size has materialized the values', async () => {
    await run('int values[2] = {42...}; text(10, 20, values); text(10, 50, string(values));');
    expect(drawn.map(item => item.content)).toEqual(['{42, 42}', '{42, 42}']);
  });

  it.each([
    ['text("1", 2, 3);', 'int'],
    ['text(1, 2, "a", colour: Color::Red);', 'colour'],
    ['text(1, 2, "a", size: 20, size: 30);', 'size'],
    ['text(1, 2, "a", bold: 1);', 'bool'],
    ['text(1, 2, "a", size: 20, 30);', 'positional'],
    ['circle(1, 2, 3, size: 20);', 'named'],
    ['string a = "a" + 1;', 'string'],
    ['string a = 42;', 'string'],
    ['int a = string(42);', 'int'],
    ['string();', '1 argument'],
    ['string a = string();', '1 argument'],
    ['string a = string(1, 2);', '1 argument'],
    ['text(1, 2, string(missing));', 'missing'],
    ['print("Score: " + 42);', 'string'],
    ['print(missing);', 'missing'],
    ['text(1, 2, {42...});', 'size'],
    ['text(1, 2, {{42...}});', 'size'],
    ['string a = string({42...});', 'size'],
    ['print({42...});', 'size'],
    ['bool b = "a" < "b";', 'string'],
    [String.raw`string a = "\q";`, 'escape'],
  ])('rejects invalid syntax or types in %s', async (source, message) => {
    const result = await compile(source);
    try {
      expect(result.error_code).not.toBe(0);
      expect(result.get_error_message().toLowerCase()).toContain(message);
    } finally {
      result.free();
    }
  });

  it.each([
    ['setTextSize(0);', 'size'],
    ['text(1, 2, "a", size: -1);', 'size'],
    ['setTextAlign("middle");', 'align'],
    ['text(1, 2, "a", align: "invalid");', 'align'],
    ['setTextFont("");', 'font'],
    ['setTextLineHeight(0.0);', 'lineHeight'],
    ['text(1, 2, "a", lineHeight: -1.0);', 'lineHeight'],
  ])('reports invalid option values in %s', async (source, message) => {
    const result = await compile(source);
    expect(result.error_code, result.error_code ? result.get_error_message() : "").toBe(0);
    const runtime = result.get_runtime();
    result.free();
    try {
      await runtime.execute();
      const error = runtime.get_runtime_error();
      try {
        expect(error.error_code).not.toBe(0);
        expect(error.get_error_message()).toContain(message);
      } finally {
        error.free();
      }
    } finally {
      runtime.stop();
      runtime.free();
    }
  });
});
