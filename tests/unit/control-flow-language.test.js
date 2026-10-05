import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import initWasm, { Compiler } from '../../quanta-lang/pkg/quanta_lang.js';
import { cancelNow, drawCommands } from '../../web/canvas-runtime.js';

const ctx = globalThis.__mockBufferCtx;
let drawn;

beforeAll(async () => {
  await initWasm({ module_or_path: readFileSync('quanta-lang/pkg/quanta_lang_bg.wasm') });
});

beforeEach(() => {
  cancelNow(false);
  drawn = [];
  ctx.fillText = vi.fn((content, x, y) => {
    drawn.push({ content, x, y, color: ctx.fillStyle });
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
  try {
    expect(result.error_code, result.error_code ? result.get_error_message() : '').toBe(0);
    const runtime = result.get_runtime();
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
  } finally {
    result.free();
  }
}

async function reject(source, message, semantic = false) {
  const result = await compile(source);
  try {
    expect(result.error_code, source).not.toBe(0);
    if (semantic) expect(result.error_code, result.get_error_message()).not.toBe(1);
    if (message) expect(result.get_error_message().toLowerCase()).toContain(message);
  } finally {
    result.free();
  }
}

describe('control flow through the WASM interpreter', () => {
  it('evaluates else-if conditions in order and stops after the first match', async () => {
    await run(`
      global { int checks = 0; }
      func probe(int value) -> bool { checks = checks + 1; return value == 2; }
      func main() {
        if (probe(1)) { text(1, 0, "wrong"); }
        else if (probe(2)) { text(2, 0, "matched"); }
        else if (probe(2)) { text(3, 0, "wrong"); }
        else { text(4, 0, "wrong"); }
        text(checks, 0, "checks");
      }
    `);
    expect(drawn.map(({ content, x }) => [content, x])).toEqual([['matched', 2], ['checks', 2]]);
  });

  it.each([
    ['if (true)', 1],
    ['if (false)', 2],
  ])('takes the right arm of %s with an else-if and no final else', async (first, expected) => {
    await run(`${first} { text(1, 0, "arm"); } else if (true) { text(2, 0, "arm"); }`);
    expect(drawn.map(item => item.x)).toEqual([expected]);
  });

  it('runs the final else when every else-if condition is false', async () => {
    await run('if (false) { text(1, 0, "wrong"); } else if (false) { text(2, 0, "wrong"); } else { text(3, 0, "fallback"); }');
    expect(drawn.map(item => item.x)).toEqual([3]);
  });

  it('recognizes a definite return in every arm of an else-if chain', async () => {
    await run(`
      func classify(int value) -> int {
        if (value == 1) { return 10; }
        else if (value == 2) { return 20; }
        else { return 30; }
      }
      func main() { text(classify(1), 0, "first"); text(classify(2), 0, "second"); text(classify(3), 0, "else"); }
    `);
    expect(drawn.map(item => item.x)).toEqual([10, 20, 30]);
  });

  it('checks the return type of every else-if arm', async () => {
    await reject('func classify(int value) -> int { if (value == 1) { return 10; } else if (value == 2) { return "wrong"; } else { return 30; } } func main() { text(classify(1), 0, "value"); }', undefined, true);
  });

  it.each([
    ['while', 'int i = 0; while (i < 4) { i = i + 1; if (i == 2) { continue; } text(i, 0, "visit"); }', [1, 3, 4]],
    ['ascending range', 'for i in (1..4) { if (i == 2) { continue; } text(i, 0, "visit"); }', [1, 3, 4]],
    ['descending range', 'for i in (4..1) { if (i == 2) { continue; } text(i, 0, "visit"); }', [4, 3, 1]],
    ['foreach', 'for i in {1, 2, 3, 4} { if (i == 2) { continue; } text(i, 0, "visit"); }', [1, 3, 4]],
  ])('continues with the next iteration of a %s loop', async (_name, source, expected) => {
    await run(source);
    expect(drawn.map(item => item.x)).toEqual(expected);
  });

  it.each([
    ['while', 'int i = 0; while (i < 4) { i = i + 1; if (i == 2) { break; } text(i, 0, "visit"); }'],
    ['ascending range', 'for i in (1..4) { if (i == 2) { break; } text(i, 0, "visit"); }'],
    ['descending range', 'for i in (1..-2) { if (i == 0) { break; } text(i, 0, "visit"); }'],
    ['foreach', 'for i in {1, 2, 3, 4} { if (i == 2) { break; } text(i, 0, "visit"); }'],
  ])('breaks a %s loop before running the rest of its body', async (_name, source) => {
    await run(`${source} text(9, 0, "after");`);
    expect(drawn.map(item => item.x)).toEqual([1, 9]);
  });

  it('breaks only the nearest loop across nested loop kinds', async () => {
    await run(`
      for outer in (1..2) {
        int n = 0;
        while (n < 3) {
          n = n + 1;
          for inner in {5, 6} { text(inner, outer, "inner"); break; }
          if (n == 2) { break; }
          text(n, outer, "while");
        }
        text(outer, 0, "outer");
      }
    `);
    expect(drawn.map(({ content, x, y }) => [content, x, y])).toEqual([
      ['inner', 5, 1], ['while', 1, 1], ['inner', 5, 1], ['outer', 1, 0],
      ['inner', 5, 2], ['while', 1, 2], ['inner', 5, 2], ['outer', 2, 0],
    ]);
  });

  it('continues only the nearest loop and restores its enclosing scope', async () => {
    await run(`
      for outer in (1..2) {
        for inner in {1, 2} {
          int temporary = inner;
          if (inner == 1) { continue; }
          text(temporary, outer, "inner");
        }
        int temporary = outer;
        text(temporary, 0, "outer");
      }
    `);
    expect(drawn.map(({ content, x, y }) => [content, x, y])).toEqual([
      ['inner', 2, 1], ['outer', 1, 0], ['inner', 2, 2], ['outer', 2, 0],
    ]);
  });

  it('returns from a function through nested loops and an else-if', async () => {
    await run(`
      func find() -> int {
        for row in (1..3) {
          for value in {4, 5, 6} {
            if (value == 4) { continue; }
            else if (row == 2) { return value; }
          }
        }
        return 99;
      }
      func main() { text(find(), 0, "found"); }
    `);
    expect(drawn.map(item => item.x)).toEqual([5]);
  });

  it.each([
    ['break;', 'break'],
    ['continue;', 'continue'],
    ['if (true) { break; }', 'break'],
    ['if (true) { continue; }', 'continue'],
    ['func helper() { break; } func main() { for i in (1..2) { helper(); } }', 'break'],
    ['func helper() { continue; } func main() { while (false) { helper(); } }', 'continue'],
  ])('rejects loop control outside the function-local loop context in %s', async (source, message) => {
    await reject(source, message, true);
  });

  it.each([
    'func value() -> int { while (false) { return 1; } } func main() { text(value(), 0, "value"); }',
    'func value() -> int { for n in {} { return 1; } } func main() { text(value(), 0, "value"); }',
    'func value(bool stop) -> int { for n in (1..3) { if (stop) { break; } return n; } } func main() { text(value(true), 0, "value"); }',
  ])('rejects a value function whose loops can finish without returning: %s', async source => {
    await reject(source);
  });

  it('accepts fallback returns after loops that may not produce a value', async () => {
    await run(`
      func fromWhile() -> int { while (false) { return 1; } return 2; }
      func fromEmpty() -> int { for n in {} { return 3; } return 4; }
      func fromBreak() -> int { for n in (1..3) { if (n == 1) { break; } return n; } return 6; }
      func main() { text(fromWhile(), 0, "while"); text(fromEmpty(), 0, "empty"); text(fromBreak(), 0, "break"); }
    `);
    expect(drawn.map(item => item.x)).toEqual([2, 4, 6]);
  });

  it.each([
    'for i in (1..2) {} text(i, 0, "outside");',
    'for item in {1, 2} {} text(item, 0, "outside");',
    'for i in (1..2) { int local = i; } text(local, 0, "outside");',
  ])('rejects access to a variable after its loop scope ends: %s', async source => {
    await reject(source);
  });

  it('does not leak a declaration before break into the next outer iteration', async () => {
    await run('for outer in (1..2) { for inner in (1..2) { int local = outer; text(local, 0, "local"); break; } }');
    expect(drawn.map(item => item.x)).toEqual([1, 2]);
  });
});

describe('array iteration and length through the WASM interpreter', () => {
  it('reports the outer length of literals, nested arrays and array-returning expressions', async () => {
    await run(`
      func values() -> array<int, 3> { return {7, 8, 9}; }
      func main() {
        array<array<int, 3>, 2> grid = {{1, 2, 3}, {4, 5, 6}};
        text(len(grid), 0, "rows"); text(len(grid[0]), 0, "columns");
        text(len(values()), 0, "call"); text(len({10, 20}), 0, "literal"); text(len({}), 0, "empty");
      }
    `);
    expect(drawn.map(item => item.x)).toEqual([2, 3, 3, 2, 0]);
  });

  it('evaluates a foreach iterable once before the first iteration', async () => {
    await run(`
      global { int calls = 0; }
      func values() -> array<int, 3> { calls = calls + 1; return {1, 2, 3}; }
      func main() { for value in values() { text(value, 0, "value"); } text(calls, 0, "calls"); }
    `);
    expect(drawn.map(({ content, x }) => [content, x])).toEqual([
      ['value', 1], ['value', 2], ['value', 3], ['calls', 1],
    ]);
  });

  it('iterates a snapshot when the source array changes in the body', async () => {
    await run(`
      array<int, 3> values = {1, 2, 3};
      for value in values { values[1] = 9; text(value, 0, "value"); }
      text(values[1], 0, "source");
    `);
    expect(drawn.map(item => item.x)).toEqual([1, 2, 3, 9]);
  });

  it('binds scalar foreach elements as copies', async () => {
    await run(`
      array<int, 2> values = {3, 4};
      for value in values { value = value + 10; text(value, 0, "copy"); }
      text(values[0], 0, "source"); text(values[1], 0, "source");
    `);
    expect(drawn.map(item => item.x)).toEqual([13, 14, 3, 4]);
  });

  it('binds nested arrays as independent copies and snapshots their contents', async () => {
    await run(`
      array<array<int, 2>, 2> grid = {{1, 2}, {3, 4}};
      for row in grid {
        grid[1][0] = 9;
        text(row[0], 0, "snapshot");
        row[0] = 7;
      }
      text(grid[0][0], 0, "source"); text(grid[1][0], 0, "source");
    `);
    expect(drawn.map(item => item.x)).toEqual([1, 3, 1, 9]);
  });

  it('iterates strings and supports a literal empty iterable', async () => {
    await run(`
      for label in {"first", "second"} { text(1, 0, label); }
      for unused in {} { text(2, 0, "wrong"); }
      text(3, 0, "after");
    `);
    expect(drawn.map(item => item.content)).toEqual(['first', 'second', 'after']);
  });

  it.each([
    ['int value = len(3);', 'array'],
    ['int value = len("abc");', 'array'],
    ['int value = len(true);', 'array'],
    ['int value = len();', 'argument'],
    ['int value = len({1}, {2});', 'argument'],
    ['for value in 3 {}', 'array'],
    ['for value in "abc" {}', 'array'],
    ['for value in true {}', 'array'],
  ])('rejects an invalid array operation in %s', reject);
});

describe('sized array declarations through the WASM interpreter', () => {
  it('fills integer arrays and every dimension of nested arrays with zero', async () => {
    await run(`
      int values[2]; int grid[2][3];
      text(len(values), 0, "length");
      for value in values { text(value, 0, "zero"); }
      for row in grid { text(len(row), 0, "width"); for value in row { text(value, 0, "cell"); } }
      grid[0][0] = 7;
      text(grid[1][0], 0, "independent row");
    `);
    expect(drawn.map(item => item.x)).toEqual([2, 0, 0, 3, 0, 0, 0, 3, 0, 0, 0, 0]);
  });

  it('fills bool, string, float and color arrays with their primitive defaults', async () => {
    await run(`
      bool flags[2]; string labels[2]; float amounts[2]; color colors[2];
      for flag in flags { if (flag) { text(1, 0, "wrong"); } else { text(0, 0, "false"); } }
      for label in labels { text(0, 0, "[" + label + "]"); }
      for amount in amounts { if (amount == 0.0) { text(0, 0, "float zero"); } }
      for shade in colors { setTextColor(shade); text(0, 0, "color"); }
    `);
    expect(drawn.map(item => item.content)).toEqual(['false', 'false', '[]', '[]', 'float zero', 'float zero', 'color', 'color']);
    expect(drawn.filter(item => item.content === 'color').map(item => item.color)).toEqual(['#000000ff', '#000000ff']);
  });

  it('accepts exact nested initializers and preserves their values', async () => {
    await run('int grid[2][3] = {{1, 2, 3}, {4, 5, 6}}; for row in grid { for value in row { text(value, 0, "cell"); } }');
    expect(drawn.map(item => item.x)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('preserves legacy explicit and expanding array declarations', async () => {
    await run('array<int, 3> explicit = {1, 2, 3}; array<int, 3> expanded = {7...}; for value in explicit { text(value, 0, "explicit"); } for value in expanded { text(value, 0, "expanded"); }');
    expect(drawn.map(item => item.x)).toEqual([1, 2, 3, 7, 7, 7]);
  });

  it('initializes sized arrays in conditional branches and on each loop iteration', async () => {
    await run(`
      if (false) { text(9, 0, "wrong"); }
      else if (true) { int branch[2]; text(branch[1], 0, "branch"); }
      for n in (1..2) { int local[2]; text(local[0], 0, "range"); local[0] = 9; }
      int n = 0;
      while (n < 2) { int local[2]; text(local[0], 0, "while"); local[0] = 9; n = n + 1; }
      for value in {1, 2} { int local[2]; text(local[0], 0, "foreach"); local[0] = 9; }
    `);
    expect(drawn.map(item => item.x)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it('initializes sized globals and passes sized parameters to functions', async () => {
    await run(`
      global { int totals[2]; }
      func sum(int values[2]) -> int { return values[0] + values[1]; }
      func local() -> array<int, 2> { int values[2]; values[1] = 4; return values; }
      func main() {
        text(sum(totals), 0, "global zeros");
        totals[0] = 3;
        text(sum(totals), 0, "global changed");
        text(sum(local()), 0, "local");
      }
    `);
    expect(drawn.map(item => item.x)).toEqual([0, 3, 4]);
  });

  it.each([
    'int values[0];',
    'int values[-1];',
    'int values[2][0];',
    'int count = 2; int values[count];',
    'int values[2] = {1};',
    'int values[2] = {1, 2, 3};',
    'int values[2] = {true, false};',
    'int grid[2][3] = {{1, 2}, {3, 4}};',
    'int grid[2][3] = {1, 2};',
    'array<int, 0> values = {};',
    'func first(int values[2]) -> int { return values[0]; } func main() { text(first({1}), 0, "invalid"); }',
  ])('rejects invalid array dimensions or initializer types: %s', async source => {
    await reject(source);
  });
});


describe('sized arrays in input handlers', () => {
  it.each(['mouse', 'keyboard'])('executes normalized defaults in the %s handler', async handler => {
    const signature = handler === 'mouse' ? 'int x, int y' : 'int key';
    const result = await compile(`func ${handler}(${signature}) { int values[2]; print(values); } func main() {}`);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    let runtime;
    try {
      expect(result.error_code, result.error_code ? result.get_error_message() : '').toBe(0);
      runtime = result.get_runtime();
      runtime.set_renderer(drawCommands);
      await runtime.execute();
      if (handler === 'mouse') runtime.execute_mouse(10, 20);
      else runtime.execute_key('A');
      await vi.waitFor(() => expect(output).toHaveBeenCalledWith('Print:{0, 0}'));
    } finally {
      runtime?.stop();
      runtime?.free();
      result.free();
      output.mockRestore();
    }
  });
});


describe('array length in indexes', () => {
  it('reads and writes elements using length calls directly', async () => {
    await run('int a[3] = {1,2,3}; text(a[len(a) - 1], 0, "last"); a[len(a) - 1] = 9; text(a[2], 0, "updated");');
    expect(drawn.map(item => item.x)).toEqual([3, 9]);
  });
  it('rejects non-integer index variables during compilation', async () => {
    await reject('int a[2]; bool index = true; text(a[index],0,"bad");', 'integer', true);
  });
});
