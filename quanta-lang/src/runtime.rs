use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::{future_to_promise, spawn_local};
use quanta_parser::{ast::keys::key_to_number};

use crate::{execution::{Execution, Scope}, program::Program, utils::{canvas::Canvas, message::RuntimeError, scheduler::Scheduler}};

use std::{collections::HashMap, sync::{Arc, Mutex}};

#[wasm_bindgen]
#[derive(Clone)]
pub struct Runtime {
    main_execution: Execution,
    key_execution: Option<Execution>,
    mouse_execution: Option<Execution>,
    canvas: Canvas,
    scheduler: Scheduler,
    runtime_error: Arc<Mutex<RuntimeError>>,
}


#[wasm_bindgen]
impl Runtime {
    /// Sets the JS function `(commands: string[], present: bool) => void`
    /// that draws the program's output.
    pub fn set_renderer(&self, renderer: js_sys::Function) {
        self.canvas.set_renderer(Some(renderer));
    }

    /// Runs `main`. The returned promise resolves when the program ends,
    /// fails (see `get_runtime_error`) or is stopped.
    pub fn execute(&self) -> js_sys::Promise {
        let runtime_error = Arc::clone(&self.runtime_error);
        let scheduler = self.scheduler.clone();
        let canvas = self.canvas.clone();
        let mut new_exec = self.main_execution.clone();
        future_to_promise(async move {
            if runtime_error.lock().unwrap().error_code != 0 {
                return Ok(JsValue::UNDEFINED);
            }
            scheduler.start();
            let result = new_exec.execute().await;
            canvas.flush(false);
            if let Err(err) = result {
                if !scheduler.is_cancelled() {
                    *runtime_error.lock().unwrap() = RuntimeError::new(err);
                }
            }
            Ok(JsValue::UNDEFINED)
        })
    }

    /// Stops `main` and any running event handlers at their next pause, and
    /// discards anything they would still draw.
    pub fn stop(&self) {
        self.scheduler.cancel();
        self.canvas.set_renderer(None);
    }

    pub fn execute_key(&self, key: String) {
        if let Some(key_code) = key_to_number(key.as_str()) {
            if let Some(exec) = self.key_execution.clone() {
                    spawn_local(async move {
                    match exec.clone().execute_key(key_code).await {
                    Ok(_) => exec.canvas.flush(false),
                    Err(_) if exec.scheduler.is_cancelled() => {},
                    Err(err) => {
                        panic!("Got error: {}", err);
                    }
                }
                })
            }   
        }
    }

    pub fn execute_mouse(&self, x: i32, y:i32) {
        if let Some(exec) = self.mouse_execution.clone() {
                spawn_local(async move {
                match exec.clone().execute_mouse(x, y).await {
                Ok(_) => exec.canvas.flush(false),
                Err(_) if exec.scheduler.is_cancelled() => {},
                Err(err) => {
                    panic!("Got error: {}", err);
                }
            }
            })
        }   
    }

    pub fn get_runtime_error(&self) -> RuntimeError {
        self.runtime_error.lock().unwrap().clone()
    }
}

impl Runtime {
    pub async fn new(prog : Program, canvas: Canvas) -> Runtime {
        //let exec = Execution::from_program(prog.clone(), canv);
        let global_vars = Arc::new(Mutex::new(HashMap::new()));
        let global_var_defs = Arc::new(Mutex::new(prog.global_vars));
        let fig_col = Arc::new(Mutex::new(String::from("#ffffff")));
        let lin_col = Arc::new(Mutex::new(String::from("#000000")));
        let lin_wid = Arc::new(Mutex::new(1));
        let scheduler = Scheduler::new();

        let exec = Execution {
            lines : prog.lines.clone(),
            scope : Arc::new(Mutex::new(Scope { variables: HashMap::new(), outer_scope: None })),
            global_vars: Arc::clone(&global_vars),
            canvas: canvas.clone(),
            scheduler: scheduler.clone(),
            functions: prog.functions.clone(),
            figure_color: Arc::clone(&fig_col),
            line_color: Arc::clone(&lin_col),
            line_width: Arc::clone(&lin_wid),
            random_color: Arc::new(Mutex::new(0)),
            expanded_arrays: Arc::new(Mutex::new(prog.expanded_arrays.clone()))
        };

        let keyboard_exec = if exec.functions.contains_key("keyboard") {
            let mut c = exec.clone();
            c.scope = Arc::new(Mutex::new(Scope { variables: HashMap::new(), outer_scope: None }));
            Some(c)
        } else { 
            None 
        };

        let mouse_exec = if exec.functions.contains_key("mouse") { 
            let mut c = exec.clone();
            c.scope = Arc::new(Mutex::new(Scope { variables: HashMap::new(), outer_scope: None }));
            Some(c)
        } else { 
            None 
        };

        let defs = global_var_defs.lock().unwrap();

        let mut runtime_error = RuntimeError::zero();

        for (name, (_, expr)) in defs.iter() {
            let val = exec.calculate_expression(expr.clone()).await;
            match val {
                Ok(value) => {
                    exec.global_vars.lock().unwrap().insert(name.clone(), value)
                },
                Err(e) => {runtime_error = RuntimeError::new(e); break;}
            };
        }

        Runtime { 
            main_execution: exec, 
            key_execution: keyboard_exec,
            mouse_execution: mouse_exec,
            canvas,
            scheduler,
            runtime_error: Arc::new(Mutex::new(runtime_error)),
        }
    }
}