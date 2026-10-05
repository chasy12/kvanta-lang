use crate::program::create_program;
use quanta_parser::{ast::{AstProgram, AstStatement, BaseValueType, ExpressionType}, parse_ast};

fn check(source: &str) -> Result<crate::program::Program, quanta_parser::error::Error> {
    let mut program = create_program(parse_ast(source)?);
    program.type_check()?;
    Ok(program)
}

#[test]
fn array_length_accepts_nested_arrays_and_rejects_scalars() {
    assert!(check("array<array<int, 3>, 2> grid = {{1,2,3},{4,5,6}}; int size = len(grid[0]);").is_ok());
    for source in ["int n = len(1);", "int n = len();", "int n = len({1}, {2});"] {
        assert!(check(source).is_err(), "{}", source);
    }
}

#[test]
fn loop_returns_need_a_fallback() {
    for source in [
        "func f() -> int { while (false) { return 1; } } func main() {}",
        "func f() -> int { for item in {} { return 1; } } func main() {}",
        "func f() -> int { for i in (0..2) { if (i == 0) { break; } return 1; } } func main() {}",
    ] {
        assert!(check(source).is_err(), "{}", source);
    }
    assert!(check("func f() -> int { while (false) { return 1; } return 2; } func main() {}").is_ok());
}

#[test]
fn guaranteed_loop_returns_remain_valid_without_a_fallback() {
    for source in [
        "func f() -> int { for i in (2..0) { return i; } } func main() {}",
        "func f() -> int { for item in {1,2} { return item; } } func main() {}",
        "func f() -> int { while (true) { return 1; } } func main() {}",
    ] {
        assert!(check(source).is_ok(), "{}", source);
    }
}

#[test]
fn return_in_only_the_else_branch_is_partial() {
    assert!(check("func f(bool choose) -> int { if (choose) {} else { return 1; } return 2; } func main() {}").is_ok());
}

#[test]
fn loop_control_cannot_cross_function_boundaries() {
    for keyword in ["break", "continue"] {
        let source = format!("func helper() {{ {keyword}; }} func main() {{ while (true) {{ helper(); break; }} }}");
        let err = check(&source).unwrap_err();
        assert!(err.message.contains(keyword));
    }
}

#[test]
fn nested_sized_declarations_are_normalized_before_execution() {
    let program = check("if (true) { int a[2]; } ").unwrap();
    let AstProgram::Block(root) = program.lines else { panic!("expected script") };
    let AstStatement::If { block, .. } = &root.nodes[0].statement else { panic!("expected if") };
    let AstStatement::Init { expr, .. } = &block.nodes[0].statement else { panic!("expected declaration") };
    let ExpressionType::Value(value) = &expr.expr_type else { panic!("expected array value") };
    assert!(matches!(&value.val, BaseValueType::Array(values) if values.len() == 2));
}

#[test]
fn foreach_infers_element_types_and_keeps_variable_local() {
    assert!(check("string names[2] = {\"a\", \"b\"}; for name in names { string copy = name; }").is_ok());
    assert!(check("int a[2]; for item in a {} int x = item;").is_err());
    assert!(check("for item in 42 {}").is_err());
}

#[test]
fn foreach_copies_of_const_elements_are_mutable() {
    for source in [
        "array<const int, 2> a = {1,2}; for value in a { value = 3; }",
        "array<array<const int, 2>, 2> a = {{1,2},{3,4}}; for row in a { row[0] = 9; }",
    ] {
        assert!(check(source).is_ok(), "{}", source);
    }
}

#[test]
fn unreachable_loop_control_still_requires_a_loop() {
    for source in [
        "func f() -> int { return 1; break; } func main() {}",
        "func f(bool choose) -> int { if (choose) { return 1; } else { return 2; } continue; } func main() {}",
    ] {
        assert!(check(source).is_err(), "{}", source);
    }
}

#[test]
fn length_calls_work_in_indexes_and_indexes_require_ints() {
    assert!(check("int a[2] = {1,2}; int last = a[len(a) - 1]; a[len(a) - 1] = 3;").is_ok());
    for source in [
        "int a[2]; bool index = true; int value = a[index];",
        "int a[2]; int value = a[len(3)];",
        "int a[2]; int value = a[sqrt(1.0)];",
        "int a[2]; int value = a[unknown];",
    ] {
        assert!(check(source).is_err(), "{}", source);
    }
}
