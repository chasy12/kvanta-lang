const assert = require('node:assert/strict');
const { Compiler } = require(process.argv[2]);
const watchdog = setTimeout(() => { console.error('Runtime read checks timed out'); process.exit(1); }, 10000);
const turn = () => new Promise(resolve => setImmediate(resolve));

async function compile(source) {
  const result = Compiler.new().compile_code(source);
  const compiled = await result;
  assert.equal(compiled.error_code, 0, compiled.error_code ? compiled.get_error_message() : source);
  return compiled.get_runtime();
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
function error(result, pattern, row = 2) {
  assert.equal(result.error.error_code, 4);
  assert.match(result.error.get_error_message(), pattern);
  assert.equal(result.error.start_row, row);
  assert.ok(result.error.end_column > result.error.start_column);
}

(async () => {
  let requests = 0;
  const one = await run('int x=0; print("Enter x"); read(x); print(x);', descriptor => {
    requests++;
    assert.equal(descriptor, 'int');
    return Promise.resolve('42');
  });
  assert.deepEqual(ok(one), ['Enter x', '42']);
  assert.equal(requests, 1);

  const flushing = await compile('int x=0; int y=0; print("Enter two values"); read(x,y);');
  const flushed = [];
  flushing.set_renderer((ops, strings) => flushed.push(...strings));
  flushing.set_input_handler(() => {
    assert.deepEqual(flushed, ['Enter two values']);
    return Promise.resolve('1 2');
  });
  await flushing.execute();
  assert.equal(flushing.get_runtime_error().error_code, 0);

  const row = await run('int x=0; float y=0.0; bool z=false; read(x,y,z); print(x,y,z);', descriptor => {
    assert.deepEqual(descriptor, ['int', 'float', 'bool']);
    return Promise.resolve('  -2147483648\t1.25e2\u0085true  ');
  });
  assert.deepEqual(ok(row), ['-2147483648 125 true']);

  for (const raw of [' hello world ', '']) {
    const string = await run('string text="old"; read((text)); print(text);', descriptor => {
      assert.equal(descriptor, 'string');
      return Promise.resolve(raw);
    });
    assert.deepEqual(ok(string), [raw]);
  }

  const indexed = await run('int i=0; array<int,2> a={0...}; read(i,a[i]); print(i,a);', descriptor => {
    assert.deepEqual(descriptor, ['int', 'int']);
    return Promise.resolve('1 7');
  });
  assert.deepEqual(ok(indexed), ['1 {7, 0}']);
  assert.deepEqual(ok(await run('array<array<float,2>,2> a={{0.0,0.0},{0.0,0.0}}; read(a[1][0]); print(a);', () => Promise.resolve('2.5'))), ['{{0, 0}, {2.5, 0}}']);
  assert.deepEqual(ok(await run('int x=0; read(x,x); print(x);', () => Promise.resolve('1 2'))), ['2']);
  assert.deepEqual(ok(await run('global{int g=0;} func change(int v){read(v,g); print(v,g);} func main(){change(1); if(true){read(g);} print(g);}', (() => {
    const values = ['2 3', '4'];
    return () => Promise.resolve(values.shift());
  })())), ['2 3', '4']);

  for (const [raw, pattern] of [
    ['1', /Input row expects 2 values, got 1/],
    ['1 2 3', /Input row expects 2 values, got 3/],
    ['1 bad', /Invalid float input at position 2/],
    ['2147483648 2.0', /Invalid int input at position 1/],
    [42, /Invalid input row: expected text/],
    [null, /Input request cancelled/],
  ]) {
    const failed = await run('global{int x=9; float y=8.0;} func mouse(int a,int b){print(x,y);} func main(){\n read(x,y); print("after");}', () => Promise.resolve(raw));
    error(failed, pattern);
    assert.deepEqual(failed.output, []);
    failed.runtime.execute_mouse(0,0);
    await turn();
    assert.deepEqual(failed.output, ['9 8'], 'read assigned a target before the entire row was validated');
    failed.runtime.stop();
  }

  let requested = false;
  const bounds = await run('array<int,1> a={0};\nread(a[1]);', () => { requested = true; return Promise.resolve('2'); });
  error(bounds, /Index out of bounds/);
  assert.equal(requested, false, 'invalid targets requested input');
  const division = await run('array<int,1> a={0};\nread(a[1\/0]);', () => { requested = true; return Promise.resolve('2'); });
  error(division, /Division by 0/);
  assert.equal(requested, false);

  const invalidTarget = await run('global{int x=9; array<int,1> a={0};} func mouse(int u,int v){print(x,a);} func main(){\nread(x,a[1]);}', () => { requested = true; return Promise.resolve('1 2'); });
  error(invalidTarget, /Index out of bounds/);
  assert.equal(requested, false);
  invalidTarget.runtime.execute_mouse(0,0);
  await turn();
  assert.deepEqual(invalidTarget.output, ['9 {0}']);
  invalidTarget.runtime.stop();

  const shared = await compile('global{int i=0; array<int,2> a={0...};} func mouse(int x,int y){a[1]=99;} func main(){read(i,a[i]); print(i,a);}');
  const output = [];
  let resolve;
  shared.set_renderer((ops, strings) => output.push(...strings));
  shared.set_input_handler(() => new Promise(done => { resolve = done; }));
  const executing = shared.execute();
  await turn();
  shared.execute_mouse(0,0);
  await turn();
  resolve('1 7');
  await executing;
  assert.equal(shared.get_runtime_error().error_code, 0);
  assert.deepEqual(output, ['1 {7, 99}'], 'read replaced an unrelated change made while waiting');
  shared.stop();

  const stopped = await compile('int x=0; int y=0; read(x,y); print("after",x,y);');
  let late;
  const stoppedOutput = [];
  stopped.set_renderer((ops, strings) => stoppedOutput.push(...strings));
  stopped.set_input_handler(() => new Promise(resolve => { late = resolve; }));
  const pending = stopped.execute();
  await turn();
  stopped.stop();
  await pending;
  late('1 2');
  await turn();
  assert.deepEqual(stoppedOutput, []);
  assert.equal(stopped.get_runtime_error().error_code, 0);

  const bad = Compiler.new().check_code('const int c=0; int x=0; color colorValue=Color::Red; array<int,1> a={0}; read(c,1,x+1,missing,a,colorValue);');
  assert.equal(bad.get_errors().length, 6);
  assert.equal(Compiler.new().check_code('read();').get_errors().length, 1);
  assert.match(Compiler.new().check_code('string s=""; int x=0; read(s,x);').get_error_message(), /Read string targets separately/);
  assert.match(Compiler.new().check_code('int x=0; int y=read(x);').get_error_message(), /Function read has no return type/);
  assert.equal(Compiler.new().check_code('array<const array<int,2>,2> a={{0,0},{0,0}}; read(a[0][0]);').get_errors().length, 1);
  assert.equal(Compiler.new().check_code('const array<int,1> a={0}; read(a[missing]);').get_errors().length, 2);
  assert.equal(Compiler.new().check_code('read(unknown[missing]);').get_errors().length, 2);
  console.log('Runtime read checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
