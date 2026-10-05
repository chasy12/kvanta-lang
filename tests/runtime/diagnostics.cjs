const assert = require('node:assert/strict');
const { Compiler } = require(process.argv[2]);

async function check(source, count, rows) {
  const compiler = Compiler.new();
  assert.equal(typeof compiler.check_code, 'function', 'background verification must have a side-effect-free API');
  const result = await compiler.check_code(source);
  const errors = result.get_errors();
  assert.equal(errors.length, count, source + '\n' + errors.map(e => e.get_error_message()).join('\n'));
  if (rows) assert.deepEqual(errors.map(e => e.start_row), rows);
  if (count) {
    assert.notEqual(result.error_code, 0);
    assert.equal(result.get_error().get_error_message(), errors[0].get_error_message());
    const compiled = await Compiler.new().compile_code(source);
    assert.notEqual(compiled.error_code, 0, 'invalid recovered programs must never run');
    assert.equal(compiled.get_errors().length, count);
  } else assert.equal(result.error_code, 0);
  return errors;
}

(async () => {
  await check('circle(1,,3);\nrectangle(1,,3,4);', 2, [1, 2]);
  await check('circle(1,,3); rectangle(1,,3,4);', 2, [1, 1]);
  await check('int a = true;\nint b = false;\ncircle(a,b,2);', 2, [1, 2]);
  await check('func one() {\n if (1) { int a = true; } else { int b = false; }\n}\nfunc main() {\n int c = true;\n}', 4, [2, 2, 2, 5]);
  await check('circle(missing, absent, 1);', 2, [1, 1]);
  await check('print(missing);', 1, [1]);
  await check('int a = missing + absent;', 2, [1, 1]);
  await check('color a = Color::Nope; color b = Color::Wrong;', 2, [1, 1]);
  await check('int a = missing() + absent();', 2, [1, 1]);
  await check('array<color,2> palette = {Color::Nope,Color::Wrong};', 2, [1, 1]);
  await check('int key = Key::Nope + Key::Wrong;', 2, [1, 1]);
  await check('int a = print("bad"); int b = circle(1,2,3);', 2, [1, 1]);
  await check('int a = 1; int a = missing; int b = true;', 3, [1, 1, 1]);
  await check('func one() -> int { int a = true; } func main() {}', 2, [1, 1]);
  await check('// lead comment\nfunc first() { circle(1,,2); rectangle(1,,2,3); }\nfunc main() { circle(1,,2); }', 3, [2, 2, 3]);
  await check('func\tfirst() {\n circle(1,,2);\n rectangle(1,,2,3);\n}\nfunc main() { int c = true; }', 3, [2, 3, 5]);
  await check('int a = 1\nint b = 2\ncircle(true,false,1);', 4, [1, 2, 3, 3]);
  const sameLine = await check('circle(1,,3); rectangle(1,,3,4);', 2, [1, 1]);
  assert.ok(sameLine[1].get_error_message().includes('circle(1,,3);'), 'messages retain original source context');
  const incomplete = await Compiler.new().check_code('func main() { circle(1,,2);');
  assert.notEqual(incomplete.error_code, 0, 'unclosed blocks terminate verification with errors');
  await check('int x = 999999999999999999999; float y = 999999999999999999999999999999999999999999999999999.0;', 2, [1, 1]);
  const unicode = await check('print("😀");\nint value = true;', 1, [2]);
  assert.equal(unicode[0].start_column, 1);
  await check('// punctuation ; { }\narray<int, 2> a = {1,2};\nprint("; { } 😀", a);', 0);
  await check('global { int x = 1 / 0; } func main() { print(x); }', 0);
  const constCopy = 'global { const int first=1; array<int,1> values={first}; } func main(){print(values);}';
  await check(constCopy, 0);
  assert.equal((await Compiler.new().compile_code(constCopy)).error_code, 0);
  console.log('Runtime diagnostics checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
