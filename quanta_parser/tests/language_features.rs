use quanta_parser::{ast::{AstBlock, AstProgram, AstStatement, BaseType, BaseValueType, ExpressionType, TypeName}, parse_ast};

fn block(source: &str) -> AstBlock {
    match parse_ast(source).unwrap() {
        AstProgram::Block(block) => block,
        other => panic!("Expected a script, got {other:?}"),
    }
}

#[test]
fn else_if_preserves_branch_order_and_final_else() {
    let ast = block("if (false) { int n = 1; } else if (true) { int n = 2; } else if (false) { int n = 3; } else { int n = 4; }");
    let AstStatement::If { else_block: Some(first_else), .. } = &ast.nodes[0].statement else { panic!("Missing else-if") };
    let AstStatement::If { else_block: Some(second_else), .. } = &first_else.nodes[0].statement else { panic!("Missing second else-if") };
    let AstStatement::If { else_block: Some(final_else), .. } = &second_else.nodes[0].statement else { panic!("Missing final else") };
    let AstStatement::Init { expr, .. } = &final_else.nodes[0].statement else { panic!("Missing final statement") };
    assert!(matches!(expr.expr_type, ExpressionType::Value(ref value) if value.val == BaseValueType::Int(4)));
}

#[test]
fn loop_control_statements_parse_inside_nested_branches() {
    let ast = block("for i in (0..3) { if (i == 1) { continue; } break; }");
    let AstStatement::For { block, .. } = &ast.nodes[0].statement else { panic!("Expected range loop") };
    let AstStatement::If { block: branch, .. } = &block.nodes[0].statement else { panic!("Expected branch") };
    assert!(matches!(branch.nodes[0].statement, AstStatement::Continue));
    assert!(matches!(block.nodes[1].statement, AstStatement::Break));
}

#[test]
fn array_iteration_accepts_variables_literals_and_function_calls() {
    for source in [
        "array<int, 2> a = {1, 2}; for value in a { int x = value; }",
        "for value in {1, 2} { int x = value; }",
        "func values() -> array<int, 2> { return {1, 2}; } func main() { for value in values() { int x = value; } }",
    ] {
        assert!(parse_ast(source).is_ok(), "{source}");
    }
    let ast = block("for value in {1, 2} { int x = value; }");
    let AstStatement::ForEach { val, iterable, block } = &ast.nodes[0].statement else { panic!("Expected array iteration") };
    assert_eq!(val, "value");
    assert!(matches!(iterable.expr_type, ExpressionType::Value(ref value) if matches!(value.val, BaseValueType::Array(ref items) if items.len() == 2)));
    assert_eq!(block.nodes.len(), 1);
}

#[test]
fn sized_array_declaration_keeps_outer_dimension_first() {
    let ast = block("int grid[2][3] = {{1, 2, 3}, {4, 5, 6}};");
    let AstStatement::Init { typ, val, .. } = &ast.nodes[0].statement else { panic!("Missing declaration") };
    assert_eq!(val, "grid");
    let TypeName::Array(inner, 2) = &typ.type_name else { panic!("Wrong outer dimension") };
    let TypeName::Array(scalar, 3) = &inner.as_ref().as_ref().unwrap().type_name else { panic!("Wrong inner dimension") };
    assert_eq!(scalar.as_ref().as_ref().unwrap().type_name, TypeName::Primitive(BaseType::Int));
}

#[test]
fn sized_arrays_without_initializers_use_type_specific_defaults() {
    for (source, expected) in [
        ("int a[2];", BaseValueType::Int(0)),
        ("float a[2];", BaseValueType::Float(0.0)),
        ("bool a[2];", BaseValueType::Bool(false)),
        ("string a[2];", BaseValueType::StringVal(String::new())),
        ("color a[2];", BaseValueType::Color(0, 0, 0, 255)),
        ("int a[2][3];", BaseValueType::Int(0)),
    ] {
        let ast = block(source);
        let AstStatement::Init { expr, .. } = &ast.nodes[0].statement else { panic!("Missing declaration") };
        let ExpressionType::Value(value) = &expr.expr_type else { panic!("Missing value") };
        let BaseValueType::ExpandingArray(default) = &value.val else { panic!("Missing default expansion") };
        assert_eq!(default.val, expected, "{source}");
    }
}

#[test]
fn sized_arrays_work_in_globals_and_function_parameters() {
    let ast = parse_ast("global { string labels[2]; } func count(int values[2][3]) -> int { return len(values); } func main() {}").unwrap();
    let AstProgram::Forest((functions, globals)) = ast else { panic!("Expected functions") };
    assert_eq!(globals.len(), 1);
    assert!(matches!(functions[0].args[0].1.type_name, TypeName::Array(_, 2)));
}

#[test]
fn array_length_call_has_integer_result_type() {
    let ast = block("array<int, 2> values = {1, 2}; int size = len(values);");
    let AstStatement::Init { expr, .. } = &ast.nodes[1].statement else { panic!("Missing length initialization") };
    assert_eq!(expr.get_type(&|_| None).unwrap(), TypeName::Primitive(BaseType::Int));
}

#[test]
fn array_length_can_compute_read_and_write_indices() {
    let ast = block("int a[2] = {1, 2}; int last = a[len(a)-1]; a[len(a)-1] = 3;");
    let AstStatement::Init { expr, .. } = &ast.nodes[1].statement else { panic!("Missing indexed read") };
    let ExpressionType::Value(value) = &expr.expr_type else { panic!("Missing indexed value") };
    let BaseValueType::Id(quanta_parser::ast::VariableCall::ArrayCall(_, indices)) = &value.val else { panic!("Missing array index") };
    let ExpressionType::Binary(quanta_parser::ast::Operator::Minus, left, right) = indices[0].clone().to_expr().expr_type else { panic!("Missing index arithmetic") };
    assert!(matches!(left.expr_type, ExpressionType::Value(ref value) if matches!(&value.val, BaseValueType::FunctionCall(name, args, typ) if name == "len" && args.len() == 1 && typ.type_name == TypeName::Primitive(BaseType::Int))));
    assert!(matches!(right.expr_type, ExpressionType::Value(ref value) if value.val == BaseValueType::Int(1)));
    assert!(matches!(ast.nodes[2].statement, AstStatement::SetVal { val: quanta_parser::ast::VariableCall::ArrayCall(_, _), .. }));
}

#[test]
fn declarations_reject_nonpositive_nonliteral_and_overflowing_dimensions() {
    for source in ["int a[0];", "int a[-1];", "int a[1 + 1];", "int a[n];", "int a[999999999999999999999999999999];"] {
        assert!(parse_ast(source).is_err(), "{source}");
    }
}

#[test]
fn legacy_arrays_range_loops_and_index_assignment_remain_compatible() {
    assert!(parse_ast("array<int, 2> a = {0...}; for i in (2..0) { a[0] = i; }").is_ok());
}
