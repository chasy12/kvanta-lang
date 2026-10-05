use std::{collections::{HashMap, LinkedList}, sync::{Arc, Mutex}};

use quanta_parser::{ast::{AstBlock, AstNode, AstProgram, AstStatement, BaseValue, BaseValueType, Coords, Expression, ExpressionType, Operator, Type, UnaryOperator, VariableCall}, error::Error};
use quanta_parser::ast::BaseType;
use crate::utils::{canvas::{op, Canvas, Style}, scheduler::Scheduler, input::Input};
//use js_sys::Math;
use std::pin::Pin;
use std::future::Future;
use rand::Rng;
use crate::utils::text::{TextStyle, SETTERS};

//use std::{thread, time::Duration};

#[derive(Debug, Clone)]
pub struct Scope {
    pub variables: HashMap<String, BaseValue>,
    pub outer_scope: Option<Arc<Mutex<Scope>>>,
}

impl Scope {

    pub fn contains_key(&self, name: &str) -> bool {
        if self.variables.contains_key(name) {
            return true;
        }
        if let Some(outer) = self.outer_scope.as_ref() {
            return outer.lock().unwrap().contains_key(name);
        }
        false
    }

    pub fn set(&mut self, name: String, val: BaseValue) -> bool {
        if self.variables.contains_key(&name) {
            self.variables.insert(name, val);// = val;
            return true;
        }
        if let Some(outer) = &mut self.outer_scope {
            return outer.lock().unwrap().set(name, val);
        }
        return false;
    }

    pub fn get(&self, name: &str) -> Option<BaseValue> {
        if let Some(var) = self.variables.get(name) {
            return Some(var.clone());
        }
        if let Some(outer) = &self.outer_scope {
            return outer.lock().unwrap().get(name);
        }
        None
    }

    /// Calls `f` with the variable in place, without cloning it. Hands `f`
    /// back if the variable isn't defined in this scope chain.
    fn with_var<R, F: FnOnce(&BaseValue) -> R>(&self, name: &str, f: F) -> Result<R, F> {
        if let Some(var) = self.variables.get(name) {
            return Ok(f(var));
        }
        if let Some(outer) = &self.outer_scope {
            return outer.lock().unwrap().with_var(name, f);
        }
        Err(f)
    }

    fn with_var_mut<R, F: FnOnce(&mut BaseValue) -> R>(&mut self, name: &str, f: F) -> Result<R, F> {
        if let Some(var) = self.variables.get_mut(name) {
            return Ok(f(var));
        }
        if let Some(outer) = &self.outer_scope {
            return outer.lock().unwrap().with_var_mut(name, f);
        }
        Err(f)
    }

    fn clear(&mut self) {
        self.variables = HashMap::new();
        self.outer_scope = None;
    }
}

#[derive(Debug, Clone)]
pub struct Execution {
    pub lines: Arc<AstProgram>,
    pub scope : Arc<Mutex<Scope>>,
    pub global_vars : Arc<Mutex<HashMap<String, BaseValue>>>,
    pub functions : Arc<HashMap<String, (Vec<(String, Type)>, Option<Type>, AstBlock)>>,
    pub canvas    : Canvas,
    pub scheduler : Scheduler,
    pub input : Input,
    /// Colors as 0xRRGGBBAA.
    pub figure_color : Arc<Mutex<u32>>,
    pub line_color : Arc<Mutex<u32>>,
    pub line_width : Arc<Mutex<i32>>,
    pub text_style: Arc<Mutex<TextStyle>>,
    pub random_color: Arc<Mutex<i32>>,
    pub expanded_arrays: Arc<Mutex<LinkedList<Expression>>>
}

#[derive(Debug)]
pub enum ControlFlow {
    Next,
    Return(BaseValue),
    Break,
    Continue,
}

pub fn pack_color(r: u8, g: u8, b: u8, a: u8) -> u32 {
    u32::from_be_bytes([r, g, b, a])
}

macro_rules! expect_arg {
    // Варіант із полями: BaseValueType::Variant(pats...)
    ($fname:expr, $vals:expr, $idx:expr, $Variant:ident ( $($pat:pat),* ) => $build:expr) => {{
        let __arg_index = $idx; // збережемо, щоб не обчислювати двічі
        if __arg_index >= $vals.len() {
            return Err(Error::runtime(
                format!(
                    "{}: Expected at least {} arguments but got {}",
                    $fname,
                    __arg_index + 1,
                    $vals.len()
                ), 
                (0,0,0,0)
            ));
        }
        match &$vals[__arg_index] {
            BaseValue{val: BaseValueType::$Variant($($pat),*), coords: _} => { $build }
            other => {
                return Err(Error::runtime(
                        format!(
                        "{}: arg #{}: Expected argument type {} but got {}",
                        $fname,
                        __arg_index,            
                        stringify!($Variant),
                        other.get_type(&|_| Some(Type::typ(BaseType::Int)))?.to_string()
                    ), other.coords));
            }
        }
    }};
}

fn update_array(name: String, array: &mut BaseValue, mut integer_indices: Vec<i32>, val: BaseValue, coords: Coords) -> Result<(), Error> {
        if let BaseValueType::Array(elems) = &mut array.val {
            let index = integer_indices.remove(0);
            if index < 0 || index as usize >= elems.len() {
                return Err(Error::runtime(format!("Index out of bounds for array {}: {}", name, index), coords));
            }
            if integer_indices.len() == 0 {
                elems[index as usize] = val;
                return Ok(());
            }
            return update_array(format!("{}[{}]", name, index), elems.get_mut(index as usize).unwrap(), integer_indices, val, coords);
        } else {
            return Err(Error::runtime(format!("Variable {} is not an array", name), coords));
        }
    }

fn index_array(name: &str, array: &BaseValue, indices: &[i32], coords: Coords) -> Result<BaseValue, Error> {
    let mut current = array;
    for &index in indices {
        if let BaseValueType::Array(elems) = &current.val {
            if index < 0 || index as usize >= elems.len() {
                return Err(Error::runtime(format!("Index out of bounds for array {}: {}", name, index), coords));
            }
            current = &elems[index as usize];
        } else {
            return Err(Error::runtime(format!("Variable {} is not an array, but is a {:?}", name, current), coords));
        }
    }
    Ok(current.clone())
}

fn int(i: i32, coords:Coords) -> BaseValue {
    BaseValue{ val:BaseValueType::Int(i), coords} 
}

fn flt(i: f32, coords:Coords) -> BaseValue {
    BaseValue{ val:BaseValueType::Float(i), coords} 
}

fn bol(i: bool, coords:Coords) -> BaseValue {
    BaseValue{ val:BaseValueType::Bool(i), coords} 
}

fn get_random() -> f64 {
    let mut rng = rand::thread_rng();
    rng.gen()
}

impl Execution {

    fn style(&self) -> Style {
        Style {
            fill: *self.figure_color.lock().unwrap(),
            stroke: *self.line_color.lock().unwrap(),
            width: *self.line_width.lock().unwrap(),
        }
    }

    pub fn create_subscope(&self) -> Execution {
        Execution {
            lines: Arc::clone(&self.lines),
            scope: Arc::new(Mutex::new(Scope { variables: HashMap::new(), outer_scope: Some(Arc::clone(&self.scope)) })),
            canvas: self.canvas.clone(),
            scheduler: self.scheduler.clone(),
            input: self.input.clone(),
            global_vars: self.global_vars.clone(),
            functions: Arc::clone(&self.functions),
            figure_color: Arc::clone(&self.figure_color),
            line_color: self.line_color.clone(),
            line_width: self.line_width.clone(),
            text_style: Arc::clone(&self.text_style),
            random_color: Arc::clone(&self.random_color),
            expanded_arrays: Arc::clone(&self.expanded_arrays)
        }
    }

    fn create_subfunction(&self) -> Execution {
        let e = self.create_subscope();
        e.scope.lock().unwrap().clear();
        e
    }

    pub fn contains_key(&self, name: &str) -> bool {
        if self.scope.lock().unwrap().contains_key(name) {
            return true;
        }
        self.global_vars.lock().unwrap().contains_key(name)
    }

    fn set(&mut self, name: String, val: BaseValue) -> bool {
        if self.scope.lock().unwrap().set(name.clone(), val.clone()) {
            return true;
        }
        let mut globs = self.global_vars.lock().unwrap();
        if globs.contains_key(&name) {
            globs.insert(name, val);// = val;
            return true;
        }
        return false;
    }

    pub fn get(&self, name: &str) -> Option<BaseValue> {
        if let Some(var) = self.scope.lock().unwrap().get(name) {
            return Some(var.clone());
        }
        self.global_vars.lock().unwrap().get(name).map(|x| x.clone())
    }

    fn with_var<R>(&self, name: &str, f: impl FnOnce(&BaseValue) -> R) -> Option<R> {
        match self.scope.lock().unwrap().with_var(name, f) {
            Ok(result) => Some(result),
            Err(f) => self.global_vars.lock().unwrap().get(name).map(f),
        }
    }

    fn with_var_mut<R>(&self, name: &str, f: impl FnOnce(&mut BaseValue) -> R) -> Option<R> {
        match self.scope.lock().unwrap().with_var_mut(name, f) {
            Ok(result) => Some(result),
            Err(f) => self.global_vars.lock().unwrap().get_mut(name).map(f),
        }
    }

    async fn get_variable(&self, var: &VariableCall, coords: Coords) -> Result<BaseValue, Error> {
        match var {
            VariableCall::Name(name) => self.get(name).ok_or_else(|| Error::runtime(format!("Unknown variable: {}", name), coords)),
            VariableCall::ArrayCall(name, indices) => {
                if !self.contains_key(name) {
                    return Err(Error::runtime(format!("Unknown array 1: {}, variables: {:?}", name, self.scope), coords));
                }
                if indices.is_empty() {
                    return Err(Error::runtime(String::from("Empty index"), coords));
                }
                let mut integer_indices: Vec<i32> = vec![];
                for index in indices {
                    let index = index.clone().to_expr();
                    match self.calculate_expression(&index).await?.val {
                        BaseValueType::Int(i) => {
                            if i < 0 {
                                return Err(Error::runtime(format!("Negative index for array {}: {}", name, i), coords));
                            }
                            integer_indices.push(i);
                        },
                        _ => return Err(Error::runtime(String::from("Array indices must be integers"), coords)),
                    }
                }
                self.with_var(name, |array| index_array(name, array, &integer_indices, coords))
                    .unwrap_or_else(|| Err(Error::runtime(format!("Unknown array: {} ", name), coords)))
            }
        }
    }

    

    async fn set_variable(&mut self, var: &VariableCall, val: BaseValue, coords: Coords) -> Result<(), Error> {
        match var {
            VariableCall::Name(name) => if self.set(name.clone(), val) { return Ok(()); } else { return Err(Error::runtime(format!("Unknown variable: {}", name), coords));},
            VariableCall::ArrayCall(name, indices) => {
                if !self.contains_key(name) {
                    return Err(Error::runtime(format!("Unknown array 1: {}, variables: {:?}", name, self.scope), coords));
                }
                if indices.is_empty() {
                    return Err(Error::runtime(String::from("Empty index"), coords));
                }
                let mut integer_indices: Vec<i32> = vec![];
                for index in indices {
                    let index = index.clone().to_expr();
                    match self.calculate_expression(&index).await?.val {
                        BaseValueType::Int(i) => {
                            if i < 0 {
                                return Err(Error::runtime(format!("Negative index for array {}: {}", name, i), coords));
                            }
                            integer_indices.push(i);
                        },
                        _ => return Err(Error::runtime(String::from("Array indices must be integers"), coords)),
                    }
                }
                self.with_var_mut(name, |array| update_array(name.clone(), array, integer_indices, val, coords))
                    .unwrap_or_else(|| Err(Error::runtime(format!("Unknown array: {} ", name), coords)))
            }
        }
    }

    async fn evaluate_args(&self, args: &[Expression]) -> Result<Vec<BaseValue>, Error> {
        let mut vals = Vec::with_capacity(args.len());
        for arg in args {
            vals.push(self.calculate_expression(arg).await?);
        }
        Ok(vals)
    }

    async fn draw_text(&self, vals: Vec<BaseValue>, named_args: &[(String, Expression)]) -> Result<(), Error> {
        let x = expect_arg!("text", vals, 0, Int(v) => *v);
        let y = expect_arg!("text", vals, 1, Int(v) => *v);
        let content = vals.get(2).ok_or_else(|| Error::runtime("text expects content as its third argument".into(), (0, 0, 0, 0)))?.val.to_display_string();
        let mut style = self.text_style.lock().unwrap().clone();
        for (option, expr) in named_args {
            let value = self.calculate_expression(expr).await?;
            style.apply(option, &value, expr.coords)?;
        }
        self.canvas.text(x, y, content, style);
        Ok(())
    }

    /// Calls a builtin or user function with already evaluated arguments.
    async fn call_function(&self, function_name: &str, vals: Vec<BaseValue>, coords: Coords) -> Result<Option<BaseValue>, Error>{
        if let Some((_, option)) = SETTERS.iter().find(|(setter, _)| *setter == function_name) {
            let value = vals.first().ok_or_else(|| Error::runtime(format!("{} expects one argument", function_name), coords))?;
            self.text_style.lock().unwrap().apply(option, value, coords)?;
            return Ok(None);
        }
        match function_name {
            "circle" => {
                let x1 = expect_arg!("circle", vals, 0, Int(v) => *v);
                let y1 = expect_arg!("circle", vals, 1, Int(v) => *v);
                let r = expect_arg!("circle", vals, 2, Int(v) => *v);

                self.canvas.shape(op::CIRCLE, &[x1 as f64, y1 as f64, r as f64], self.style());
                Ok(None)
            },
            "line" => {
                let x1 = expect_arg!("line", vals, 0, Int(v) => *v);
                let y1 = expect_arg!("line", vals, 1, Int(v) => *v);
                let x2 = expect_arg!("line", vals, 2, Int(v) => *v);
                let y2 = expect_arg!("line", vals, 3, Int(v) => *v);

                self.canvas.shape(op::LINE, &[x1 as f64, y1 as f64, x2 as f64, y2 as f64], self.style());
                Ok(None)
            },
            "rectangle" => {
                let x1 = expect_arg!("rectangle", vals, 0, Int(v) => *v);
                let y1 = expect_arg!("rectangle", vals, 1, Int(v) => *v);
                let x2 = expect_arg!("rectangle", vals, 2, Int(v) => *v);
                let y2 = expect_arg!("rectangle", vals, 3, Int(v) => *v);
                
                self.canvas.shape(op::RECTANGLE, &[x1 as f64, y1 as f64, x2 as f64, y2 as f64], self.style());
                Ok(None)
            },
            "polygon" => {
                let mut coords_list = Vec::with_capacity(vals.len());
                for val in &vals {
                    if let BaseValueType::Int(num) = val.val {
                        coords_list.push(num as f64);
                    } else {
                        return Err(Error::runtime(String::from("Incorrect arguments for polygon function!"), val.coords));
                    }
                }
                self.canvas.shape(op::POLYGON, &coords_list, self.style());
                Ok(None)
            },
            "arc" => {
                let x = expect_arg!("arc", vals, 0, Int(v) => *v);
                let y = expect_arg!("arc", vals, 1, Int(v) => *v);
                let r = expect_arg!("arc", vals, 2, Int(v) => *v);
                let start = expect_arg!("arc", vals, 3, Int(v) => *v);
                let end = expect_arg!("arc", vals, 4, Int(v) => *v);

                self.canvas.shape(op::ARC, &[x as f64, y as f64, r as f64, start as f64, end as f64], self.style());
                Ok(None)
            },
            "setLineColor" => {
                if let BaseValueType::Color(r,g,b, a) = &vals[0].val {
                    *self.line_color.lock().unwrap() = pack_color(*r, *g, *b, *a);
                    Ok(None)
                }
                else {
                    Err(Error::runtime(format!("Incorrect arguments for setLineColor function: expected a color, got {:?}!", &vals[0]), coords))
                }
            },
            "setFigureColor" => {
                if let BaseValueType::Color(r,g,b, a) = &vals[0].val {
                    *self.figure_color.lock().unwrap() = pack_color(*r, *g, *b, *a);
                    Ok(None)
                }
                else {
                    Err(Error::runtime(format!("Incorrect arguments for setFigureColor function: expected a color, got {:?}!", &vals[0]), coords))
                }
            },
            "setLineWidth" => {
                let width = expect_arg!("setLineWidth", vals, 0, Int(width) => *width);
                if width >= 0 {
                    let mut inner  = self.line_width.lock().unwrap();
                    *inner = width;
                    Ok(None)
                } else {
                    Err(Error::runtime(String::from("Line width can't be negative!"), coords))
                }
            },
            "sleep" => {
                let sleep_time = expect_arg!("sleep", vals, 0, Int(time) => *time);
                if sleep_time >= 0 {
                    self.canvas.flush(false);
                    self.scheduler.sleep(sleep_time).await?;
                    Ok(None)
                } else {
                    Err(Error::runtime(String::from("Sleep time can't be negative!"), coords))
                }
            },
            "animate" => {
                self.canvas.command(op::ANIMATE);
                Ok(None)
            },
            "frame" => {
                self.canvas.flush(true);
                self.scheduler.wait_for_next_frame().await?;
                Ok(None)
            },
            "setFps" => {
                let fps = expect_arg!("setFps", vals, 0, Int(v) => *v);
                if fps >= 0 {
                    self.scheduler.set_fps(fps);
                    Ok(None)
                } else {
                    Err(Error::runtime(String::from("Frame rate can't be negative!"), coords))
                }
            },
            "clear" => {
                self.canvas.command(op::CLEAR);
                Ok(None)
            },
            "rgb" => {
                let r = expect_arg!("rgb", vals, 0, Int(v) => *v);
                let g = expect_arg!("rgb", vals, 1, Int(v) => *v);
                let b = expect_arg!("rgb", vals, 2, Int(v) => *v);
                if r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255 {
                    return Err(Error::runtime(String::from("RGB values must be between 0 and 255"), coords));
                }
                Ok(Some(BaseValue{val: BaseValueType::Color(r as u8, g as u8, b as u8, 255), coords}))
            },
            "Color::Random" => {
                let r = (get_random() * 255.0) as u8;
                let g = (get_random() * 255.0) as u8;
                let b = (get_random() * 255.0) as u8;
                Ok(Some(BaseValue{val: BaseValueType::Color(r,g,b, 255), coords}))
            },
            "round" => {
                let num = expect_arg!("round", vals, 0, Float(v) => *v);
                Ok(Some(int(num.round() as i32, coords)))
            },
            "floor" => {
                let num = expect_arg!("floor", vals, 0, Float(v) => *v);
                Ok(Some(int(num.floor() as i32, coords)))
            },
            "ceil" => {
                let num = expect_arg!("ceil", vals, 0, Float(v) => *v);
                Ok(Some(int(num.ceil() as i32, coords)))
            },
            "sqrt" => {
                let num = expect_arg!("sqrt", vals, 0, Float(v) => *v);
                if num < 0.0 {
                    return Err(Error::runtime(String::from("Cannot calculate square root of a negative number"), coords));
                }
                Ok(Some(flt(num.sqrt(), coords)))
            },
            "abs" => {
                let num = expect_arg!("abs", vals, 0, Float(v) => *v);
                Ok(Some(flt(num.abs(), coords)))
            },
            "decimal" => {
                let num = expect_arg!("decimal", vals, 0, Int(v) => *v);
                Ok(Some(flt(num as f32, coords)))
            },
            "random" => {
                let mut lower_bound = expect_arg!("random", vals, 0, Int(v) => *v);
                let mut upper_bound = expect_arg!("random", vals, 1, Int(v) => *v);
                if lower_bound >= upper_bound {
                    std::mem::swap(&mut lower_bound, &mut upper_bound);
                }
                let random_value = (get_random() * ((upper_bound - lower_bound + 1) as f64) + (lower_bound as f64)) as i32;
                if random_value > upper_bound {
                    return Ok(Some(int(upper_bound, coords)));
                }
                Ok(Some(int(random_value, coords)))
            },
            "len" => {
                if vals.len() != 1 {
                    return Err(Error::runtime(format!("len expects 1 argument, got {}", vals.len()), coords));
                }
                match &vals[0].val {
                    BaseValueType::Array(values) => Ok(Some(int(values.len() as i32, coords))),
                    _ => Err(Error::runtime("len expects an array argument".into(), coords)),
                }
            },
            "string" => {
                if vals.len() != 1 {
                    return Err(Error::runtime(format!("string expects 1 argument, got {}", vals.len()), coords));
                }
                Ok(Some(BaseValue { val: BaseValueType::StringVal(vals[0].val.to_display_string()), coords }))
            },
            "print" => {
                let result = vals.iter().map(|arg| arg.val.to_display_string()).collect::<Vec<_>>().join(" ");
                self.canvas.print(result);
                Ok(None)
            },
            "readInt" | "readFloat" | "readBool" | "readString" | "input" => {
                if !vals.is_empty() {
                    return Err(Error::runtime(format!("{}() takes no arguments", function_name), coords));
                }
                let kind = match function_name {
                    "readFloat" => "float",
                    "readBool" => "bool",
                    "readString" => "string",
                    _ => "int",
                };
                self.canvas.flush(false);
                let val = self.input.read(kind, coords).await?;
                Ok(Some(BaseValue { val, coords }))
            },
            "output" => Ok(None),
            name => {
                let functions = Arc::clone(&self.functions);
                if let Some((params, _, body)) = functions.get(name) {
                    if params.len() != vals.len() {
                        return Err(Error::runtime(format!("Function {} expects {} arguments, but got {}", name, params.len(), vals.len()), coords));
                    }
                    let mut new_exec = self.create_subfunction();
                    {
                        let mut scope = new_exec.scope.lock().unwrap();
                        for (param, val) in params.iter().zip(vals) {
                            scope.variables.insert(param.0.clone(), val);
                        }
                    }
                    return match new_exec.execute_commands(&body.nodes).await? {
                        ControlFlow::Return(value) => Ok(Some(value)),
                        ControlFlow::Next => Ok(None),
                        ControlFlow::Break | ControlFlow::Continue => Err(Error::runtime("Loop control cannot leave a function".into(), coords)),
                    };
                }
                Err(Error::runtime(format!("Unknown function: {}", function_name), coords))
            }
        }
    }

    async fn execute_init(&mut self, var: &str, expr: &Expression, coords: Coords) -> Result<(), Error>{
        let value = self.calculate_expression(expr).await?;
        self.define(var, value, coords)
    }

    fn define(&mut self, var: &str, value: BaseValue, coords: Coords) -> Result<(), Error> {
        if self.contains_key(var) {
            return Err(Error::runtime(format!("Variable {} is already defined!", var), coords));
        }
        self.scope.lock().unwrap().variables.insert(var.to_string(), value);
        Ok(())
    }

    async fn execute_set(&mut self, var: &VariableCall, expr: &Expression, coords: Coords) -> Result<(), Error> {
        let value = self.calculate_expression(expr).await?;
        self.set_variable(var, value, coords).await
    }

    pub async fn execute(&mut self) -> Result<(), Error> {
        let lines = Arc::clone(&self.lines);
        match &*lines {
            AstProgram::Block(block) => {
                self.execute_commands(&block.nodes).await?;
            },
            AstProgram::Forest(_) => {
                let functions = Arc::clone(&self.functions);
                for (func_name, (_, _, block)) in functions.iter() {
                    if func_name == "main" {
                        let mut new_exec = self.create_subscope();
                        new_exec.execute_commands(&block.nodes).await?;
                        return Ok(());
                    }
                }
                return Err(Error::runtime(String::from("No main function found"), (0,0,0,0)));
            },
        }
        Ok(())
    }

    pub async fn execute_key(&mut self, key: i32) -> Result<(), Error> {
        if self.functions.contains_key("keyboard") {
            self.call_function("keyboard", vec![int(key, (0,0,0,0))], (0,0,0,0)).await?;
        }
        Ok(())
    }

    pub async fn execute_mouse(&mut self, x: i32, y: i32) -> Result<(), Error> {
        if self.functions.contains_key("mouse") {
            self.call_function("mouse", vec![int(x, (0,0,0,0)), int(y, (0,0,0,0))], (0,0,0,0)).await?;
        }
        Ok(())
    }

    pub fn execute_commands<'a>(&'a mut self, nodes: &'a [AstNode]) -> Pin<Box<dyn Future<Output = Result<ControlFlow, Error>> + 'a>> {
        Box::pin(async move {
            self.scheduler.maybe_yield(&self.canvas).await?;
            for line in nodes {
                match &line.statement {
                    AstStatement::Command { name, args, named_args } => {
                        let vals = self.evaluate_args(args).await?;
                        if name == "text" {
                            self.draw_text(vals, named_args).await?;
                        } else {
                            self.call_function(name, vals, line.coords).await?;
                        }
                    },
                    AstStatement::Init { val, expr, .. } => self.execute_init(val, expr, line.coords).await?,
                    AstStatement::SetVal { val, expr } => self.execute_set(val, expr, line.coords).await?,
                    AstStatement::If { clause, block, else_block } => {
                        let condition = match self.calculate_expression(clause).await?.val {
                            BaseValueType::Bool(value) => value,
                            _ => return Err(Error::runtime("If clause must be a boolean expression".into(), line.coords)),
                        };
                        let selected = if condition { Some(block) } else { else_block.as_ref() };
                        if let Some(block) = selected {
                            let flow = self.create_subscope().execute_commands(&block.nodes).await?;
                            if !matches!(flow, ControlFlow::Next) { return Ok(flow); }
                        }
                    },
                    AstStatement::While { clause, block } => {
                        loop {
                            let condition = match self.calculate_expression(clause).await?.val {
                                BaseValueType::Bool(value) => value,
                                _ => return Err(Error::runtime("While clause must be a boolean expression".into(), line.coords)),
                            };
                            if !condition { break; }
                            match self.create_subscope().execute_commands(&block.nodes).await? {
                                ControlFlow::Break => break,
                                ControlFlow::Return(value) => return Ok(ControlFlow::Return(value)),
                                ControlFlow::Next | ControlFlow::Continue => {},
                            }
                        }
                    },
                    AstStatement::For { val, from, to, block } => {
                        let first = match self.calculate_expression(from).await?.val {
                            BaseValueType::Int(value) => value,
                            _ => return Err(Error::runtime("For loop range must use integers".into(), line.coords)),
                        };
                        let last = match self.calculate_expression(to).await?.val {
                            BaseValueType::Int(value) => value,
                            _ => return Err(Error::runtime("For loop range must use integers".into(), line.coords)),
                        };
                        let mut index = first;
                        loop {
                            match self.execute_iteration(val, int(index, line.coords), block, line.coords).await? {
                                ControlFlow::Break => break,
                                ControlFlow::Return(value) => return Ok(ControlFlow::Return(value)),
                                ControlFlow::Next | ControlFlow::Continue => {},
                            }
                            // Test the endpoint before incrementing to avoid overflowing i32.
                            if index == last { break; }
                            index += if first <= last { 1 } else { -1 };
                        }
                    },
                    AstStatement::ForEach { val, iterable, block } => {
                        let elements = match self.calculate_expression(iterable).await?.val {
                            BaseValueType::Array(values) => values,
                            _ => return Err(Error::runtime("For loop elements must come from an array".into(), line.coords)),
                        };
                        // Evaluate once. Each binding owns its element from this snapshot.
                        for element in elements {
                            match self.execute_iteration(val, element, block, line.coords).await? {
                                ControlFlow::Break => break,
                                ControlFlow::Return(value) => return Ok(ControlFlow::Return(value)),
                                ControlFlow::Next | ControlFlow::Continue => {},
                            }
                        }
                    },
                    AstStatement::Break => return Ok(ControlFlow::Break),
                    AstStatement::Continue => return Ok(ControlFlow::Continue),
                    AstStatement::Return { expr } => return Ok(ControlFlow::Return(self.calculate_expression(expr).await?)),
                }
            }
            Ok(ControlFlow::Next)
        })
    }

    async fn execute_iteration(&mut self, name: &str, value: BaseValue, block: &AstBlock, coords: Coords) -> Result<ControlFlow, Error> {
        let mut sub = self.create_subscope();
        sub.define(name, value, coords)?;
        sub.execute_commands(&block.nodes).await
    }

    pub fn calculate_expression<'a>(
        &'a self,
        expr: &'a Expression,
    ) -> Pin<Box<dyn Future<Output = Result<BaseValue, Error>> + 'a>> {
        
        Box::pin(async move {
            match &expr.expr_type {
                ExpressionType::Value(base_value) => self.calculate_value(base_value, expr.coords).await,
                ExpressionType::Unary(op, inner) => {
                    let inner_val = self.calculate_expression(inner).await?;
                    match op {
                        UnaryOperator::UnaryMinus => {
                            match inner_val.val {
                                BaseValueType::Int(num) => Ok(int((-1) * num, inner_val.coords)),
                                BaseValueType::Float(num) => Ok(flt((-1.0) * num, inner_val.coords)),
                                v => Err(Error::runtime(format!("Cannot apply unary minus to: {:?}", v), inner_val.coords))
                            }
                        },
                        UnaryOperator::NOT => {
                            match inner_val.val {
                                BaseValueType::Bool(val) => Ok(bol(!val, inner_val.coords)),
                                _ => Err(Error::runtime(String::from("Unary not only allowed on bool: {}"), inner_val.coords))
                            }
                        }
                        UnaryOperator::Parentheses => Ok(inner_val)
                    }
                },
                ExpressionType::Binary(op, lhs, rhs) => {
                    let (op, left_val, right_val) = (*op, self.calculate_expression(lhs).await?, self.calculate_expression(rhs).await?);

                    if let (BaseValueType::StringVal(left), BaseValueType::StringVal(right)) = (&left_val.val, &right_val.val) {
                        return match op {
                            Operator::Plus => Ok(BaseValue { val: BaseValueType::StringVal(format!("{}{}", left, right)), coords: expr.coords }),
                            Operator::EQ => Ok(bol(left == right, expr.coords)),
                            Operator::NQ => Ok(bol(left != right, expr.coords)),
                            _ => Err(Error::runtime("Strings support only +, == and !=".into(), expr.coords)),
                        };
                    }

                    if let BaseValueType::Int(x) = left_val.val {
                        if let BaseValueType::Int(y) = right_val.val {
                            return compare_ints(x, y, op, expr.coords);
                        }
                        if let BaseValueType::Float(y) = right_val.val {
                            let t = x as f32;
                            return compare_floats(t, y, op, expr.coords);
                        }
                    }

                    if let BaseValueType::Float(y) = left_val.val {
                        if let BaseValueType::Int(x) = right_val.val {
                            let t = x as f32;
                            return compare_floats(y, t, op, expr.coords);
                        }
                        if let BaseValueType::Float(x) = right_val.val {
                            return compare_floats(y, x, op, expr.coords);
                        }
                    }

                    if let BaseValueType::Bool(a) = left_val.val {
                        if let BaseValueType::Bool(b) = right_val.val {
                            return compare_bools(a, b, op, expr.coords);
                        }
                    }

                    Err(Error::runtime(format!("Unsolvable expression with values {:?} and {:?}", left_val.val, right_val.val), expr.coords))
                },
            }
        })
    }

    /// Evaluates a literal, variable, function call or array literal.
    /// `coords` locate the expression it appears in, for error messages.
    fn calculate_value<'a>(
        &'a self,
        base_value: &'a BaseValue,
        coords: Coords,
    ) -> Pin<Box<dyn Future<Output = Result<BaseValue, Error>> + 'a>> {
        Box::pin(async move {
            match &base_value.val {
                BaseValueType::Id(var) => self.get_variable(var, coords).await,
                BaseValueType::FunctionCall(name, exprs, _ ) => {
                    let vals = self.evaluate_args(exprs).await?;
                    match self.call_function(name, vals, coords).await? {
                        Some(v) => Ok(v),
                        None => Err(Error::runtime(format!("Function {} didn't return a value", name), coords)),
                    }
                },
                BaseValueType::Array(inner_values) => {
                    let mut results = Vec::with_capacity(inner_values.len());
                    for value in inner_values {
                        results.push(self.calculate_value(value, value.coords).await?);
                    }
                    Ok(BaseValue{val: BaseValueType::Array(results), coords: base_value.coords})
                },
                x => Ok(BaseValue { val: x.clone(), coords: base_value.coords }),
            }
        })
    }
}


fn compare_ints(x: i32, y : i32, op: Operator, coords: Coords) -> Result<BaseValue, Error> {
    match op {

        Operator::EQ => return Ok(bol(x == y, coords)),
        Operator::NQ => return Ok(bol(x != y, coords)),
        Operator::GT => return Ok(bol(x > y, coords)),
        Operator::LT => return Ok(bol(x < y, coords)),
        Operator::GQ => return Ok(bol(x >= y, coords)),
        Operator::LQ => return Ok(bol(x <= y, coords)),
        
        Operator::Plus => Ok(int(x + y, coords)),
        Operator::Minus => Ok(int(x - y, coords)),
        Operator::Mult => Ok(int(x * y, coords)),
        Operator::Div => {
            if y == 0 {
                return Err(Error::runtime(String::from("Division by 0"), coords));
            }
            x.checked_div(y).map(|value| int(value, coords))
                .ok_or_else(|| Error::runtime(String::from("Integer overflow"), coords))
        },
        Operator::Mod => {
            if y == 0 {
                return Err(Error::runtime(String::from("Division by 0"), coords));
            }
            x.checked_rem(y).map(|value| int(value, coords))
                .ok_or_else(|| Error::runtime(String::from("Integer overflow"), coords))
        },
        v => Err(Error::runtime(format!("Cannot apply operator {:?} to values of type int!",v), coords))   
    }
}

fn compare_floats(x: f32, y : f32, op: Operator, coords: Coords) -> Result<BaseValue, Error> {
    match op {

        Operator::EQ => Ok(bol(x == y, coords)),
        Operator::NQ => Ok(bol(x != y, coords)),
        Operator::GT => Ok(bol(x > y, coords)),
        Operator::LT => Ok(bol(x < y, coords)),
        Operator::GQ => Ok(bol(x >= y, coords)),
        Operator::LQ => Ok(bol(x <= y, coords)),
        
        Operator::Plus => Ok(flt(x + y, coords)),
        Operator::Minus => Ok(flt(x - y, coords)),
        Operator::Mult => Ok(flt(x * y, coords)),
        Operator::Div => if y == 0.0 { Err(Error::runtime(format!("Division by 0"), coords)) } else {Ok(flt(x / y, coords)) },
        Operator::Mod => if y == 0.0 { Err(Error::runtime(String::from("Division by 0"), coords)) } else { Ok(flt(x % y, coords)) },

        v => Err(Error::runtime(format!("Cannot apply operator {:?} to values of type float!",v), coords))

    }
}

fn compare_bools(a: bool, b : bool, op: Operator, coords: Coords) -> Result<BaseValue, Error> {
    match op {

        Operator::EQ => Ok(bol(a == b, coords)),
        Operator::NQ => Ok(bol(a != b, coords)),
        
        Operator::AND => Ok(bol(a && b, coords)),
        Operator::OR => Ok(bol(a || b, coords)),

        o => Err(Error::runtime(format!("Cannot apply operator '{:?}' to values of type bool!", o), coords))
    }
}
