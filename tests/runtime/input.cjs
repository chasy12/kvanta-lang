const assert = require('node:assert/strict');
const { Compiler } = require(process.argv[2]);
const watchdog = setTimeout(() => {
  console.error('Runtime input checks timed out');
  process.exit(1);
}, 10000);

async function compile(source) {
  const result = await Compiler.new().compile_code(source);
  assert.equal(result.error_code, 0, result.error_code ? result.get_error_message() : source);
  return result.get_runtime();
}
async function run(source, handler) {
  const runtime = await compile(source);
  const output = [];
  runtime.set_renderer((ops, strings) => output.push(...strings));
  if (handler) runtime.set_input_handler(handler);
  await runtime.execute();
  return { runtime, output, error: runtime.get_runtime_error() };
}
function ok(result) {
  assert.equal(result.error.error_code, 0, result.error.get_error_message());
  return result.output;
}
const turn = () => new Promise(resolve => setImmediate(resolve));
async function deadline(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Pending input did not stop')), 500);
    })]);
  } finally { clearTimeout(timer); }
}

(async () => {
  // The old input() stub never returns a value. The alias must now read one.
  const alias = await run('int n = input(); print(n);', () => Promise.resolve('42'));
  assert.deepEqual(ok(alias), ['42']);

  const values = ['-2147483648', '1.25e2', ' true ', ' hello ', ''];
  const kinds = [];
  const typed = await run('int i = readInt(); float f = readFloat(); bool b = readBool(); string s = readString(); string e = readString(); print(i, f, b, s); print(e);', kind => {
    kinds.push(kind);
    return Promise.resolve(values.shift());
  });
  assert.deepEqual(ok(typed), ['-2147483648 125 true  hello ', '']);
  assert.deepEqual(kinds, ['int', 'float', 'bool', 'string', 'string']);

  const nested = await run('func next() -> int { return readInt(); } func main() { for i in (1..3) { print(next() + next()); } }', (() => {
    let value = 0;
    return () => Promise.resolve(String(++value));
  })());
  assert.deepEqual(ok(nested), ['3', '7', '11']);

  for (const [fn, type, bad] of [['readInt', 'int', '2147483648'], ['readInt', 'int', '1.5'], ['readFloat', 'float', 'NaN'], ['readFloat', 'float', 'Infinity'], ['readFloat', 'float', '1e39'], ['readFloat', 'float', '3.4028236e38'], ['readBool', 'bool', 'yes']]) {
    const invalid = await run(`${type} value = ${fn}();`, () => Promise.resolve(bad));
    assert.equal(invalid.error.error_code, 4, `${fn} accepted ${bad}`);
    assert.match(invalid.error.get_error_message(), /Invalid .* input/);
    assert.equal(invalid.error.start_row, 1);
  }
  assert.deepEqual(ok(await run('int n = readInt(); print(n);', () => Promise.resolve('+2147483647'))), ['2147483647']);
  assert.deepEqual(ok(await run('bool b = readBool(); print(b);', () => Promise.resolve('false'))), ['false']);
  const missing = await run('int n = readInt();');
  assert.equal(missing.error.error_code, 4);
  assert.match(missing.error.get_error_message(), /Input handler is not set/);
  const rejected = await run('int n = readInt();', () => Promise.reject(new Error('private error')));
  assert.equal(rejected.error.error_code, 4);
  assert.match(rejected.error.get_error_message(), /Input request failed/);
  const thrown = await run('int n = readInt();', () => { throw new Error('private error'); });
  assert.equal(thrown.error.error_code, 4);
  assert.match(thrown.error.get_error_message(), /Input request failed/);
  const unexpectedType = await run('int n = readInt();', () => Promise.resolve(42));
  assert.equal(unexpectedType.error.error_code, 4);
  assert.match(unexpectedType.error.get_error_message(), /Invalid int input/);
  const cancelled = await run('int n = readInt();', () => Promise.resolve(null));
  assert.equal(cancelled.error.error_code, 4);
  assert.match(cancelled.error.get_error_message(), /Input request cancelled/);

  // Compilation must not run globals, and execution must respect source order.
  const globals = await compile('global { int first = readInt(); int second = first + readInt(); } func main() { print(first, second); }');
  assert.equal(globals.get_runtime_error().error_code, 0);
  let value = 1;
  const globalOutput = [];
  globals.set_renderer((ops, strings) => globalOutput.push(...strings));
  globals.set_input_handler(() => Promise.resolve(String(value++)));
  await globals.execute();
  assert.equal(globals.get_runtime_error().error_code, 0);
  assert.deepEqual(globalOutput, ['1 3']);

  const flushing = await compile('print("Enter a value"); int n = readInt(); print(n);');
  const flushed = [];
  flushing.set_renderer((ops, strings) => flushed.push(...strings));
  flushing.set_input_handler(() => {
    assert.deepEqual(flushed, ['Enter a value']);
    return Promise.resolve('7');
  });
  await flushing.execute();
  assert.equal(flushing.get_runtime_error().error_code, 0);
  assert.deepEqual(flushed, ['Enter a value', '7']);

  const stopped = await compile('int n = readInt(); print("should not print", n);');
  let requested = false;
  let lateResolve;
  const stopOutput = [];
  stopped.set_renderer((ops, strings) => stopOutput.push(...strings));
  stopped.set_input_handler(() => { requested = true; return new Promise(resolve => { lateResolve = resolve; }); });
  const execution = stopped.execute();
  await turn();
  assert.equal(requested, true);
  stopped.stop();
  await deadline(execution);
  assert.equal(stopped.get_runtime_error().error_code, 0);
  lateResolve('9');
  await turn();
  assert.deepEqual(stopOutput, []);
  assert.deepEqual(ok(await run('print(readInt());', () => Promise.resolve('11'))), ['11']);

  // Reads remain available in event handlers after main returns.
  const laterEvent = await compile('func mouse(int x, int y) { print(readString()); } func main() { print("ready"); }');
  const laterOutput = [];
  laterEvent.set_renderer((ops, strings) => laterOutput.push(...strings));
  laterEvent.set_input_handler(() => Promise.resolve('clicked'));
  await laterEvent.execute();
  laterEvent.execute_mouse(1, 2);
  await turn();
  assert.deepEqual(laterOutput, ['ready', 'clicked']);
  laterEvent.stop();

  // Main and an event may wait concurrently. Stop must wake both.
  const events = await compile('global { int n = readInt(); } func mouse(int x, int y) { print(readInt()); } func main() { print(readInt()); }');
  let requests = 0;
  const releases = [];
  events.set_input_handler(() => { requests++; return new Promise(resolve => releases.push(resolve)); });
  const eventOutput = [];
  events.set_renderer((ops, strings) => eventOutput.push(...strings));
  const eventExecution = events.execute();
  await turn();
  events.execute_mouse(1, 2);
  await turn();
  assert.equal(requests, 1, 'Event ran before globals initialized');
  releases.shift()('1');
  await turn();
  assert.equal(requests, 2);
  events.execute_mouse(1, 2);
  await turn();
  assert.equal(requests, 3);
  events.stop();
  await deadline(eventExecution);
  for (const release of releases) release('2');
  await turn();
  assert.deepEqual(eventOutput, []);
  console.log('Runtime input checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
