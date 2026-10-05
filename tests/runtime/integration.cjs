const assert = require('node:assert/strict');
const { Compiler } = require(process.argv[2]);
const watchdog = setTimeout(() => { console.error('Integrated language checks timed out'); process.exit(1); }, 10000);
async function run(source, values) {
  const result = await Compiler.new().compile_code(source);
  assert.equal(result.error_code, 0, result.error_code ? result.get_error_message() : source);
  const runtime = result.get_runtime(), output = [], kinds = [];
  runtime.set_renderer((ops, strings) => output.push(...strings));
  runtime.set_input_handler(kind => { kinds.push(kind); return Promise.resolve(values.shift()); });
  await runtime.execute();
  assert.equal(runtime.get_runtime_error().error_code, 0, runtime.get_runtime_error().get_error_message());
  runtime.stop();
  return { output, kinds };
}
(async () => {
  const strings = await run('string s="hello "+input(); bool b=input()=="ok"; print(s,b);', ['world','ok']);
  assert.deepEqual(strings, {output:['hello world true'],kinds:['string','string']});
  const indexed = await run('func idx(float v)->int{return round(v);} func main(){int a[2]; read(a[idx(input())]); print(a);}', ['1.2','7']);
  assert.deepEqual(indexed, {output:['{0, 7}'],kinds:['float','int']});
  const loops = await run('array<const float,2> a={1.0,2.0}; for value in a {read(value); print(value); if(value<0.0){continue;} break;} print(a);', ['-1.25','2.5']);
  assert.deepEqual(loops,{output:['-1.25','2.5','{1, 2}'],kinds:['float','float']});
  assert.deepEqual((await run('func f()->int{for item in {1,2}{return item;}} func main(){print(f());}', [])).output,['1']);
  const text=await run('text(0,0,42,size:input(),bold:input(),font:input(),lineHeight:input());',['20','true','Arial','1.5']);
  assert.deepEqual(text.kinds,['int','bool','string','float']);
  assert.equal(text.output[0],'42');
  const broken=Compiler.new().check_code('text(0,0,42,size:true,bold:1,unknown:3); break; continue; int n=true;');
  assert.equal(broken.get_errors().length,6);
  const escaped=Compiler.new().check_code('print("a\\\"b");\ncircle(1,,2);\nrectangle(1,,2,3);');
  assert.deepEqual(Array.from(escaped.get_errors(),error=>error.start_row),[2,3]);
  console.log('Integrated language checks passed');
})().catch(error => { console.error(error); process.exitCode=1; }).finally(()=>clearTimeout(watchdog));
