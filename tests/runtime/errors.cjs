const assert = require('node:assert/strict');
const { Compiler } = require(process.argv[2]);
const watchdog = setTimeout(() => {
  console.error('Runtime error checks timed out');
  process.exit(1);
}, 10000);

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

  // Ordinary integer arithmetic retains its existing release behavior.
  const normal = await run('int n = input(); print(n / 2, n % 2, n + 1);', '2147483647');
  assert.equal(normal.error.error_code, 0);
  assert.deepEqual(normal.output, ['1073741823 1 -2147483648']);

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

  console.log('Runtime error checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
