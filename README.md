# Kvanta-lang

A graphics-oriented programming language that runs in the browser. Write code, draw shapes, create animations — all in a browser-based IDE with real-time feedback.

The canvas is 1000×1000 virtual pixels and scales responsively to the window size.

## Quick Start

```
# Draw a red circle
setFigureColor(Color::Red);
circle(500, 500, 200);
```

Run the above directly — no functions needed for simple scripts.

Output of `print(...)` and any errors appear in the console under the canvas; click an
error's line number to jump to it. **Share** copies a link that opens the current program,
so you can send a drawing to someone. The **EN / УК** switch changes the interface and error
messages between English and Ukrainian.

## Language Features

### Data Types


| Type          | Example                                 |
| ------------- | --------------------------------------- |
| `int`         | `int x = 42;`                           |
| `float`       | `float ratio = 2.3;`                    |
| `bool`        | `bool on = true;`                       |
| `color`       | `color c = Color::Green;`               |
| `string`      | `string s = "hello";`                   |
| `array<T, N>` | `array<int, 5> nums = {1, 2, 3, 4, 5};` |


Arrays can be nested: `array<array<int, 3>, 3> grid = { {0,1,2}, {3,4,5}, {6,7,8} };`

Expanding array syntax: `array<int, 10> zeros = {0...};`

Arrays can also put their dimensions after the variable name:

```cpp
int values[2] = {10, 20};
int grid[2][3] = {{1, 2, 3}, {4, 5, 6}};
int zeros[2][3];
```

Each dimension must be a positive integer literal. `int grid[2][3]` has two
rows with three integers each, the same type as `array<array<int, 3>, 2>`.
An initializer must match that nested shape. Without an initializer, every
element gets its type's default: `0`, `0.0`, `false`, `""` or `Color::Black`
for `int`, `float`, `bool`, `string` or `color`, respectively.

Both declaration forms support indexing, assignment, function arguments,
`len()` and array iteration. Indexes start at zero: `grid[1][2]` accesses the
last element of the second row. `len(values)` returns an `int` with the number
of outer elements, so `len(grid)` is `2` and `len(grid[0])` is `3`.
You can use it directly in an index: `values[len(values) - 1]`.

Bracket dimensions also work in globals and function parameters:

```cpp
global {
    int grid[2][3];
}

func rowCount(int values[2][3]) -> int {
    return len(values);
}

func main() {
    int rows = rowCount(grid);
}
```

Strings support Unicode, concatenation with `+`, and comparisons with `==` and `!=`.
They work in variables, arrays, function arguments and return values. Both operands
of a string operation must be strings. Use `\"`, `\\`, `\n`, `\r` and `\t` for
quotes, backslashes, newlines, carriage returns and tabs.

`string(value)` converts a value to text explicitly when you need to build a
label. Conversion returns a new string and does not change the original value.
Drawing and printing format values automatically, while assignments and
arithmetic keep their type checks:

```cpp
int score = 42;
text(100, 100, score);
text(100, 160, "Score: " + string(score));
score = score + 1;
```

`"Score: " + score` and `string label = score;` are type errors. Use
`string(score)` when a string is required. The conversion takes exactly one
argument and accepts strings, numbers, booleans, colors and arrays.
An expansion such as `{0...}` needs a sized array declaration before you can
display or convert it, for example `int values[3] = {0...}; text(100, 100, values);`.

### Drawing Commands

```
circle(x, y, r)                    -- circle of radius r centered at (x, y)
rectangle(x1, y1, x2, y2)          -- rectangle from (x1, y1) to (x2, y2)
line(x1, y1, x2, y2)               -- line between two points
arc(x, y, r, a1, a2)               -- arc from angle a1 to a2 (degrees, CCW from X axis)
polygon(x1, y1, x2, y2, x3, y3, ..)-- polygon from N >= 3 points

setFigureColor(Color::Red)          -- fill color (default: white)
setLineColor(Color::Blue)           -- stroke color (default: black)
setLineWidth(3)                     -- line width in pixels (default: 1)
```

### Text

`text(x, y, content)` formats a value and draws it on the canvas. Coordinates and font sizes use
the same virtual pixels as shapes. `y` anchors the top of the first line. Newlines
start another line; text does not wrap automatically.

```cpp
string message = "Hello, " + "Kvanta!";

setTextColor(Color::Blue);
setTextSize(40);
setTextAlign("center");
setTextBold(true);

text(500, 200, message);
text(500, 280, "One red label", color: Color::Red, size: 28, bold: false);
text(500, 360, "Blue, 40px and bold again");
```

Setters change the program's text defaults. Named options override those defaults
for one draw, and can appear in any order after the three required arguments.
They currently apply to `text()` only. Text styling is independent of shape
colors and line widths, persists through `clear()` and `frame()`, and is shared
with functions and event handlers. Each new program starts with fresh defaults.

| Option | Setter | Type | Initial default |
| --- | --- | --- | --- |
| `color` | `setTextColor(color)` | `color` | `Color::White` |
| `size` | `setTextSize(size)` | positive `int` | `24` |
| `font` | `setTextFont(font)` | non-empty `string` | `"system-ui"` |
| `align` | `setTextAlign(align)` | `string` | `"left"` |
| `bold` | `setTextBold(bold)` | `bool` | `false` |
| `italic` | `setTextItalic(italic)` | `bool` | `false` |
| `lineHeight` | `setTextLineHeight(lineHeight)` | positive finite `float` | `1.2` |

Alignment accepts `"left"`, `"center"`, `"right"`, `"start"` or `"end"`.
Fonts can be generic families such as `"serif"` or `"monospace"`, or a font name
available on the device, such as `"Arial"`. No font files are downloaded.
`lineHeight` multiplies the font size to set the distance between lines.

```cpp
setTextFont("monospace");
setTextItalic(true);
text(100, 100, "First line\nSecond line", lineHeight: 1.5);
```

### Console output

`print(value, ...)` sends values to the browser's developer console, separated
by spaces. It uses the same formatting as `text()` and `string(value)` and is
independent of text styling. Strings appear without added quotation marks;
arrays keep braces and quoted string elements so their structure stays readable.

```cpp
int score = 42;
print("Score:", score, true); // Console: Print:Score: 42 true
text(100, 100, {1, 2, 3});    // Canvas: {1, 2, 3}
```
### Console Output

```
print("Hello!");                    -- prints a line in the console
print("x =", x, "y =", y);          -- any number of values of any type, joined by spaces
```

Click the console header to close or reopen it. While closed, a dot marks new output;
a red dot marks new errors. Drag the divider above the console to adjust its height,
or focus the divider and use the arrow keys.

Strings print without quotes, colors show a swatch, and identical lines in a row collapse
into one with a ×N count. Each line shows the time since the program started.

### Colors

```
Color::Red, Color::Green, Color::Blue, Color::Yellow,
Color::Pink, Color::White, Color::Black, ...
Color::Random                       -- random color
rgb(r, g, b)                        -- custom color from components
Color::Transparent                  -- no fill / transparent
```

### Math Functions

```
abs(x)            -- absolute value
round(x)          -- round to nearest int
ceil(x)           -- round up
floor(x)          -- round down
sqrt(x)           -- square root
decimal(x)        -- cast int to float  (5 / 2 == 2, decimal(5) / 2 == 2.5)
random(a, b)      -- random int in [a, b]
```

### Control Flow

```
if (condition) {
    ...
} else if (otherCondition) {
    ...
} else {
    ...
}

for i in (0..10) { ... }    -- inclusive range; decrements if from > to
for value in values { ... } -- visits each element of an array
while (condition) { ... }
```

An `else if` chain checks conditions in order and runs the first matching
branch. It can end with an `else` branch.

Use `break;` to exit the innermost loop and `continue;` to skip to its next
iteration. Both work in range loops, array loops and `while` loops. They must
appear inside a loop in the same function.

```cpp
int values[4] = {10, 20, 30, 40};
for value in values {
    if (value == 20) { continue; }
    if (value == 40) { break; }
    circle(value, 100, 5);
}
```

Array iteration takes a snapshot when the loop starts. Each iteration gets a
copy of an element, including a copy of a row for nested arrays. Assigning to
the loop variable does not change the source array, and changing the source
array does not affect the remaining iterations. The loop variable is local
to the loop.

### Functions

```
func add(int a, int b) -> int {
    return a + b;
}

func draw() {
    circle(500, 500, 100);
}

func main() {
    draw();
}
```

When any function is defined, all top-level code must be inside functions. `main()` is the entry point.

### Global Variables

```
global {
    int score = 0;
    color currentColor = Color::Green;
}
```

Global blocks are accessible from all functions.

### Animation

```
animate()       -- enter animation mode (nothing renders until frame() is called)
frame()         -- show the current canvas, then wait for the next frame
setFps(n)       -- set the frame rate frame() keeps (default: 30)
setFps(0)       -- no cap: one frame per screen refresh (e.g. 60, 120 or 144 fps)
sleep(ms)       -- pause execution for ms milliseconds
```

`frame()` keeps a steady pace: the time your code spends drawing a frame counts
toward the frame, so a game loop with `frame()` at the end runs at the set rate
no matter how much work each frame does (as long as it fits in the frame).
While an animation runs, the Result pane shows the frame rate it actually reaches.

### Event Handlers

Declare these functions to handle input events:

```
func mouse(int x, int y) {
    -- called on canvas click at position (x, y)
}

func keyboard(int key) {
    -- called on keypress when canvas is focused
    if (key == Key::Space) { ... }
    if (key == Key::A) { ... }    -- 'A' key, etc.
}
```

The canvas gains focus on program start or when clicked.

### Example: Interactive Drawing

```
global {
    color c = Color::Blue;
}

func mouse(int x, int y) {
    setFigureColor(c);
    circle(x, y, 20);
}

func keyboard(int key) {
    if (key == Key::Space) {
        c = Color::Random;
    }
}

func main() {
    while (true) {
        
    }
}
```

### Example: Animation

```
func main() {
    animate();
    setFps(60);
    for i in (0..360) {
        setFigureColor(Color::Red);
        circle(500 + round(decimal(i) * 3.14159 / 180.0 * 200.0), 500, 30);
        frame();
    }
}
```

## Installation & Build

### Prerequisites

- [Rust](https://rustup.rs/) with `wasm-pack`: `cargo install wasm-pack`
- [Node.js](https://nodejs.org/) (for Vite frontend)
- [Tree-sitter CLI](https://tree-sitter.github.io/tree-sitter/creating-parsers#installation) (optional, for grammar development)

### Build

```bash
# 1. Clone the repo
git clone <repo-url>
cd kvanta-lang

# 2. Compile Rust → WASM
cd quanta-lang
wasm-pack build --release --target web

# 3. Install frontend dependencies
cd ..
npm install

# 4. Start dev server
npm run dev
```

Then open [http://localhost:5173](http://localhost:5173).

### Deployment

The site is built and published by GitHub Actions (`.github/workflows/deploy.yml`).
Every push to `main` compiles the interpreter, runs the tests, builds the IDE and
deploys `dist/` to GitHub Pages. Pull requests run the same build and tests without
deploying. Built files are not committed to the repo.

One-time setup for a new repo or fork: Settings → Pages → Source: **GitHub Actions**.
The site then appears at `https://<owner>.github.io/<repo>/`.

To check a production build locally:

```bash
npm run build
npm run preview
```

## Project Structure

```
kvanta-lang/
├── grammar/                 # Parser grammar
│   ├── quanta.grammar       # Lezer grammar (frontend syntax highlighting)
│   ├── grammar.pest         # Pest PEG grammar (backend parser)
│   └── highlight.js         # Syntax highlight rules
│
├── quanta_parser/           # Rust: PEG parser → AST
│   └── src/
│       ├── ast.rs           # AST node types
│       └── ast/builder.rs   # AST construction from parse tree
│
├── quanta-lang/             # Rust: compiler + runtime (compiled to WASM)
│   └── src/
│       ├── compiler.rs      # Compilation pipeline
│       ├── program.rs       # Type checker
│       ├── execution.rs     # Tree-walking interpreter
│       └── runtime.rs       # WASM bindings
│
├── web/                     # Frontend IDE
│   ├── main.js              # Editor setup, WASM integration
│   ├── canvas-runtime.js    # Canvas drawing API
│   ├── console-panel.js     # Console: print() output, run status, errors
│   ├── i18n.js              # English / Ukrainian interface strings
│   ├── error-messages.js    # Ukrainian translations of compiler/runtime errors
│   ├── fps-counter.js       # Frame rate readout in animate mode
│   ├── share-link.js        # Programs encoded in #code= links
│   └── quanta-support.ts    # CodeMirror language support
│
├── .github/workflows/       # Build, test and deploy to GitHub Pages
│
└── index.html               # Single-page app
```

## Tech Stack

- **Pest** — PEG parser for the backend compiler
- **Lezer** — LR parser for real-time syntax highlighting in the IDE
- **Rust + wasm-pack** — compiler and interpreter compiled to WebAssembly
- **CodeMirror 6** — code editor with syntax highlighting and autocomplete
- **Vite** — frontend build tool and dev server
- **HTML5 Canvas** — rendering target

## Translations

Ukrainian is the default language. A language selected with EN / УК is remembered.

Interface strings live in `web/i18n.js`. Compiler and runtime error messages are
translated in `web/error-messages.js`, keyed by the Rust format string. When you add or
change an error message in the Rust sources, add its Ukrainian translation there:
`npm test` fails and lists any message without one.

## Running web runtime tests

Install dependencies first (only needed once):
```
npm install
```

Run all unit tests once:
```
npm test
```

Build the interpreter with `wasm-pack build --release --target web` in
`quanta-lang/` first. The text tests run real programs through WASM and the
canvas renderer, so rebuild after changing Rust code or the backend grammar.

Run in watch mode (re-runs on file save):
```
npm run test:watch
```
