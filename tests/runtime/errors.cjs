const assert = require('node:assert/strict');
const { Compiler } = require(process.argv[2]);
const watchdog = setTimeout(() => {
  console.error('Runtime error checks timed out');
  process.exit(1);
}, 60000);

async function compile(source) {
  const result = await Compiler.new().compile_code(source);
  assert.equal(result.error_code, 0, result.error_code ? result.get_error_message() : source);
  return result.get_runtime();
}
async function run(source, value) {
  const runtime = await compile(source);
  const output = [];
  runtime.set_renderer((ops, strings) => output.push(...strings));
  runtime.set_input_handler(() => Promise.resolve(value));
  await runtime.execute();
  return { runtime, output, error: runtime.get_runtime_error() };
}
function located(error, message, row, column) {
  assert.equal(error.error_code, 4, message);
  assert.equal(error.get_error_message(), message);
  assert.equal(error.start_row, row);
  assert.equal(error.end_row, row);
  if (column !== undefined) assert.equal(error.start_column, column);
  assert.ok(error.end_column > error.start_column, 'error must highlight source');
}
const turn = () => new Promise(resolve => setImmediate(resolve));

(async () => {
  // Array writes must locate the failing assignment, including nested arrays.
  const write = await run('array<int, 2> a = {1,2};\nint n = input();\na[n] = 3;', '2');
  located(write.error, 'Index out of bounds for array a: 2', 3, 1);
  const nested = await run('array<array<int, 2>, 2> a = {{1,2},{3,4}};\nint n = input();\na[0][n] = 3;', '2');
  located(nested.error, 'Index out of bounds for array a[0]: 2', 3, 1);
  const read = await run('array<int, 2> a = {1,2};\nint n = input();\nprint(a[n]);', '2');
  located(read.error, 'Index out of bounds for array a: 2', 3, 7);

  for (const operator of ['/', '%']) {
    const zero = await run(`print("before");\nint n = input();\nprint(5 ${operator} n);\nprint("after");`, '0');
    located(zero.error, 'Division by 0', 3, 7);
    assert.deepEqual(zero.output, ['before']);
    const overflow = await run(`int n = input();\nprint(n ${operator} -1);`, '-2147483648');
    located(overflow.error, 'Integer overflow', 2, 7);
  }

  for (const operator of ['/', '%']) {
    const zero = await run(`float n = input();\nprint(5.0 ${operator} n);`, '0');
    located(zero.error, 'Division by 0', 2, 7);
  }

  // Ordinary integer arithmetic is exact, and + - * and unary minus report overflow like / and %.
  const normal = await run('int n = input(); print(n / 2, n % 2, n - 1);', '2147483647');
  assert.equal(normal.error.error_code, 0);
  assert.deepEqual(normal.output, ['1073741823 1 2147483646']);
  for (const [expression, value, column] of [
    ['n + 1', '2147483647', 7], ['n - 1', '-2147483648', 7], ['n * 2', '2147483647', 7],
    ['n * n', '65536', 7], ['-n', '-2147483648', 8],
  ]) {
    const overflow = await run(`print("before");\nint n = input();\nprint(${expression});\nprint("after");`, value);
    located(overflow.error, 'Integer overflow', 3, undefined);
    assert.deepEqual(overflow.output, ['before'], expression);
  }
  const factorial12 = await run('int f = 1; for i in (1..12) { f = f * i; } print(f);');
  assert.deepEqual(factorial12.output, ['479001600']);
  const factorial13 = await run('int f = 1; for i in (1..13) { f = f * i; } print(f);');
  located(factorial13.error, 'Integer overflow', 1, undefined);
  assert.deepEqual(factorial13.output, []);
  const edge = await run('int top = 2147483646 + 1; int bottom = -2147483647 - 1; print(top, bottom);');
  assert.deepEqual(edge.output, ['2147483647 -2147483648']);

  // Event failures travel through the error callback after main has returned.
  const eventRuntime = await compile('func mouse(int x, int y) {\n int n = input();\n print(5 % n);\n}\nfunc main() {}');
  let eventError;
  eventRuntime.set_renderer(() => {});
  eventRuntime.set_input_handler(() => Promise.resolve('0'));
  eventRuntime.set_error_handler(error => { eventError = error; });
  await eventRuntime.execute();
  eventRuntime.execute_mouse(1, 2);
  await turn();
  located(eventError, 'Division by 0', 3, 8);
  eventRuntime.stop();

  for (const [kind, typedFn, badValues, expected, columns] of [
    ['int', 'readInt', ['1.5', '2147483648', 42], 'a whole number from -2147483648 to 2147483647', [9, 18, 16]],
    ['float', 'readFloat', ['Infinity', '1e39', true], 'a finite decimal number', [11, 22, 18]],
    ['bool', 'readBool', ['yes', '1', false], 'true or false', [10, 20, 17]],
    ['string', 'readString', [42, undefined], 'text', [12, 24, 19]],
  ]) {
    for (const fn of [typedFn, 'input']) {
      for (const bad of badValues) {
        const invalid = await run(`print("before");\n${kind} n = ${fn}();\nprint("after");`, bad);
        located(invalid.error, `Invalid ${kind} input: expected ${expected}`, 2, columns[0]);
        assert.equal(invalid.error.end_column, columns[fn === 'input' ? 2 : 1]);
        assert.deepEqual(invalid.output, ['before']);
      }
    }
  }

  // JavaScript form validation uses the same Unicode whitespace as Rust.
  for (const [kind, fn, raw, output] of [
    ['int', 'readInt', '42', '42'],
    ['float', 'readFloat', '1.25', '1.25'],
    ['bool', 'readBool', 'true', 'true'],
  ]) {
    for (const call of [fn, 'input']) {
      const accepted = await run(`${kind} n = ${call}(); print(n);`, `\u0085${raw}\u0085`);
      assert.equal(accepted.error.error_code, 0);
      assert.deepEqual(accepted.output, [output]);
      const rejected = await run(`${kind} n = ${call}(); print(n);`, `\uFEFF${raw}`);
      assert.equal(rejected.error.error_code, 4);
      assert.match(rejected.error.get_error_message(), new RegExp(`^Invalid ${kind} input: expected `));
      assert.deepEqual(rejected.output, []);
    }
  }
  const text = await run('string n = input(); print(n);', '\uFEFF \u0085');
  assert.equal(text.error.error_code, 0);
  assert.deepEqual(text.output, ['\uFEFF \u0085']);

  const invalidEvent = await compile('func mouse(int x, int y) {\n bool n = input();\n print(n);\n}\nfunc main() {}');
  let inputError;
  invalidEvent.set_renderer(() => {});
  invalidEvent.set_input_handler(() => Promise.resolve('yes'));
  invalidEvent.set_error_handler(error => { inputError = error; });
  await invalidEvent.execute();
  invalidEvent.execute_mouse(1, 2);
  await turn();
  located(inputError, 'Invalid bool input: expected true or false', 2, 11);
  assert.equal(inputError.end_column, 18);
  invalidEvent.stop();

  // && and || skip the right side when the left side already decides the result.
  const guarded = await run(`array<int, 3> a = {1, 2, 3};
int i = input();
if (i < 3 && a[i] > 0) { print("in"); } else { print("out"); }
if (i >= 3 || a[i] > 0) { print("yes"); }
bool both = i < 3 && a[i] > 0;
bool either = i >= 3 || a[i] > 0;
print(both, either);`, '5');
  assert.equal(guarded.error.error_code, 0, guarded.error.error_code ? guarded.error.get_error_message() : '');
  assert.deepEqual(guarded.output, ['out', 'yes', 'false true']);
  const needed = await run('array<int, 3> a = {1, 2, 3};\nint i = input();\nif (i >= 3 && a[i] > 0) { print("in"); }', '5');
  located(needed.error, 'Index out of bounds for array a: 5', 3, undefined);

  // random(a, b) is uniform and inclusive for negative and wide ranges.
  const draws = await run(`array<int, 11> seen = {0...};
for i in (1..20000) {
  int n = random(-5, 5);
  seen[n + 5] = seen[n + 5] + 1;
}
print(seen);`);
  assert.equal(draws.error.error_code, 0, draws.error.error_code ? draws.error.get_error_message() : '');
  const counts = draws.output[0].replace(/[{}]/g, '').split(',').map(Number);
  assert.equal(counts.length, 11);
  assert.equal(counts.reduce((a, b) => a + b, 0), 20000);
  // Each value has a 1/11 chance: expect about 1818 and allow a wide margin.
  for (const [offset, count] of counts.entries()) assert.ok(count > 1500 && count < 2150, `random(-5, 5) gave ${offset - 5} ${count} times`);
  const wide = await run(`int low = 0; int high = 0; bool ok = true;
for i in (1..2000) {
  int n = random(-2000000000, 2000000000);
  if (n < low) { low = n; }
  if (n > high) { high = n; }
}
print(low < -1000000000, high > 1000000000);
int swapped = random(5, -5);
print(swapped >= -5 && swapped <= 5, random(7, 7), random(-3, -3));`);
  assert.equal(wide.error.error_code, 0, wide.error.error_code ? wide.error.get_error_message() : '');
  assert.deepEqual(wide.output, ['true true', 'true 7 -3']);

  // A negative radius is an error at the call, not a silently dropped frame.
  for (const [call, row] of [['circle(10, 10, -5)', 2], ['arc(10, 10, -5, 0, 90)', 2]]) {
    const negative = await run(`print("before");\n${call};\nprint("after");`);
    located(negative.error, "Radius can't be negative: -5", row, 1);
    assert.deepEqual(negative.output, ['before']);
  }
  const zero = await run('circle(10, 10, 0); arc(10, 10, 0, 0, 90); circle(10, 10, 5); print("done");');
  assert.equal(zero.error.error_code, 0);
  assert.deepEqual(zero.output, ['done']);

  // Strings can't grow without bound.
  const doubled = await run('string s = "abcdefgh";\nfor i in (1..40) {\n  s = s + s;\n}\nprint("after");');
  located(doubled.error, 'String is too long: at most 1000000 characters', 3, undefined);
  assert.deepEqual(doubled.output, []);
  // 2^19 characters is well within the limit.
  const longEnough = await run('string s = "x"; for i in (1..19) { s = s + s; } string t = s; for j in (1..9) { t = t + "ab"; } print("built");');
  assert.equal(longEnough.error.error_code, 0, longEnough.error.error_code ? longEnough.error.get_error_message() : '');

  // Arrays over a million elements are rejected when compiling, and the module keeps working.
  for (const [source, row, column] of [
    ['int a[2000000000];', 1, 7],
    ['array<int, 100000000> a = {0...};', 1, 12],
    ['print(1);\nint a[100000][100000];', 2, 15],
  ]) {
    const compiled = await Compiler.new().compile_code(source);
    assert.notEqual(compiled.error_code, 0, source);
    const error = compiled.get_error();
    assert.equal(error.get_error_message(), 'Array is too large: at most 1000000 elements', source);
    assert.equal(error.start_row, row);
    assert.equal(error.start_column, column);
    const checked = Compiler.new().check_code(source);
    assert.equal(checked.get_error().get_error_message(), 'Array is too large: at most 1000000 elements');
  }
  const biggest = await run('int a[1000000]; a[999999] = 7; int grid[1000][1000]; grid[999][999] = 8; print(a[999999], grid[999][999], len(a));');
  assert.equal(biggest.error.error_code, 0, biggest.error.error_code ? biggest.error.get_error_message() : '');
  assert.deepEqual(biggest.output, ['7 8 1000000']);

  // A recursion without an end is a normal runtime error, whatever the body looks like.
  const recursion = /^Too many nested function calls \(more than \d+\)\. Is there a recursion without an end\?$/;
  const endless = (body) => `func f(int n) -> int {\n ${body}\n}\nfunc main() {\n print("before");\n print(f(0));\n}`;
  const nest = (count, open, inner, close) => open.repeat(count) + inner + close.repeat(count);
  for (const body of [
    'return f(n + 1);',
    nest(10, 'if (true) { ', 'return f(n + 1);', '}') + ' return 0;',
    nest(30, 'if (true) { ', 'return f(n + 1);', '}') + ' return 0;',
    nest(30, 'while (true) { ', 'return f(n + 1);', '}') + ' return 0;',
    nest(20, 'for i in (0..0) { ', 'return f(n + 1);', '}') + ' return 0;',
    'return 0 + ' + nest(55, '(1 + ', 'f(n + 1)', ')') + ';',
    'return ' + nest(20, 'id(', 'f(n + 1)', ')') + ';',
    'int a[100]; return f(n + 1) + a[0];',
  ]) {
    // Loop variables need distinct names.
    let counter = 0;
    const source = endless(body.replace(/for i in/g, () => `for i${counter++} in`)) + '\nfunc id(int x) -> int { return x; }';
    const result = await run(source);
    assert.equal(result.error.error_code, 4, source.slice(0, 120));
    assert.match(result.error.get_error_message(), recursion, source.slice(0, 120));
    assert.deepEqual(result.output, ['before']);
    // The module is still alive afterwards, in the same process.
    const after = await run('print(1 + 1);');
    assert.deepEqual(after.output, ['2']);
  }
  // Mutual recursion and recursion in event handlers.
  const mutual = await run('func a(int n) -> int { return b(n + 1); }\nfunc b(int n) -> int { return a(n + 1); }\nfunc main() { print(a(0)); }');
  assert.match(mutual.error.get_error_message(), recursion);
  const noReturn = await run('func f(int n) { f(n + 1); }\nfunc main() { f(0); }');
  assert.match(noReturn.error.get_error_message(), recursion);
  const handlerRuntime = await compile('func mouse(int x, int y) {\n loop(0);\n}\nfunc loop(int n) {\n loop(n + 1);\n}\nfunc main() {}');
  let handlerError;
  handlerRuntime.set_renderer(() => {});
  handlerRuntime.set_error_handler(error => { handlerError = error; });
  await handlerRuntime.execute();
  handlerRuntime.execute_mouse(1, 2);
  await turn();
  assert.equal(handlerError.error_code, 4);
  assert.match(handlerError.get_error_message(), recursion);
  handlerRuntime.execute_mouse(3, 4);
  await turn();
  handlerRuntime.stop();
  // Deep recursion that ends is fine, up to 100 nested calls for a simple body.
  const sum = await run('func sum(int n) -> int {\n if (n == 0) { return 0; }\n return n + sum(n - 1);\n}\nfunc main() { print(sum(100)); }');
  assert.equal(sum.error.error_code, 0, sum.error.error_code ? sum.error.get_error_message() : '');
  assert.deepEqual(sum.output, ['5050']);
  const looping = await run('func walk(int n) -> int {\n int total = 0;\n for i in (1..3) {\n  if (n > 0) { total = total + walk(n - 1); }\n }\n return total + 1;\n}\nfunc main() { print(walk(6)); }');
  assert.equal(looping.error.error_code, 0, looping.error.error_code ? looping.error.get_error_message() : '');
  assert.deepEqual(looping.output, ['1093']);

  console.log('Runtime error checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
