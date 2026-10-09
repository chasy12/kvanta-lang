use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::{future_to_promise, spawn_local};
use quanta_parser::{ast::{keys::key_to_number, AstProgram, AstStatement, Expression}, error::Error};

use crate::{execution::{pack_color, Execution, Scope, StackUse}, program::Program, utils::{canvas::Canvas, message::RuntimeError, scheduler::Scheduler, input::Input}};

use std::{collections::HashMap, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}};
use crate::utils::text::TextStyle;

#[wasm_bindgen]
#[derive(Clone)]
pub struct Runtime {
    main_execution: Execution,
    key_execution: Option<Execution>,
    mouse_execution: Option<Execution>,
    canvas: Canvas,
    scheduler: Scheduler,
    input: Input,
    global_initializers: Arc<Vec<(String, Expression)>>,
    initialized: Arc<AtomicBool>,
    runtime_error: Arc<Mutex<RuntimeError>>,
    error_handler: Arc<Mutex<Option<js_sys::Function>>>,
}


#[wasm_bindgen]
impl Runtime {
    /// Sets the JS function `(commands: string[], present: bool) => void`
    /// that draws the program's output.
    pub fn set_renderer(&self, renderer: js_sys::Function) {
        self.canvas.set_renderer(Some(renderer));
    }

    /// Sets `(kind: string | string[]) => Promise<string | null>` for console input.
    pub fn set_input_handler(&self, handler: js_sys::Function) {
        self.input.set_handler(handler);
    }

    /// Runs `main`. The returned promise resolves when the program ends,
    /// fails (see `get_runtime_error`) or is stopped.
    pub fn execute(&self) -> js_sys::Promise {
        let runtime_error = Arc::clone(&self.runtime_error);
        let scheduler = self.scheduler.clone();
        let canvas = self.canvas.clone();
        let mut new_exec = self.main_execution.clone();
        let global_initializers = Arc::clone(&self.global_initializers);
        let initialized = Arc::clone(&self.initialized);
        future_to_promise(async move {
            if scheduler.is_cancelled() || runtime_error.lock().unwrap().error_code != 0 {
                return Ok(JsValue::UNDEFINED);
            }
            scheduler.start();
            let result = async {
                if !initialized.load(Ordering::SeqCst) {
                    for (name, expr) in global_initializers.iter() {
                        let value = new_exec.calculate_expression(expr).await?;
                        new_exec.global_vars.lock().unwrap().insert(name.clone(), value);
                    }
                    if scheduler.is_cancelled() {
                        return Ok(());
                    }
                    initialized.store(true, Ordering::SeqCst);
                }
                new_exec.execute().await
            }.await;
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
        self.input.cancel();
        self.canvas.set_renderer(None);
    }

    /// Sets the JS function `(error: RuntimeError) => void` called when a
    /// `keyboard` or `mouse` handler fails.
    pub fn set_error_handler(&self, handler: js_sys::Function) {
        *self.error_handler.lock().unwrap() = Some(handler);
    }

    pub fn execute_key(&self, key: String) {
        if !self.initialized.load(Ordering::SeqCst) || self.scheduler.is_cancelled() {
            return;
        }
        if let Some(key_code) = key_to_number(key.as_str()) {
            if let Some(exec) = self.key_execution.clone() {
                let error_handler = Arc::clone(&self.error_handler);
                spawn_local(async move {
                    let result = exec.clone().execute_key(key_code).await;
                    Self::finish_handler(&exec, result, &error_handler);
                })
            }
        }
    }

    pub fn execute_mouse(&self, x: i32, y:i32) {
        if !self.initialized.load(Ordering::SeqCst) || self.scheduler.is_cancelled() {
            return;
        }
        if let Some(exec) = self.mouse_execution.clone() {
            let error_handler = Arc::clone(&self.error_handler);
            spawn_local(async move {
                let result = exec.clone().execute_mouse(x, y).await;
                Self::finish_handler(&exec, result, &error_handler);
            })
        }
    }

    pub fn get_runtime_error(&self) -> RuntimeError {
        self.runtime_error.lock().unwrap().clone()
    }
}

impl Runtime {
    /// Shows what an event handler drew, or reports its error.
    fn finish_handler(exec: &Execution, result: Result<(), Error>, error_handler: &Arc<Mutex<Option<js_sys::Function>>>) {
        match result {
            Ok(_) => exec.canvas.flush(false),
            Err(_) if exec.scheduler.is_cancelled() => {},
            Err(err) => {
                exec.canvas.flush(false);
                let handler = error_handler.lock().unwrap().clone();
                if let Some(handler) = handler {
                    let _ = handler.call1(&JsValue::NULL, &JsValue::from(RuntimeError::new(err)));
                }
            }
        }
    }

    pub async fn new(prog : Program, canvas: Canvas) -> Runtime {
        //let exec = Execution::from_program(prog.clone(), canv);
        let global_vars = Arc::new(Mutex::new(HashMap::new()));
        // The checker stores definitions by name; recover their source order
        // from the original AST while using its checked/expanded expressions.
        let global_initializers = match &prog.lines {
            AstProgram::Forest(forest) => forest.1.iter().filter_map(|(statement, _)| {
                if let AstStatement::Init { val, .. } = statement {
                    prog.global_vars.get(val).map(|(_, expr)| (val.clone(), expr.clone()))
                } else {
                    None
                }
            }).collect(),
            AstProgram::Block(_) => Vec::new(),
        };
        let fig_col = Arc::new(Mutex::new(pack_color(255, 255, 255, 255)));
        let lin_col = Arc::new(Mutex::new(pack_color(0, 0, 0, 255)));
        let lin_wid = Arc::new(Mutex::new(1));
        let scheduler = Scheduler::new();
        let input = Input::default();

        let exec = Execution {
            lines : Arc::new(prog.lines.clone()),
            scope : Arc::new(Mutex::new(Scope { variables: HashMap::new(), outer_scope: None })),
            global_vars: Arc::clone(&global_vars),
            canvas: canvas.clone(),
            scheduler: scheduler.clone(),
            input: input.clone(),
            functions: Arc::new(prog.functions.clone()),
            figure_color: Arc::clone(&fig_col),
            line_color: Arc::clone(&lin_col),
            line_width: Arc::clone(&lin_wid),
            text_style: Arc::new(Mutex::new(TextStyle::default())),
            random_color: Arc::new(Mutex::new(0)),
            expanded_arrays: Arc::new(Mutex::new(prog.expanded_arrays.clone())),
            stack: Arc::new(StackUse::default()),
        };

        let keyboard_exec = if exec.functions.contains_key("keyboard") {
            let mut c = exec.clone();
            c.scope = Arc::new(Mutex::new(Scope { variables: HashMap::new(), outer_scope: None }));
            c.stack = Arc::new(StackUse::default());
            Some(c)
        } else { 
            None 
        };

        let mouse_exec = if exec.functions.contains_key("mouse") { 
            let mut c = exec.clone();
            c.scope = Arc::new(Mutex::new(Scope { variables: HashMap::new(), outer_scope: None }));
            c.stack = Arc::new(StackUse::default());
            Some(c)
        } else { 
            None 
        };

        Runtime { 
            main_execution: exec, 
            key_execution: keyboard_exec,
            mouse_execution: mouse_exec,
            canvas,
            scheduler,
            input,
            global_initializers: Arc::new(global_initializers),
            initialized: Arc::new(AtomicBool::new(false)),
            runtime_error: Arc::new(Mutex::new(RuntimeError::zero())),
            error_handler: Arc::new(Mutex::new(None)),
        }
    }
}

#[cfg(test)]
mod tests {
    use futures::executor::block_on;
    use quanta_parser::{ast::{AstProgram, AstStatement, BaseValueType}, parse_ast};

    use crate::{program::create_program, runtime::Runtime, utils::canvas::Canvas};

    // Type checks `source` and evaluates the expression of its last variable initialization.
    // Evaluate expressions directly to avoid the browser scheduler used by statements.
    fn eval_last_init(source: &str) -> Result<BaseValueType, String> {
        let ast = parse_ast(source).map_err(|e| e.to_string())?;
        let mut program = create_program(ast);
        program.type_check().map_err(|e| e.to_string())?;
        let expr = match &program.lines {
            AstProgram::Block(block) => block.nodes.iter().rev().find_map(|node| match &node.statement {
                AstStatement::Init { expr, .. } => Some(expr.clone()),
                _ => None,
            }),
            AstProgram::Forest(_) => None,
        }.expect("source must contain a variable initialization");
        let canvas = Canvas::new();
        let runtime = block_on(Runtime::new(program, canvas));
        let value = block_on(runtime.main_execution.clone().calculate_expression(&expr)).map_err(|e| e.to_string())?;
        Ok(value.val)
    }

    #[test]
    fn abs_of_int_returns_int() {
        assert_eq!(eval_last_init("int x = abs(-3);"), Ok(BaseValueType::Int(3)));
        assert_eq!(eval_last_init("int x = abs(4);"), Ok(BaseValueType::Int(4)));
    }

    #[test]
    fn abs_of_float_returns_float() {
        assert_eq!(eval_last_init("float x = abs(-3.5);"), Ok(BaseValueType::Float(3.5)));
        assert_eq!(eval_last_init("float x = abs(-1.5) * 2.0;"), Ok(BaseValueType::Float(3.0)));
    }

    #[test]
    fn abs_of_float_cannot_be_assigned_to_int() {
        assert!(eval_last_init("int x = abs(-3.5);").is_err());
    }

    #[test]
    fn abs_rejects_non_numeric_argument() {
        assert!(eval_last_init("int x = abs(true);").is_err());
    }

    #[test]
    fn abs_preserves_zero_and_nested_numeric_types() {
        assert_eq!(eval_last_init("int x = abs(0);"), Ok(BaseValueType::Int(0)));
        assert_eq!(eval_last_init("float x = abs(0.0);"), Ok(BaseValueType::Float(0.0)));
        assert_eq!(eval_last_init("int x = abs(abs(-3) - 5);"), Ok(BaseValueType::Int(2)));
        assert_eq!(eval_last_init("float x = abs(abs(-3.5) - 5.0);"), Ok(BaseValueType::Float(1.5)));
    }

    #[test]
    fn abs_reports_minimum_integer_overflow() {
        let error = eval_last_init("int x = abs(-2147483647 - 1);").unwrap_err();
        assert!(error.contains("abs: -2147483648 has no int absolute value (overflow)"), "{}", error);
    }

    #[test]
    fn abs_checks_expression_and_command_arguments() {
        for source in [
            "int x = abs();", "int x = abs(1, 2);", "int x = abs(true);",
            "int x = abs(\"text\");", "abs();", "abs(1, 2);", "abs(true);", "abs(\"text\");",
        ] {
            let ast = parse_ast(source).unwrap();
            assert!(create_program(ast).type_check().is_err(), "{}", source);
        }
        for source in [
            "abs(-3);", "abs(-3.5);",
            "func magnitude(float value) -> float { return abs(value); } func main() { float x = magnitude(-3.5); }",
        ] {
            let ast = parse_ast(source).unwrap();
            assert!(create_program(ast).type_check().is_ok(), "{}", source);
        }
    }

    #[test]
    fn and_and_or_skip_the_right_side_when_the_left_decides() {
        // The right side divides by zero, so it errors if it runs.
        assert_eq!(eval_last_init("bool b = false && 1 / 0 == 1;"), Ok(BaseValueType::Bool(false)));
        assert_eq!(eval_last_init("bool b = true || 1 / 0 == 1;"), Ok(BaseValueType::Bool(true)));
        assert_eq!(eval_last_init("bool b = 1 > 2 && 1 / 0 == 1 || true;"), Ok(BaseValueType::Bool(true)));
        assert_eq!(eval_last_init("bool b = 2 > 1 || 1 / 0 == 1 && false;"), Ok(BaseValueType::Bool(true)));
    }

    #[test]
    fn and_and_or_still_evaluate_the_right_side_when_needed() {
        assert!(eval_last_init("bool b = true && 1 / 0 == 1;").unwrap_err().contains("Division by 0"));
        assert!(eval_last_init("bool b = false || 1 / 0 == 1;").unwrap_err().contains("Division by 0"));
        assert_eq!(eval_last_init("bool b = true && false;"), Ok(BaseValueType::Bool(false)));
        assert_eq!(eval_last_init("bool b = true && true;"), Ok(BaseValueType::Bool(true)));
        assert_eq!(eval_last_init("bool b = false || true;"), Ok(BaseValueType::Bool(true)));
        assert_eq!(eval_last_init("bool b = false || false;"), Ok(BaseValueType::Bool(false)));
    }

    #[test]
    fn int_arithmetic_reports_overflow_instead_of_wrapping() {
        for source in [
            "int x = 2147483647 + 1;",
            "int x = -2147483647 - 2;",
            "int x = 65536 * 65536;",
            "int x = 2147483647 * 2;",
            "int x = -(-2147483647 - 1);",
            "int x = 479001600 * 13;",
        ] {
            let error = eval_last_init(source).unwrap_err();
            assert!(error.contains("Integer overflow"), "{}: {}", source, error);
        }
    }

    #[test]
    fn int_arithmetic_at_the_limits_is_exact() {
        assert_eq!(eval_last_init("int x = 2147483646 + 1;"), Ok(BaseValueType::Int(i32::MAX)));
        assert_eq!(eval_last_init("int x = -2147483647 - 1;"), Ok(BaseValueType::Int(i32::MIN)));
        assert_eq!(eval_last_init("int x = 46340 * 46340;"), Ok(BaseValueType::Int(2147395600)));
        assert_eq!(eval_last_init("int x = -(2147483647);"), Ok(BaseValueType::Int(-2147483647)));
        assert_eq!(eval_last_init("int x = -3 * -4 + -5;"), Ok(BaseValueType::Int(7)));
    }

    #[test]
    fn random_covers_every_value_of_a_range_including_negative_ones() {
        use crate::execution::random_in_range;
        for (low, high) in [(-5, 5), (-5, -1), (0, 5), (3, 9), (-1, 1), (7, 7), (-2, 0)] {
            let count = (high - low + 1) as usize;
            let mut hits = vec![0usize; count];
            // Sweep the unit interval evenly: each value owns an equal share of it.
            let steps = 1000 * count;
            for step in 0..steps {
                let unit = step as f64 / steps as f64;
                let value = random_in_range(low, high, unit);
                assert!(value >= low && value <= high, "{value} outside [{low}, {high}]");
                hits[(value - low) as usize] += 1;
            }
            assert!(hits.iter().all(|hit| *hit == 1000), "{low}..{high}: {hits:?}");
        }
    }

    #[test]
    fn random_does_not_overflow_on_wide_ranges() {
        use crate::execution::random_in_range;
        for unit in [0.0, 0.25, 0.5, 0.75, 0.999999999999] {
            let value = random_in_range(-2_000_000_000, 2_000_000_000, unit);
            assert!((-2_000_000_000..=2_000_000_000).contains(&value));
            let value = random_in_range(i32::MIN, i32::MAX, unit);
            assert!((i32::MIN..=i32::MAX).contains(&value));
        }
        assert_eq!(random_in_range(i32::MIN, i32::MAX, 0.0), i32::MIN);
        assert_eq!(random_in_range(i32::MIN, i32::MAX, 0.9999999999999999), i32::MAX);
        assert_eq!(random_in_range(-2_000_000_000, 2_000_000_000, 0.0), -2_000_000_000);
    }

    #[test]
    fn random_in_range_is_inclusive_at_both_ends() {
        use crate::execution::random_in_range;
        assert_eq!(random_in_range(-5, 5, 0.0), -5);
        assert_eq!(random_in_range(-5, 5, 0.9999999999999999), 5);
        assert_eq!(random_in_range(0, 1, 0.5), 1);
    }

    #[test]
    fn long_strings_are_rejected() {
        use crate::execution::{join_strings, MAX_STRING_LENGTH};
        assert_eq!(join_strings("ab", "cd").as_deref(), Some("abcd"));
        let half = "x".repeat(MAX_STRING_LENGTH / 2);
        assert_eq!(join_strings(&half, &half).map(|s| s.chars().count()), Some(MAX_STRING_LENGTH));
        assert_eq!(join_strings(&half, &format!("{half}y")), None);
        // Characters count, not bytes.
        let cyrillic = "ї".repeat(MAX_STRING_LENGTH);
        assert_eq!(join_strings(&cyrillic, ""), Some(cyrillic.clone()));
        assert_eq!(join_strings(&cyrillic, "ї"), None);
    }

    #[test]
    fn stack_budget_is_returned_when_code_ends_and_refuses_calls_at_the_limit() {
        use crate::execution::{StackUse, CALL_RESERVE_UNITS, CALL_UNITS, EXPRESSION_UNITS, MAX_STACK_UNITS};
        use std::sync::Arc;
        let stack = Arc::new(StackUse::default());
        let mut calls = vec![];
        let error = loop {
            match StackUse::enter(&stack, CALL_UNITS, CALL_RESERVE_UNITS, true, (1, 1, 1, 2)) {
                Ok(guard) => calls.push(guard),
                Err(error) => break error,
            }
        };
        assert_eq!(error.message, format!("Too many nested function calls (more than {}). Is there a recursion without an end?", calls.len()));
        assert_eq!((error.start, error.finish), ((1, 1), (1, 2)));
        assert!(calls.len() >= 100, "{} calls", calls.len());
        assert!(stack.units_in_use() + CALL_RESERVE_UNITS <= MAX_STACK_UNITS);
        // Plain expressions can still use the reserve, and everything is freed in the end.
        let inner = StackUse::enter(&stack, EXPRESSION_UNITS, 0, false, (0, 0, 0, 0)).unwrap();
        drop(inner);
        drop(calls);
        assert_eq!(stack.units_in_use(), 0);
        assert!(StackUse::enter(&stack, CALL_UNITS, CALL_RESERVE_UNITS, true, (0, 0, 0, 0)).is_ok());
    }
}
