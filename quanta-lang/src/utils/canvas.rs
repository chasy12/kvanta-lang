use std::sync::{Arc, Mutex};

use js_sys::{Array, Function};
use wasm_bindgen::JsValue;

/// Collects drawing commands and hands them to the JS renderer in batches.
#[derive(Debug, Clone)]
pub struct Canvas {
    commands: Arc<Mutex<Vec<String>>>,
    renderer: Arc<Mutex<Option<Function>>>,
}

impl Canvas {
    pub fn new() -> Canvas {
        Canvas {
            commands: Arc::new(Mutex::new(vec![])),
            renderer: Arc::new(Mutex::new(None)),
        }
    }

    pub fn add_command(&self, c : String) {
        self.commands.lock().unwrap().push(c);
    }

    /// Sets the JS function `(commands: string[], present: bool) => void`
    /// that draws flushed commands. `None` discards further drawing.
    pub fn set_renderer(&self, renderer: Option<Function>) {
        *self.renderer.lock().unwrap() = renderer;
    }

    /// Sends buffered commands to the renderer. `present` shows the result
    /// on screen even in animation mode.
    pub fn flush(&self, present: bool) {
        let commands = std::mem::take(&mut *self.commands.lock().unwrap());
        if commands.is_empty() && !present {
            return;
        }
        let renderer = self.renderer.lock().unwrap().clone();
        if let Some(renderer) = renderer {
            let script: Array = commands.into_iter().map(JsValue::from).collect();
            let _ = renderer.call2(&JsValue::NULL, &script, &JsValue::from_bool(present));
        }
    }
}
