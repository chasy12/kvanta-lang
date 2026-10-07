// The first-visit example must react visibly to keys and clicks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Compiler } = require(process.argv[2]);
const watchdog = setTimeout(() => { console.error('Example program checks timed out'); process.exit(1); }, 10000);

// Operand counts per op code, matching OP in web/canvas-runtime.js.
const SIZES = { 1: 0, 2: 0, 3: 3, 4: 4, 5: 4, 6: 5, 8: 3, 9: 1, 10: 10 };

/** Rectangles in a batch of drawing ops, each with the fill colour in effect. */
function rectangles(ops) {
  const found = [];
  let fill;
  for (let i = 0; i < ops.length;) {
    const op = ops[i];
    if (op === 8) fill = ops[i + 1];
    if (op === 4) found.push({ at: Array.from(ops.slice(i + 1, i + 5)), fill });
    i += op === 7 ? 2 + ops[i + 1] : 1 + SIZES[op];
  }
  return found;
}

async function start(source) {
  const result = await Compiler.new().compile_code(source);
  assert.equal(result.error_code, 0, result.error_code ? result.get_error_message() : source);
  const runtime = result.get_runtime();
  let drawn = [];
  runtime.set_renderer(ops => drawn.push(...rectangles(ops)));
  await runtime.execute();
  assert.equal(runtime.get_runtime_error().error_code, 0, runtime.get_runtime_error().get_error_message());
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  return {
    runtime,
    async drawnAfter(action) { drawn = []; action(); await settle(); return drawn; },
    drawn: () => drawn,
  };
}

/** The packed fill colour the runtime uses for `Color::<name>`. */
async function fillOf(name) {
  const probe = await start(`setFigureColor(Color::${name}); rectangle(0, 0, 1, 1);`);
  probe.runtime.stop();
  return probe.drawn()[0].fill;
}

(async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../web/example-program.js'), 'utf8');
  const { EXAMPLE_PROGRAM } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  const [red, blue, green, yellow] = await Promise.all(['Red', 'Blue', 'Green', 'Yellow'].map(fillOf));

  const example = await start(EXAMPLE_PROGRAM);
  const swatch = [0, 0, 100, 100];
  assert.deepEqual(example.drawn().at(-1), { at: swatch, fill: red }, 'main draws a red colour swatch');

  for (const [key, fill] of [[' ', blue], ['a', green], ['q', yellow]]) {
    const drawn = await example.drawnAfter(() => example.runtime.execute_key(key));
    assert.deepEqual(drawn, [{ at: swatch, fill }], `key ${JSON.stringify(key)} recolours the swatch`);
  }

  const clicked = await example.drawnAfter(() => example.runtime.execute_mouse(500, 500));
  assert.deepEqual(clicked, [{ at: [500, 500, 600, 600], fill: yellow }], 'a click draws a square in the chosen colour');

  example.runtime.stop();
  clearTimeout(watchdog);
  console.log('Example program checks passed');
})().catch(error => { console.error(error); process.exit(1); });
