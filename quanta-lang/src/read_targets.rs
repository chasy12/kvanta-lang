use quanta_parser::ast::{BaseValueType, Expression, ExpressionType, UnaryOperator, VariableCall};

/// read() takes assignable locations rather than evaluated argument values.
pub fn target(expression: &Expression) -> Option<&VariableCall> {
    match &expression.expr_type {
        ExpressionType::Value(value) => match &value.val {
            BaseValueType::Id(variable) => Some(variable),
            _ => None,
        },
        ExpressionType::Unary(UnaryOperator::Parentheses, inner) => target(inner),
        _ => None,
    }
}
