//! Resolve input() from its static context before verification or execution.
//! Typed reads retain the original call coordinates for runtime errors.
use std::{collections::HashMap, sync::Arc};

use quanta_parser::{ast::*, error::Error};

type Signatures = HashMap<String, (Vec<(String, Type)>, Option<Type>)>;
type Variables = HashMap<String, Type>;

pub fn resolve(ast: &mut AstProgram, builtins: &Signatures) -> Vec<Error> {
    let mut resolver = Resolver { signatures: builtins.clone(), errors: vec![] };
    let mut variables = Variables::new();
    match ast {
        AstProgram::Block(block) => resolver.block(block, &mut variables, None),
        AstProgram::Forest((functions, globals)) => {
            for function in functions.iter() {
                resolver.signatures.insert(function.name.clone(), (function.args.clone(), function.return_type.clone()));
            }
            for (statement, coords) in globals.iter_mut() {
                resolver.statement(statement, *coords, &mut variables, None);
            }
            for function in functions {
                let mut locals = variables.clone();
                locals.extend(function.args.iter().cloned());
                resolver.block(&mut function.block, &mut locals, function.return_type.as_ref());
            }
        }
    }
    resolver.errors
}

struct Resolver {
    signatures: Signatures,
    errors: Vec<Error>,
}

fn numeric(typ: &Type) -> bool {
    matches!(typ.type_name, TypeName::Primitive(BaseType::Int | BaseType::Float))
}

fn element_type(typ: &Type) -> Option<Type> {
    match &typ.type_name {
        TypeName::Array(inner, _) => inner.as_ref().clone(),
        _ => None,
    }
}

fn underlying_type(mut typ: Type) -> Type {
    while let Some(inner) = element_type(&typ) { typ = inner; }
    typ
}

fn variable_type(var: &VariableCall, variables: &Variables) -> Option<Type> {
    let (name, depth) = match var {
        VariableCall::Name(name) => (name, 0),
        VariableCall::ArrayCall(name, indices) => (name, indices.len()),
    };
    let mut typ = variables.get(name)?.clone();
    for _ in 0..depth { typ = element_type(&typ)?; }
    Some(typ)
}

impl Resolver {
    fn block(&mut self, block: &mut AstBlock, variables: &mut Variables, returned: Option<&Type>) {
        for node in &mut block.nodes { self.statement(&mut node.statement, node.coords, variables, returned); }
    }

    fn statement(&mut self, statement: &mut AstStatement, coords: Coords, variables: &mut Variables, returned: Option<&Type>) {
        let boolean = Type::typ(BaseType::Bool);
        let integer = Type::typ(BaseType::Int);
        match statement {
            AstStatement::Init { typ, val, expr } => {
                self.expression(expr, Some(typ), variables);
                // Invalid redeclarations must not replace a preceding type.
                variables.entry(val.clone()).or_insert_with(|| typ.clone());
            }
            AstStatement::SetVal { val, expr } => {
                self.expression(expr, variable_type(val, variables).as_ref(), variables);
            }
            AstStatement::Command { name, args } => {
                self.arguments(name, args, variables);
                if name == "input" && args.is_empty() {
                    self.errors.push(Error::type_er(String::from("Cannot infer input type; use input() in a typed expression"), coords));
                }
            }
            AstStatement::Return { expr } => self.expression(expr, returned, variables),
            AstStatement::If { clause, block, else_block } => {
                self.expression(clause, Some(&boolean), variables);
                self.block(block, &mut variables.clone(), returned);
                if let Some(other) = else_block { self.block(other, &mut variables.clone(), returned); }
            }
            AstStatement::While { clause, block } => {
                self.expression(clause, Some(&boolean), variables);
                self.block(block, &mut variables.clone(), returned);
            }
            AstStatement::For { val, from, to, block } => {
                self.expression(from, Some(&integer), variables);
                self.expression(to, Some(&integer), variables);
                let mut locals = variables.clone();
                locals.insert(val.clone(), integer);
                self.block(block, &mut locals, returned);
            }
        }
    }

    fn arguments(&mut self, name: &str, args: &mut [Expression], variables: &Variables) {
        let signature = self.signatures.get(name).cloned();
        for (index, arg) in args.iter_mut().enumerate() {
            let expected = if name == "polygon" { Some(Type::typ(BaseType::Int)) }
                else { signature.as_ref().and_then(|(params, _)| params.get(index)).map(|(_, typ)| typ.clone()) };
            self.expression(arg, expected.as_ref(), variables);
        }
    }

    /// A hint describes the already known part of an expression. input() has
    /// no hint until a surrounding declaration, operator or sibling supplies one.
    fn hint(&self, expression: &Expression, variables: &Variables) -> Option<Type> {
        match &expression.expr_type {
            ExpressionType::Value(value) => self.value_hint(value, variables),
            ExpressionType::Unary(UnaryOperator::NOT, _) => Some(Type::typ(BaseType::Bool)),
            ExpressionType::Unary(_, inner) => self.hint(inner, variables),
            ExpressionType::Binary(op, left, right) => {
                if !is_arith(*op) { return Some(Type::typ(BaseType::Bool)); }
                let left = self.hint(left, variables).filter(numeric);
                let right = self.hint(right, variables).filter(numeric);
                if left.as_ref().is_some_and(|typ| typ.type_name == TypeName::Primitive(BaseType::Float)) ||
                    right.as_ref().is_some_and(|typ| typ.type_name == TypeName::Primitive(BaseType::Float)) {
                    Some(Type::typ(BaseType::Float))
                } else { left.or(right) }
            }
        }
    }

    fn value_hint(&self, value: &BaseValue, variables: &Variables) -> Option<Type> {
        match &value.val {
            BaseValueType::Id(var) => variable_type(var, variables),
            BaseValueType::Int(_) => Some(Type::typ(BaseType::Int)),
            BaseValueType::Float(_) => Some(Type::typ(BaseType::Float)),
            BaseValueType::Bool(_) => Some(Type::typ(BaseType::Bool)),
            BaseValueType::StringVal(_) => Some(Type::typ(BaseType::StringType)),
            BaseValueType::Color(..) | BaseValueType::RandomColor(_) => Some(Type::typ(BaseType::Color)),
            BaseValueType::FunctionCall(name, _, _) if name == "input" => None,
            BaseValueType::FunctionCall(name, _, _) => self.signatures.get(name).and_then(|(_, typ)| typ.clone()),
            BaseValueType::Array(values) => values.iter().find_map(|value| self.value_hint(value, variables))
                .map(|inner| Type { type_name: TypeName::Array(Box::new(Some(inner)), values.len()), is_const: false }),
            BaseValueType::ExpandingArray(value) => self.value_hint(value, variables),
        }
    }

    fn expression(&mut self, expression: &mut Expression, expected: Option<&Type>, variables: &Variables) {
        match &mut expression.expr_type {
            ExpressionType::Value(value) => self.value(value, expected, variables),
            ExpressionType::Unary(op, inner) => {
                let hint = match op {
                    UnaryOperator::NOT => Some(Type::typ(BaseType::Bool)),
                    UnaryOperator::UnaryMinus => expected.filter(|typ| numeric(typ)).cloned(),
                    UnaryOperator::Parentheses => expected.cloned(),
                };
                self.expression(inner, hint.as_ref(), variables);
            }
            ExpressionType::Binary(op, left, right) => {
                let hint = if *op == Operator::AND || *op == Operator::OR {
                    Some(Type::typ(BaseType::Bool))
                } else {
                    // Comparisons return bool, but their operands remain numeric.
                    let left_hint = self.hint(left, variables).filter(numeric);
                    let right_hint = self.hint(right, variables).filter(numeric);
                    let result_hint = if is_arith(*op) { expected.filter(|typ| numeric(typ)).cloned() } else { None };
                    if [&left_hint, &right_hint].iter().any(|hint| hint.as_ref().is_some_and(|typ| typ.type_name == TypeName::Primitive(BaseType::Float))) {
                        Some(Type::typ(BaseType::Float))
                    } else { left_hint.or(right_hint).or(result_hint) }
                };
                self.expression(left, hint.as_ref(), variables);
                self.expression(right, hint.as_ref(), variables);
            }
        }
    }

    fn value(&mut self, value: &mut BaseValue, expected: Option<&Type>, variables: &Variables) {
        match &mut value.val {
            BaseValueType::FunctionCall(name, args, typ) => {
                self.arguments(name, args, variables);
                if name != "input" || !args.is_empty() { return; }
                let reader = match expected.map(|typ| &typ.type_name) {
                    Some(TypeName::Primitive(BaseType::Int)) => "readInt",
                    Some(TypeName::Primitive(BaseType::Float)) => "readFloat",
                    Some(TypeName::Primitive(BaseType::Bool)) => "readBool",
                    Some(TypeName::Primitive(BaseType::StringType)) => "readString",
                    Some(_) => {
                        self.errors.push(Error::type_er(format!("input() does not support type {}", expected.unwrap()), value.coords));
                        return;
                    }
                    None => {
                        self.errors.push(Error::type_er(String::from("Cannot infer input type; use input() in a typed expression"), value.coords));
                        return;
                    }
                };
                *name = reader.to_string();
                *typ = Type { type_name: expected.unwrap().type_name.clone(), is_const: false };
            }
            BaseValueType::Array(values) => {
                let inner = expected.and_then(element_type).or_else(|| values.iter().find_map(|value| self.value_hint(value, variables)));
                for value in values { self.value(value, inner.as_ref(), variables); }
            }
            BaseValueType::ExpandingArray(value) => {
                let inner = expected.cloned().map(underlying_type);
                self.value(Arc::make_mut(value), inner.as_ref(), variables);
            }
            _ => {}
        }
    }
}
