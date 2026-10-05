use std::{collections::{HashMap, HashSet, LinkedList}, sync::Arc};

use quanta_parser::{ast::*, error::Error};
use BaseType::*;
use TypeName::*;
use crate::utils::text::{option_type, SETTERS};

#[derive(Debug, Clone)]
pub struct Scope {
    variables: HashMap<String, (Type, Expression)>,
    outer_scope: Box<Option<Scope>>,
}

impl Scope {
    fn get(&self, name: &str) -> Option<&(Type, Expression)> {
        if let Some(var) = self.variables.get(name) {
            return Some(var);
        }
        if let Some(outer) = self.outer_scope.as_ref() {
            return outer.get(name);
        }
        None
    }
}

#[derive(Debug, Clone)]
pub struct Program {
    pub lines: AstProgram, 
    pub scope : Scope,
    pub global_vars : HashMap<String, (Type, Expression)>,
    pub function_defs : HashMap<String, (Vec<(String, Type)>, Option<Type>)>,
    pub functions : HashMap<String, (Vec<(String, Type)>, Option<Type>, AstBlock)>,
    pub expanded_arrays : LinkedList<Expression>,
    loop_depth: usize,
    keywords: HashSet<String>
}

#[derive(Debug, Clone, PartialEq)]
pub enum ReturnType {
    None,
    Partial(Type),
    Full(Type),
}

impl ReturnType {
    pub fn t(&self) -> Option<&Type> {
        match self {
            ReturnType::None => None,
            ReturnType::Partial(t) => Some(t),
            ReturnType::Full(t) => Some(t),
        }
    }
}

fn int_type() -> Type 
{
    Type { type_name: Primitive(Int), is_const: false }
}

fn float_type() -> Type
{
    Type {type_name: Primitive(Float), is_const: false}
}

fn color_type() -> Type
{
    Type {type_name: Primitive(Color), is_const: false}
}

pub fn create_program(ast: AstProgram) -> Program {
    let mut program = Program {lines: ast, scope: Scope { variables: HashMap::new(), outer_scope: Box::new(None) },
    global_vars: HashMap::new(),
    expanded_arrays: LinkedList::new(),
    loop_depth: 0,
    functions: HashMap::new(), function_defs: HashMap::from([
        (String::from("circle"), (vec![
            (String::from("x"), int_type()),
            (String::from("y"), int_type()),
            (String::from("radius"), int_type())
        ], None)),
        (String::from("line"), (vec![
            (String::from("x1"), int_type()),
            (String::from("y1"), int_type()),
            (String::from("x2"), int_type()),
            (String::from("y2"), int_type())
        ], None)),
        (String::from("rectangle"), (vec![
            (String::from("x1"), int_type()),
            (String::from("y1"), int_type()),
            (String::from("x2"), int_type()),
            (String::from("y2"), int_type())
        ], None)),
        (String::from("setLineColor"), (vec![
            (String::from("color"), color_type())
        ], None)),
        (String::from("setFigureColor"), (vec![
            (String::from("color"), color_type())
        ], None)),
        (String::from("setLineWidth"), (vec![
            (String::from("width"), int_type())
        ], None)),
        (String::from("polygon"), (vec![], None)), // at least 6 Ints for polygon
        (String::from("arc"), (vec![
            (String::from("circle_x"), int_type()),
            (String::from("circle_y"), int_type()),
            (String::from("radius"), int_type()),
            (String::from("angle_from"), int_type()),
            (String::from("angle_to"), int_type())
        ], None)),
        (String::from("sleep"), (vec![
            (String::from("sleep_time"), int_type())
        ], None)),
        (String::from("animate"), (vec![], None)),
        (String::from("frame"), (vec![], None)),
        (String::from("setFps"), (vec![
            (String::from("fps"), int_type())
        ], None)),
        (String::from("clear"), (vec![], None)),
        (String::from("Color::Random"), (vec![], Some(color_type()))),
        (String::from("round"), (vec![
            (String::from("value"), float_type())
        ], Some(int_type()))),
        (String::from("decimal"), (vec![
            (String::from("value"), int_type())
        ], Some(float_type()))),
        (String::from("ceil"), (vec![
            (String::from("value"), float_type())
        ], Some(int_type()))),
        (String::from("floor"), (vec![
            (String::from("value"), float_type())
        ], Some(int_type()))),
        (String::from("abs"), (vec![
            (String::from("value"), int_type())
        ], Some(int_type()))),
        (String::from("sqrt"), (vec![
            (String::from("value"), float_type())
        ], Some(float_type()))),
        (String::from("random"), (vec![(String::from("lower_bound"), int_type()), (String::from("upper_bound"), int_type())], Some(int_type()))),
        (String::from("rgb"), (vec![
            (String::from("red"), int_type()),
            (String::from("green"), int_type()),
            (String::from("blue"), int_type())
        ], Some(color_type()))),
        (String::from("print"), (vec![], None)),
        (String::from("input"), (vec![], Some(int_type()))),
        (String::from("output"), (vec![], None)),
    ]), keywords: HashSet::from(["circle", "line", "rectangle", 
                    "setLineColor", "setFigureColor", "setLineWidth", "polygon", "arc", "sleep", "animate", "frame", "setFps", "clear", "rgb",
                    "round", "decimal", "ceil", "floor", "abs", "sqrt", "random", "print", "input", "output",
                    "for", "while", "global", "func", "if", "else", "break", "continue", "len",
                    "int", "bool", "color", "float", "string", "array", "Color", "true", "false"
    ].map(|x| String::from(x)))};
    program.function_defs.insert("text".into(), (vec![
        ("x".into(), int_type()),
        ("y".into(), int_type()),
        ("content".into(), Type::typ(StringType)),
    ], None));
    program.keywords.insert("text".into());
    // string() accepts one value of any type; its arguments are checked separately.
    program.function_defs.insert("string".into(), (vec![], Some(Type::typ(StringType))));
    for (setter, option) in SETTERS {
        program.function_defs.insert(setter.into(), (vec![
            (option.into(), Type::typ(option_type(option).unwrap())),
        ], None));
        program.keywords.insert(setter.into());
    }
    program
}



impl Program {

    fn get(&self, name: &str) -> Option<&(Type, Expression)> {
        if let Some(var) = self.scope.get(name){
            return Some(var);
        }
        self.global_vars.get(name)
    }

    fn contains_key(&self, name: &str) -> bool {
        if self.scope.get(name).is_some() {
            return true;
        }
        self.global_vars.contains_key(name)
    }

    fn create_subprogram(&self, lines: Option<AstBlock>) -> Program {
        Program {
            lines: lines.map(|x| AstProgram::Block(x)).unwrap_or(self.lines.clone()),
            scope: Scope { variables: HashMap::new(), outer_scope: Box::new(Some(self.scope.clone())) },
            global_vars: self.global_vars.clone(),
            functions: self.functions.clone(),
            function_defs: self.function_defs.clone(),
            expanded_arrays: self.expanded_arrays.clone(),
            loop_depth: self.loop_depth,
            keywords: self.keywords.clone()
        }
    }

    pub fn type_check(&mut self) -> Result<ReturnType, Error> {
        match self.lines {
            AstProgram::Block(ref block) => {
                Self::validate_loop_control(block, self.loop_depth)?;
                let (return_type, new_block) = self.type_check_block(block.clone())?;
                self.lines = quanta_parser::ast::AstProgram::Block(new_block);
                return Ok(return_type);
            }
            AstProgram::Forest(ref forest) => {
                for (astst, (coords)) in &forest.1 {
                    if let AstStatement::Init{typ, val, expr} = astst {
                        let name = val;
                        if self.keywords.contains(name) {
                            return Err(Error::type_er(format!("'{}' is a keyword, it cannot be the name of a variable", name), *coords));
                        }
                        let (expr_type, new_expr) = self.clone().type_check_init(typ.clone(), name.clone(), expr.clone(), coords.clone())?;
                        if expr_type.type_name != typ.type_name {
                            return Err(Error::type_er(format!("Global variable {} of type {} cannot be assigned a type {}", name, typ.to_string(), expr_type.to_string()), *coords));
                        }
                        if self.contains_key(name) {
                            return Err(Error::logic(format!("Global variable {} is re-defined!", name), *coords));
                        }
                        self.global_vars.insert(name.clone(), (expr_type, new_expr));
                    }
                }

                for func in &forest.0 {
                    if self.keywords.contains(&func.name) {
                        return Err(Error::type_er(format!("'{}' is a keyword, it cannot be the name of a function", func.name), func.header));
                    }
                    if self.global_vars.contains_key(&func.name) {
                        return Err(Error::type_er(format!("{} is a global variable, it cannot be the name of a function", func.name), func.header))
                    }
                    for (argname, _) in &func.args {
                        if self.keywords.contains(argname) { 
                            return Err(Error::type_er(format!("'{}' is a keyword, it cannot be the name of a variable", argname), func.header));
                        }
                        if self.global_vars.contains_key(argname) {
                            return Err(Error::type_er(format!("{} is a global variable, it cannot be the name of a function argument", argname), func.header))
                        }
                    }
                    if &func.name == "keyboard" {
                        if func.args.len() != 1 {
                            return Err(Error::type_er(format!("Special function 'keyboard' has to have exactly 1 argument"), func.header));
                        }
                        if func.args.get(0).unwrap().clone().1.type_name != TypeName::Primitive(BaseType::Int) {
                            return Err(Error::type_er(format!("Special function 'keyboard' has to receive an integer, but got {}", func.args.get(0).unwrap().clone().1.to_string()), func.header));
                        }
                    }
                    if &func.name == "mouse" {
                        if func.args.len() != 2 {
                            return Err(Error::type_er(format!("Special function 'mouse' has to have exactly 2 arguments"), func.header));
                        }
                        if func.args.get(0).unwrap().clone().1.type_name != TypeName::Primitive(BaseType::Int)
                         || func.args.get(1).unwrap().clone().1.type_name != TypeName::Primitive(BaseType::Int) {
                            return Err(Error::type_er(format!("Special function 'mouse' has to receive two integers, but got {} and {}", func.args.get(0).unwrap().clone().1.to_string(), func.args.get(1).unwrap().clone().1.to_string()), func.header));
                        }
                    }
                    self.function_defs.insert(func.name.clone(), (func.args.clone(), func.return_type.clone()));
                }
                
                for func in &forest.0 {
                    let mut sub = self.create_subprogram(None);
                    for arg in &func.args {
                        let simple_expr = {
                            match arg.1.type_name.clone() {
                                Primitive(Int) => Expression{expr_type: ExpressionType::Value(BaseValue{val: BaseValueType::Int(0), coords: (0,0,0,0)}), coords: (0,0,0,0)},
                                Primitive(Float) => Expression{expr_type: ExpressionType::Value(BaseValue{val: BaseValueType::Float(0.0), coords: (0,0,0,0)}), coords: (0,0,0,0)},
                                Primitive(Bool) => Expression{expr_type: ExpressionType::Value(BaseValue{val: BaseValueType::Bool(false), coords: (0,0,0,0)}), coords: (0,0,0,0)},
                                Primitive(Color) => Expression{expr_type: ExpressionType::Value(BaseValue{val: BaseValueType::Color(0,0,0,255), coords: (0,0,0,0)}), coords: (0,0,0,0)},
                                Primitive(StringType) => Expression { expr_type: ExpressionType::Value(BaseValue{val: BaseValueType::StringVal("".to_string()), coords: (0,0,0,0)}), coords: (0,0,0,0) },
                                Array(_, _) => {
                                    Expression{expr_type: ExpressionType::Value(BaseValue{val: BaseValueType::Array(vec![]), coords: (0,0,0,0)}), coords: (0,0,0,0)}
                                },
                                ExpandingArray(_, _) => todo!(),}
                        };
                        sub.scope.variables.insert(arg.0.clone(), (arg.1.clone(), simple_expr));
                    }
                    let new_block = sub.type_check_function(func.clone())?;
                    if let AstProgram::Block(ast) = new_block {
                        println!("Got new astblock: {:?}", ast);
                        self.functions.insert(func.name.clone(), (func.args.clone(), func.return_type.clone(), ast));
                    }
                }
                Ok(ReturnType::None)
            }
        }
    }

    pub fn type_check_function(&mut self, func: AstFunction) -> Result<AstProgram, Error> {
        let mut func_prog = self.create_subprogram(Some(func.block));
        func_prog.loop_depth = 0;
        match func_prog.type_check() {
            Ok(ReturnType::Full(t)) => {
                if let Some(return_type) = &func.return_type {
                    if t != *return_type {
                        Err(Error::logic(format!("Function {} return type mismatch: expected '{}', got '{}'", func.name, return_type, t), func.header))
                    } else {
                        Ok(func_prog.lines)
                    }
                } else {
                    Err(Error::logic(format!("Function {} has no return type defined, but returns {}", func.name, t), func.header))
                }
            },
            Ok(ReturnType::Partial(t)) => {
                if let Some(return_type) = &func.return_type {
                    if t != *return_type {
                        return Err(Error::logic(format!("Function {} return type mismatch: expected '{}', got '{}'", func.name, return_type, t), func.header));
                    }
                    return Err(Error::logic(format!("Expected a return statement at the end of function {}", func.name), func.header));
                } else {
                    return Err(Error::logic(format!("Function {} has no return type defined", func.name), func.header));
                }
            },
            Ok(ReturnType::None) => {
                if let Some(rt) = func.return_type {
                    return Err(Error::logic(format!("Function {} has a return type '{}' defined but does not return anything", func.name, rt), func.header));
                }
                Ok(func_prog.lines)
            },
            Err(err) => return Err(err),   
        }
    }

    fn validate_loop_control(block: &AstBlock, depth: usize) -> Result<(), Error> {
        for node in &block.nodes {
            match &node.statement {
                AstStatement::Break | AstStatement::Continue if depth == 0 => {
                    let keyword = if matches!(node.statement, AstStatement::Break) { "break" } else { "continue" };
                    return Err(Error::logic(format!("{} can only be used inside a loop", keyword), node.coords));
                },
                AstStatement::If { block, else_block, .. } => {
                    Self::validate_loop_control(block, depth)?;
                    if let Some(block) = else_block { Self::validate_loop_control(block, depth)?; }
                },
                AstStatement::For { block, .. } | AstStatement::ForEach { block, .. } | AstStatement::While { block, .. } => {
                    Self::validate_loop_control(block, depth + 1)?;
                },
                _ => {},
            }
        }
        Ok(())
    }

    pub fn type_check_block(&mut self, block: AstBlock) -> Result<(ReturnType, AstBlock), Error> {
        let mut return_type: Option<Type> = None;
        let mut new_block = AstBlock { nodes: vec![], coords: block.coords };
        for line in block.nodes {
            let (statement, flow) = match &line.statement {
                AstStatement::Command { name, args, named_args } => {
                    if let Some(err) = self.clone().type_check_command(name.clone(), args.clone(), line.coords) {
                        return Err(err);
                    }
                    let mut seen = HashSet::new();
                    for (option, expr) in named_args {
                        if name != "text" {
                            return Err(Error::type_er("Named arguments are only supported by text()".into(), expr.coords));
                        }
                        let expected = option_type(option).ok_or_else(||
                            Error::type_er(format!("Unknown text option '{}'", option), expr.coords))?;
                        if !seen.insert(option) {
                            return Err(Error::logic(format!("Duplicate text option '{}'", option), expr.coords));
                        }
                        let actual = self.type_check_expr(expr)?;
                        if actual.type_name != Primitive(expected.clone()) {
                            return Err(Error::type_er(format!("Text option '{}' expects '{}', got '{}'", option, expected.to_string(), actual), expr.coords));
                        }
                    }
                    (line.statement.clone(), ReturnType::None)
                },
                AstStatement::Init { typ, val, expr } => {
                    let (typ, expr) = self.type_check_init(typ.clone(), val.clone(), expr.clone(), line.coords)?;
                    self.scope.variables.insert(val.clone(), (typ.clone(), expr.clone()));
                    (AstStatement::Init { typ, val: val.clone(), expr }, ReturnType::None)
                },
                AstStatement::SetVal { val, expr } => {
                    self.type_check_set_val(val.clone(), expr.clone(), line.coords)?;
                    // Assignment does not change the declared type or create a new binding.
                    (line.statement.clone(), ReturnType::None)
                },
                AstStatement::If { clause, block, else_block } => {
                    let (flow, block, else_block) = self.type_check_if(clause.clone(), block.clone(), else_block.clone())?;
                    (AstStatement::If { clause: clause.clone(), block, else_block }, flow)
                },
                AstStatement::For { val, from, to, block } => {
                    let (flow, block) = self.type_check_for(val.clone(), from.clone(), to.clone(), block.clone(), line.coords)?;
                    (AstStatement::For { val: val.clone(), from: from.clone(), to: to.clone(), block }, flow)
                },
                AstStatement::ForEach { val, iterable, block } => {
                    let (flow, block) = self.type_check_foreach(val, iterable, block.clone(), line.coords)?;
                    (AstStatement::ForEach { val: val.clone(), iterable: iterable.clone(), block }, flow)
                },
                AstStatement::While { clause, block } => {
                    let (flow, block) = self.type_check_while(clause.clone(), block.clone())?;
                    (AstStatement::While { clause: clause.clone(), block }, flow)
                },
                AstStatement::Break | AstStatement::Continue => {
                    if self.loop_depth == 0 {
                        let keyword = if matches!(line.statement, AstStatement::Break) { "break" } else { "continue" };
                        return Err(Error::logic(format!("{} can only be used inside a loop", keyword), line.coords));
                    }
                    (line.statement.clone(), ReturnType::None)
                },
                AstStatement::Return { expr } => {
                    (line.statement.clone(), ReturnType::Full(self.type_check_expr(expr)?))
                },
            };
            if let Some(t) = flow.t() {
                if let Some(previous) = &return_type {
                    if previous != t {
                        return Err(Error::logic(format!("Return type mismatch: expected '{}', got '{}'", previous, t), line.coords));
                    }
                }
                return_type = Some(t.clone());
            }
            new_block.nodes.push(AstNode { statement, coords: line.coords });
            if let ReturnType::Full(t) = flow {
                return Ok((ReturnType::Full(t), new_block));
            }
        }
        Ok((return_type.map(ReturnType::Partial).unwrap_or(ReturnType::None), new_block))
    }

    fn type_check_command(&self, name : String, args : Vec<Expression>, coords: Coords) -> Option<Error> {
        if name == "len" {
            return self.type_check_length(&args, coords).err();
        }
        if name == "string" {
            return self.type_check_string_conversion(&args, coords).err();
        }
        // todo warning unused return type
        if let Some((params, _)) = self.function_defs.get(&name) {
            if name == "polygon" {
                if args.len() < 6 || args.len() % 2 != 0 {
                    return Some(Error::logic(format!("Wrong number of arguments for command polygon: got {}, expected at least 6 (even number) for polygon", args.len()), coords));
                }
                for arg in &args {
                    match self.clone().type_check_expr(arg) {
                        Err(error) => return Some(error),
                        Ok(arg_type) => {
                            if arg_type.type_name != Primitive(Int) {
                                return Some(Error::type_er(format!("Wrong type of argument for command {}: got '{}', expected Int", name, arg_type), coords));
                            }
                        }
                    }
                }
                return None;
            }
            if name == "print" {
                return args.iter().find_map(|arg| self.type_check_expr(arg)
                    .and_then(|typ| Self::check_display_type(&typ, arg.coords)).err());
            }
            if name == "output" {
                return None;
            }
            if params.len() != args.len() {
                return Some(Error::logic(format!("Wrong number of arguments for command '{}': got {}, expected {}", name, args.len(), params.len()), coords));
            }
            for (i, (param_name,param_type)) in params.iter().enumerate() {
                match self.clone().type_check_expr(&args[i]) {
                    Err(error) => return Some(error),
                    Ok(arg_type) => {
                        // Formatting content accepts any checked value; coordinates stay ints.
                        if name == "text" && i == 2 {
                            if let Err(error) = Self::check_display_type(&arg_type, args[i].coords) {
                                return Some(error);
                            }
                            continue;
                        }
                        if arg_type.type_name != param_type.type_name {
                            return Some(Error::type_er(format!("Wrong type of argument '{}' for command '{}': got '{}', expected '{}'", param_name, name, arg_type, param_type), coords));
                        }
                    }
                }
                
            }
        } else {
            return Some(Error::logic(format!("Unknown command: {}", name), coords));
        }
        None
    }

    fn type_check_set_val(&self, val: VariableCall, expr: Expression, coords: Coords) -> Result<(Type, Expression), Error> {
        let var_type = self.clone().type_check_var(&val, coords)?;
        if var_type.is_const {
            return Err(Error::type_er(format!("Const variable {} cannot be reassigned", val), coords));
        }
        let expr_type = self.clone().type_check_expr(&expr)?;
        if !var_type.can_assign(&expr_type) {
            return Err(Error::logic(format!("Cannot assign expression of type '{}' to variable '{}' of type '{}'!", expr_type, val, var_type), coords));
        }
        Ok((var_type, expr))
    }

    fn fill_array_recursive(&self, array_type : &Type, val: BaseValue) -> BaseValue {
        match &array_type.type_name {
            Primitive(base_type) => val,
            Array(inner_type, size) => {
                let inner_value = self.fill_array_recursive(&inner_type.clone().unwrap(), val);
                let result = std::iter::repeat_n(inner_value, *size).collect();
                BaseValue{ val: BaseValueType::Array(result), coords: (0,0,0,0) }
            }
            ExpandingArray(_,_) => {
                panic!("Variable type cannot be an array literal!");
            }
        }
    } 

    fn type_check_init(&mut self, new_type_def : Type, val : String, expr : Expression, coords: Coords) -> Result<(Type, Expression), Error>{
        if self.keywords.contains(&val) {
            return Err(Error::type_er(format!("'{}' cannot be a variable, it is a keyword", val), coords));
        }
        if let Some(_) = self.get(&val) {
            return Err(Error::logic(format!("Variable {} is re-defined!", val), coords));
        } else {
            let expr_type = self.clone().type_check_expr(&expr)?;
            if !new_type_def.can_assign(&expr_type) {
                return Err(Error::logic(format!("Cannot assign expression of type '{}' to variable '{}' of type '{}'!", expr_type, val, new_type_def), coords));
            }
            if let ExpandingArray(_, inner_val) = expr_type.type_name {
                if let TypeName::Array(_, _) = &new_type_def.type_name {
                    let new_val = self.fill_array_recursive(&new_type_def, (*inner_val).clone());
                    self.expanded_arrays.push_back(Expression{expr_type: ExpressionType::Value(new_val.clone()), coords: coords});
                    return Ok((new_type_def, Expression{expr_type: ExpressionType::Value(new_val), coords: coords}));
                } else {
                    return Err(Error::type_er(format!("Cannot assign an expanding array to a value of type {}", new_type_def), coords));
                }
            }
            Ok((new_type_def, expr))
        }
    }

    fn type_check_if(&self, clause: Expression, block: AstBlock, else_block: Option<AstBlock>) -> Result<(ReturnType, AstBlock, Option<AstBlock>), Error> {
        if self.type_check_expr(&clause)?.type_name != Primitive(Bool) {
            return Err(Error::logic("If clause must be a bool expression".into(), clause.coords));
        }
        let (if_flow, block) = self.create_subprogram(None).type_check_block(block)?;
        let (else_flow, else_block) = if let Some(else_block) = else_block {
            let (flow, checked) = self.create_subprogram(None).type_check_block(else_block)?;
            (flow, Some(checked))
        } else {
            (ReturnType::None, None)
        };
        if let (Some(t1), Some(t2)) = (if_flow.t(), else_flow.t()) {
            if t1 != t2 {
                return Err(Error::logic(format!("Return type of if and else block must match: '{}' != '{}'", t1, t2), clause.coords));
            }
        }
        let flow = match (&if_flow, &else_flow) {
            (ReturnType::Full(t), ReturnType::Full(_)) => ReturnType::Full(t.clone()),
            _ => if_flow.t().or(else_flow.t()).cloned().map(ReturnType::Partial).unwrap_or(ReturnType::None),
        };
        Ok((flow, block, else_block))
    }

    fn check_loop_variable(&self, name: &str, coords: Coords) -> Result<(), Error> {
        if self.keywords.contains(name) {
            return Err(Error::type_er(format!("'{}' is a keyword, it cannot be a loop variable", name), coords));
        }
        if self.contains_key(name) {
            return Err(Error::logic(format!("Variable {} is re-defined!", name), coords));
        }
        Ok(())
    }

    fn check_loop_block(&mut self, block: AstBlock, guaranteed_iteration: bool) -> Result<(ReturnType, AstBlock), Error> {
        self.loop_depth += 1;
        let (flow, block) = self.type_check_block(block)?;
        // Inclusive ranges and nonempty arrays always run their first iteration.
        // A break or continue can still bypass an otherwise definite return.
        let flow = if guaranteed_iteration && !Self::exits_current_loop(&block) {
            flow
        } else {
            flow.t().cloned().map(ReturnType::Partial).unwrap_or(ReturnType::None)
        };
        Ok((flow, block))
    }

    fn exits_current_loop(block: &AstBlock) -> bool {
        block.nodes.iter().any(|node| match &node.statement {
            AstStatement::Break | AstStatement::Continue => true,
            AstStatement::If { block, else_block, .. } => {
                Self::exits_current_loop(block) || else_block.as_ref().map(Self::exits_current_loop).unwrap_or(false)
            },
            // Nested loops consume their own break and continue statements.
            _ => false,
        })
    }

    fn type_check_for(&self, val: String, from: Expression, to: Expression, block: AstBlock, coords: Coords) -> Result<(ReturnType, AstBlock), Error> {
        self.check_loop_variable(&val, coords)?;
        if self.type_check_expr(&from)?.type_name != Primitive(Int) {
            return Err(Error::logic("For loop range can only be integer values".into(), from.coords));
        }
        if self.type_check_expr(&to)?.type_name != Primitive(Int) {
            return Err(Error::logic("For loop range can only be integer values".into(), to.coords));
        }
        let mut sub = self.create_subprogram(None);
        sub.scope.variables.insert(val, (Type::typ(Int), from));
        sub.check_loop_block(block, true)
    }

    fn mutable_copy_type(mut typ: Type) -> Type {
        typ.is_const = false;
        if let Array(inner, _) = &mut typ.type_name {
            if let Some(element) = inner.as_mut() {
                *element = Self::mutable_copy_type(element.clone());
            }
        }
        typ
    }

    fn type_check_foreach(&self, val: &str, iterable: &Expression, block: AstBlock, coords: Coords) -> Result<(ReturnType, AstBlock), Error> {
        self.check_loop_variable(val, coords)?;
        let iterable_type = self.type_check_expr(iterable)?;
        let (element_type, size) = match iterable_type.type_name {
            Array(inner, size) => (inner.as_ref().clone().unwrap_or(Type::typ(Int)), size),
            _ => return Err(Error::type_er("For loop elements must come from an array".into(), iterable.coords)),
        };
        let mut sub = self.create_subprogram(None);
        sub.scope.variables.insert(val.to_string(), (Self::mutable_copy_type(element_type), iterable.clone()));
        sub.check_loop_block(block, size > 0)
    }

    fn type_check_while(&self, clause: Expression, block: AstBlock) -> Result<(ReturnType, AstBlock), Error> {
        if self.type_check_expr(&clause)?.type_name != Primitive(Bool) {
            return Err(Error::logic("While clause must be a bool expression".into(), clause.coords));
        }
        let guaranteed_iteration = matches!(&clause.expr_type, ExpressionType::Value(BaseValue { val: BaseValueType::Bool(true), .. }));
        self.create_subprogram(None).check_loop_block(block, guaranteed_iteration)
    }

    fn type_check_length(&self, args: &[Expression], coords: Coords) -> Result<Type, Error> {
        if args.len() != 1 {
            return Err(Error::type_er(format!("len expects 1 argument, got {}", args.len()), coords));
        }
        if !matches!(self.type_check_expr(&args[0])?.type_name, Array(_, _)) {
            return Err(Error::type_er("len expects an array argument".into(), args[0].coords));
        }
        Ok(Type::typ(Int))
    }

    fn check_display_type(typ: &Type, coords: Coords) -> Result<(), Error> {
        match &typ.type_name {
            ExpandingArray(..) => Err(Error::type_er("Array expansion needs a declared size before display or string conversion".into(), coords)),
            Array(inner, _) => {
                if let Some(element_type) = inner.as_ref() {
                    Self::check_display_type(element_type, coords)?;
                }
                Ok(())
            },
            Primitive(_) => Ok(()),
        }
    }

    fn type_check_string_conversion(&self, args: &[Expression], coords: Coords) -> Result<Type, Error> {
        if args.len() != 1 {
            return Err(Error::type_er(format!("string expects 1 argument, got {}", args.len()), coords));
        }
        let typ = self.type_check_expr(&args[0])?;
        Self::check_display_type(&typ, args[0].coords)?;
        Ok(Type::typ(StringType))
    }

    fn type_check_expr(&self, expr : &Expression) -> Result<Type, Error> {
        match &expr.expr_type {
            ExpressionType::Value(base_value) => {
                let expr_type =  self.clone().type_check_baseval(base_value)?;
                Ok(expr_type)
            },
            ExpressionType::Unary(op, inner) => {
                match op {
                    UnaryOperator::UnaryMinus => {
                        let inner_type = self.clone().type_check_expr(&*inner)?;
                        if inner_type.type_name == Primitive(Int) {Ok(Type::typ(Int))} else 
                        if inner_type.type_name == Primitive(Float) {Ok(Type::typ(Float))} else 
                        {Err(Error::type_er(format!("Unary minus can only be applied to types 'int' and 'float', but got {}", inner_type), expr.coords))}
                    },
                    UnaryOperator::NOT => {
                        let inner_type = self.clone().type_check_expr(&*inner)?;
                        if inner_type.type_name == Primitive(Bool) {
                            Ok(Type::typ(Bool))
                        } else {
                            Err(Error::type_er(format!("Unary NOT operator can only be applied to bool expressions, but got {}", inner_type), expr.coords))
                        }
                    },
                    UnaryOperator::Parentheses =>  self.clone().type_check_expr(&*inner),
                }
            },
            ExpressionType::Binary(op, lhs, rhs) => {
                let lhs_type =  self.clone().type_check_expr(&*lhs)?;
                let rhs_type =  self.clone().type_check_expr(&*rhs)?;
                if lhs_type.type_name == Primitive(StringType) || rhs_type.type_name == Primitive(StringType) {
                    if lhs_type.type_name != Primitive(StringType) || rhs_type.type_name != Primitive(StringType) {
                        return Err(Error::type_er("String operations require two string values".into(), expr.coords));
                    }
                    return match op {
                        Operator::Plus => Ok(Type::typ(StringType)),
                        Operator::EQ | Operator::NQ => Ok(Type::typ(Bool)),
                        _ => Err(Error::type_er("Strings support only +, == and !=".into(), expr.coords)),
                    };
                }
                if *op == Operator::AND || *op == Operator::OR {
                    if lhs_type.type_name != Primitive(Bool) {
                        return Err(Error::type_er(format!("Expected bool expression for operator '{:?}', got '{}'", *op, lhs_type), lhs.coords))
                    } else if rhs_type.type_name != Primitive(Bool) {
                        return Err(Error::type_er(format!("Expected bool expression for operator '{:?}', got '{}'", *op, rhs_type), rhs.coords))
                    }
                    Ok(Type::typ(Bool))
                } else {
                    if lhs_type.type_name != Primitive(Int) && lhs_type.type_name != Primitive(Float) {
                        return Err(Error::type_er(format!("Expected int or float expression for operator '{:?}', got '{}'", *op, lhs_type), lhs.coords));
                    }
                    if rhs_type.type_name != Primitive(Int) && rhs_type.type_name!= Primitive(Float) {
                        return Err(Error::type_er(format!("Expected int or float expression for operator '{:?}', got '{}'", *op, rhs_type), rhs.coords));
                    }
                    if !is_arith(*op) {
                        return Ok(Type::typ(Bool))
                    }
                    if lhs_type.type_name == Primitive(Float) || rhs_type.type_name == Primitive(Float) {
                        return Ok(Type::typ(Float))
                    }
                    Ok(Type::typ(Int))
                }
            },
        }
    }

    fn recursive_type_check_var(&self, tp: &Type, depth: usize, coords: Coords) -> Result<Type, Error> {
        if let Array(inner_type, _) = &tp.type_name {
            if let Some(inner) = inner_type.as_ref() {
                if depth == 1 {
                    return Ok(inner.clone());
                } else {
                    return self.recursive_type_check_var(inner, depth - 1, coords);
                }
            } else {
                return Err(Error::type_er(String::from("Array type is not defined"), coords));
            }
        }
        Err(Error::type_er(String::from("Expected an array type"), coords))
    }

    fn type_check_var(&self, var: &VariableCall, coords: Coords) -> Result<Type, Error> {
        if let VariableCall::ArrayCall(_, indices) = var {
            for index in indices {
                let expression = index.clone().to_expr();
                if self.type_check_expr(&expression)?.type_name != Primitive(Int) {
                    return Err(Error::type_er("Array indices must be integers".into(), expression.coords));
                }
            }
        }
        let (name, depth) = match var {
            VariableCall::Name(name) => (name, 0),
            VariableCall::ArrayCall(name, inds) => (name, inds.len())
        };
        if self.keywords.contains(name) {
            return Err(Error::type_er(format!("'{}' is a keyword, it cannot be a name of a variable", name), coords));
        }
        if let Some((tp, _)) = self.get(name) {
            if depth == 0 { 
                return Ok(tp.clone());
            } else {
                return self.recursive_type_check_var(tp, depth, coords);
            }
        } else {
            Err(Error::logic(format!("Variable {} is not defined!", var), coords))
        }
    }

    fn type_check_baseval(&self, base : &BaseValue) -> Result<Type, Error> {
        use BaseType::*;
        let coords = base.coords;
        match &base.val {
            BaseValueType::Id(var) => self.type_check_var(&var, coords),
            BaseValueType::Int(_) => Ok(Type::typ(Int)),
            BaseValueType::Bool(_) => Ok(Type::typ(Bool)),
            BaseValueType::Color(..) => Ok(Type::typ(Color)),
            BaseValueType::RandomColor(_) => Ok(Type::typ(Color)),
            BaseValueType::Float(_) => Ok(Type::typ(Float)),
            BaseValueType::Array(arr) => {
                let types: Result<Vec<Type>, Error> = arr.iter()
                    .map(|item| self.type_check_baseval(item))
                    .collect();
                let types = types?;
                if types.is_empty() {
                    return Ok(Type{type_name:Array(Box::new(None), 0), is_const: false});
                }
                let inner_type = &types.first().unwrap().clone();
    
                if let Some(outsider) = types.iter().find(|t| t.type_name != inner_type.type_name) {
                    return Err(Error::type_er(format!("Array elements must all be of type '{}', got '{}'", inner_type, outsider), base.coords));
                }
                Ok(Type{type_name:Array(Box::new(Some(inner_type.clone())), arr.len()), is_const: false})
            },
            BaseValueType::ExpandingArray(val) => Ok(Type{type_name:ExpandingArray(Arc::new(self.type_check_baseval(&val.clone())?), val.clone()), is_const: false}),
            BaseValueType::FunctionCall(name,arg_list, return_type ) => {
                if name == "len" {
                    return self.type_check_length(arg_list, base.coords);
                }
                if name == "string" {
                    return self.type_check_string_conversion(arg_list, base.coords);
                }
                match self.function_defs.get(name) {
                    None => Err(Error::type_er(format!("Unknown function '{}'", name), base.coords)),
                    Some((arg_defs, _)) => {
                        if arg_list.len() != arg_defs.len() {
                            return Err(Error::type_er(format!("Funcion '{}' expects {} arguments, but got {}", name, arg_defs.len(), arg_list.len()), base.coords))
                        }
                        for (i, (arg_name, arg_def)) in arg_defs.iter().enumerate() {
                            let expr_type = self.type_check_expr(arg_list.get(i).unwrap())?;
                            if !arg_def.can_assign(&expr_type) {
                                return Err(Error::type_er(format!("Funcion '{}' expects argument '{}' of type '{}', but got '{}'", name, arg_name, arg_def.to_string(), expr_type.to_string()), base.coords));
                            }
                        } 
                        Ok(return_type.clone())
                    }
                }
            }
            BaseValueType::StringVal(_) => Ok(Type::typ(StringType)),
        }
    }

}
