const assert = require('node:assert/strict');
const { Compiler } = require(process.argv[2]);

(async () => {
  const result = await Compiler.new().compile_code(
    'print(" hello ", 42, true, Color::Red); print(); array<string, 2> a = {"a", "b"}; print(a);'
  );
  assert.equal(result.error_code, 0);
  const runtime = result.get_runtime();
  const lines = [];
  runtime.set_renderer((ops, strings) => lines.push(...strings));
  await runtime.execute();
  assert.equal(runtime.get_runtime_error().error_code, 0);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^ hello  42 true color\(\d+, \d+, \d+, 255\)$/);
  assert.equal(lines[1], '');
  assert.equal(lines[2], '{"a", "b"}');
  console.log('Runtime print checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
