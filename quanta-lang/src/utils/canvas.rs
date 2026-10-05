use std::sync::{Arc, Mutex};

use js_sys::{Array, Float64Array, Function};
use wasm_bindgen::JsValue;
use super::text::TextStyle;

/// Opcodes of the drawing buffer. Keep in sync with `OP` in web/canvas-runtime.js.
pub mod op {
    pub const CLEAR: f64 = 1.0;
    pub const ANIMATE: f64 = 2.0;
    /// x, y, radius
    pub const CIRCLE: f64 = 3.0;
    /// x1, y1, x2, y2
    pub const RECTANGLE: f64 = 4.0;
    /// x1, y1, x2, y2
    pub const LINE: f64 = 5.0;
    /// x, y, radius, start angle, end angle (degrees)
    pub const ARC: f64 = 6.0;
    /// number of coordinates n, then n coordinates x1, y1, x2, y2, ...
    pub const POLYGON: f64 = 7.0;
    /// fill color, stroke color (both 0xRRGGBBAA), line width
    pub const STYLE: f64 = 8.0;
    /// index into the strings passed alongside the buffer
    pub const PRINT: f64 = 9.0;
    /// x, y, content index, color, size, font index, alignment index, bold, italic, line height
    pub const TEXT: f64 = 10.0;
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Style {
    pub fill: u32,
    pub stroke: u32,
    pub width: i32,
}

#[derive(Debug, Default)]
struct Buffer {
    ops: Vec<f64>,
    strings: Vec<String>,
    /// Style the renderer will be using, so it's only sent when it changes.
    style: Option<Style>,
}

/// Collects drawing operations and hands them to the JS renderer in batches.
#[derive(Debug, Clone)]
pub struct Canvas {
    buffer: Arc<Mutex<Buffer>>,
    renderer: Arc<Mutex<Option<Function>>>,
}

impl Canvas {
    pub fn new() -> Canvas {
        Canvas {
            buffer: Arc::new(Mutex::new(Buffer::default())),
            renderer: Arc::new(Mutex::new(None)),
        }
    }

    /// Adds an operation without arguments, such as `op::CLEAR`.
    pub fn command(&self, op: f64) {
        self.buffer.lock().unwrap().ops.push(op);
    }

    /// Adds a shape drawn with `style`. For `op::POLYGON`, `args` are the coordinates.
    pub fn shape(&self, op: f64, args: &[f64], style: Style) {
        let mut buffer = self.buffer.lock().unwrap();
        if buffer.style != Some(style) {
            buffer.ops.extend_from_slice(&[op::STYLE, style.fill as f64, style.stroke as f64, style.width as f64]);
            buffer.style = Some(style);
        }
        buffer.ops.push(op);
        if op == op::POLYGON {
            buffer.ops.push(args.len() as f64);
        }
        buffer.ops.extend_from_slice(args);
    }

    pub fn print(&self, message: String) {
        let mut buffer = self.buffer.lock().unwrap();
        let index = buffer.strings.len() as f64;
        buffer.strings.push(message);
        buffer.ops.extend_from_slice(&[op::PRINT, index]);
    }

    pub fn text(&self, x: i32, y: i32, content: String, style: TextStyle) {
        let mut buffer = self.buffer.lock().unwrap();
        let index = buffer.strings.len() as f64;
        buffer.strings.extend([content, style.font, style.align]);
        buffer.ops.extend_from_slice(&[
            op::TEXT, x as f64, y as f64, index, style.color as f64,
            style.size as f64, index + 1.0, index + 2.0,
            u8::from(style.bold) as f64, u8::from(style.italic) as f64,
            style.line_height as f64,
        ]);
    }

    /// Sets the JS function `(ops: Float64Array, strings: string[], present: bool) => void`
    /// that draws flushed operations. `None` discards further drawing.
    pub fn set_renderer(&self, renderer: Option<Function>) {
        *self.renderer.lock().unwrap() = renderer;
    }

    /// Sends buffered operations to the renderer. `present` shows the result
    /// on screen even in animation mode.
    pub fn flush(&self, present: bool) {
        let Buffer { ops, strings, .. } = std::mem::take(&mut *self.buffer.lock().unwrap());
        if ops.is_empty() && !present {
            return;
        }
        let renderer = self.renderer.lock().unwrap().clone();
        if let Some(renderer) = renderer {
            let strings: Array = strings.into_iter().map(JsValue::from).collect();
            let _ = renderer.call3(&JsValue::NULL, &Float64Array::from(&ops[..]), &strings, &JsValue::from_bool(present));
        }
    }
}
