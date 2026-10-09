use quanta_parser::{ast::{AstBlock, AstProgram, AstStatement, BaseType, BaseValueType, ExpressionType, TypeName, VariableCall}, parse_ast};

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

const KEYWORD_PREFIXED_NAMES: [&str; 13] = [
    "interval", "intensity", "integer", "floating", "colors", "stringLen", "trueValue",
    "falsey", "truex", "format", "inside", "constant", "globalCount",
];

#[test]
fn identifiers_may_start_with_a_keyword() {
    for name in KEYWORD_PREFIXED_NAMES {
        let source = format!("int {name} = 1; {name} = 3; print({name});");
        let ast = block(&source);
        assert_eq!(ast.nodes.len(), 3, "{source}");
        let AstStatement::Init { val, .. } = &ast.nodes[0].statement else { panic!("Not a declaration: {source}") };
        assert_eq!(val, name, "{source}");
        let AstStatement::SetVal { val: VariableCall::Name(target), .. } = &ast.nodes[1].statement else { panic!("Not an assignment: {source}") };
        assert_eq!(target, name, "{source}");
        let AstStatement::Command { args, .. } = &ast.nodes[2].statement else { panic!("Not a call: {source}") };
        assert!(matches!(&args[0].expr_type, ExpressionType::Value(v) if matches!(&v.val, BaseValueType::Id(VariableCall::Name(n)) if n == name)), "{source}");
    }
}

#[test]
fn keyword_prefixed_names_work_as_values_and_in_other_positions() {
    for name in KEYWORD_PREFIXED_NAMES {
        for source in [
            format!("bool {name} = true; bool other = {name} && !{name};"),
            format!("int {name} = 2; int y = {name} * {name} + 1; print({name} - 1);"),
            format!("for {name} in (0..3) {{ print({name}); }}"),
            format!("array<int, 2> {name} = {{1, 2}}; for item in {name} {{ print(item); }}"),
            format!("func {name}(int {name}2) -> int {{ return {name}2; }} func main() {{ print({name}(1)); }}"),
            format!("const int {name} = 1;"),
        ] {
            assert!(parse_ast(&source).is_ok(), "{source}: {:?}", parse_ast(&source).err().map(|e| e.message));
        }
    }
}

#[test]
fn keywords_still_need_a_word_boundary_before_their_operand() {
    for source in ["intx = 1;", "int8 x = 1;", "func_f() {}", "ifx (true) {}", "for i inside (0..1) {}", "returnx;"] {
        // These must not be mistaken for the keyword followed by an identifier.
        let ast = parse_ast(source);
        if let Ok(quanta_parser::ast::AstProgram::Block(b)) = &ast {
            assert!(!matches!(b.nodes.first().map(|n| &n.statement), Some(AstStatement::Init { .. }) | Some(AstStatement::If { .. }) | Some(AstStatement::For { .. }) | Some(AstStatement::Return { .. })), "{source}");
        }
    }
}

fn deep_parens(depth: usize) -> String {
    format!("print({}1{});", "(".repeat(depth), ")".repeat(depth))
}

fn deep_calls(depth: usize) -> String {
    format!("print({}1{});", "f(".repeat(depth), ")".repeat(depth))
}

/// Debug builds use far larger stack frames than release ones, and the test
/// threads are small, so deep inputs run on a thread with a generous stack.
fn on_big_stack<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    std::thread::Builder::new().stack_size(256 << 20).spawn(f).unwrap().join().unwrap()
}

fn timed<T>(label: &str, f: impl FnOnce() -> T) -> T {
    let start = std::time::Instant::now();
    let result = f();
    let elapsed = start.elapsed();
    assert!(elapsed < std::time::Duration::from_secs(2), "{label} took {elapsed:?}");
    result
}

#[test]
fn nested_parentheses_and_calls_parse_in_linear_time() {
    on_big_stack(|| for depth in [24, 40, 60] {
        timed("parens", || assert!(parse_ast(&deep_parens(depth)).is_ok()));
        timed("calls", || assert!(parse_ast(&deep_calls(depth)).is_ok()));
        let nested_arrays = format!("{}1{}", "{".repeat(depth), "...}".repeat(depth));
        timed("expanded arrays", || { let _ = parse_ast(&format!("int a = {nested_arrays};")); });
        let nested_literals = format!("{}1{}", "{".repeat(depth), "}".repeat(depth));
        timed("array literals", || { let _ = parse_ast(&format!("int a = {nested_literals};")); });
        let indices = format!("a{}0{}", "[a[".repeat(depth / 2), "]]".repeat(depth / 2));
        timed("indices", || { let _ = parse_ast(&format!("int x = {indices};")); });
        let operators = format!("{}1{}", "(1 + ".repeat(depth), ")".repeat(depth));
        timed("operators", || assert!(parse_ast(&format!("int x = {operators};")).is_ok()));
        let unary = format!("int x = {}1{};", "-(".repeat(depth), ")".repeat(depth));
        timed("unary", || assert!(parse_ast(&unary).is_ok()));
    });
}

#[test]
fn syntax_errors_in_deep_expressions_are_reported_quickly() {
    for depth in [24, 40] {
        timed("unclosed parens", || assert!(parse_ast(&format!("print({}1);", "(".repeat(depth))).is_err()));
        timed("trailing operator", || assert!(parse_ast(&format!("int x = {}1 +{};", "(".repeat(depth), ")".repeat(depth))).is_err()));
    }
}

fn nesting_error(source: &str) -> quanta_parser::error::Error {
    parse_ast(source).expect_err(source)
}

#[test]
fn nesting_deeper_than_64_levels_is_a_parse_error_at_the_bracket() {
    let message = "Code is nested too deeply (more than 64 levels)";
    let at_limit = format!("print({}1{});", "(".repeat(63), ")".repeat(63));
    assert!(parse_ast(&at_limit).is_ok());
    let too_deep = format!("print({}1{});", "(".repeat(64), ")".repeat(64));
    let error = nesting_error(&too_deep);
    assert_eq!(error.message, message);
    assert_eq!(error.error_type, quanta_parser::error::ErrorType::ParseError);
    // `print(` is 1 bracket, the 65th opening bracket is the 64th paren, at column 6 + 64.
    assert_eq!((error.start.0, error.start.1), (1, 70));

    let blocks = format!("{}{}", "if (true) {".repeat(700), "}".repeat(700));
    let error = nesting_error(&blocks);
    assert_eq!(error.message, message);
    assert_eq!(error.start.0, 1);

    // Brackets of every kind count together.
    let mixed = format!("int x = {}1{};", "a[(".repeat(33), ")]".repeat(33));
    assert_eq!(nesting_error(&mixed).message, message);
}

#[test]
fn nesting_guard_ignores_strings_comments_and_balanced_siblings() {
    let in_string = format!("print(\"{}\");", "(".repeat(500));
    assert!(parse_ast(&in_string).is_ok());
    let in_comment = format!("// {}\nprint(1);", "{".repeat(500));
    assert!(parse_ast(&in_comment).is_ok());
    let escaped = format!("print(\"\\\"{}\");", "(".repeat(500));
    assert!(parse_ast(&escaped).is_ok());
    let siblings = "print((1));".repeat(200);
    assert!(parse_ast(&siblings).is_ok());
}

#[test]
fn missing_semicolon_hint_works_after_non_ascii_text() {
    for source in ["print(\"Привіт\")", "print(\"Привіт\")\n", "string s = \"Привіт, світе\"", "print(\"héllo\")"] {
        let error = parse_ast(source).expect_err(source);
        assert!(error.message.contains("Probably missing ';'"), "{source}: {}", error.message);
    }
    let error = parse_ast("print(\"abc\")").unwrap_err();
    assert!(error.message.contains("Probably missing ';'"), "{}", error.message);
}

#[test]
fn arrays_with_more_than_a_million_elements_are_rejected_at_the_dimension() {
    for (source, column) in [
        ("int a[1000001];", 7),
        ("int a[2000000000];", 7),
        ("int a[100000][100000];", 15),
        ("int a[1000][1001];", 13),
        ("array<int, 1000001> a = {0...};", 12),
        ("array<int, 100000000> a = {0...};", 12),
        ("array<array<int, 1000>, 1001> a = {{0...}...};", 0),
        ("func f(int a[1000001]) {}", 14),
    ] {
        let error = parse_ast(source).expect_err(source);
        assert_eq!(error.message, "Array is too large: at most 1000000 elements", "{source}");
        if column != 0 { assert_eq!((error.start.0, error.start.1), (1, column), "{source}"); }
    }
    for source in ["int a[1000000];", "int a[1000][1000];", "array<int, 1000000> a = {0...};", "int a[100][100][100];", "array<array<int, 1000>, 1000> a = {{0...}...};"] {
        assert!(parse_ast(source).is_ok(), "{source}: {:?}", parse_ast(source).err().map(|e| e.message));
    }
}

#[test]
fn expression_ast_keeps_precedence_and_associativity() {
    use quanta_parser::ast::Operator::*;
    fn shape(source: &str) -> String {
        let ast = block(&format!("int x = {source};"));
        let AstStatement::Init { expr, .. } = &ast.nodes[0].statement else { panic!() };
        render(expr)
    }
    fn render(e: &quanta_parser::ast::Expression) -> String {
        match &e.expr_type {
            ExpressionType::Value(v) => match &v.val { BaseValueType::Int(i) => i.to_string(), BaseValueType::Id(id) => id.to_string(), other => format!("{other:?}") },
            ExpressionType::Unary(op, inner) => format!("{op:?}({})", render(inner)),
            ExpressionType::Binary(op, l, r) => format!("({} {op:?} {})", render(l), render(r)),
        }
    }
    let _ = (Plus, Minus);
    assert_eq!(shape("1 + 2 * 3"), "(1 Plus (2 Mult 3))");
    assert_eq!(shape("1 * 2 + 3"), "((1 Mult 2) Plus 3)");
    assert_eq!(shape("1 - 2 - 3"), "((1 Minus 2) Minus 3)");
    assert_eq!(shape("8 / 4 / 2"), "((8 Div 4) Div 2)");
    assert_eq!(shape("a < 1 && b > 2 || c == 3"), "(((a LT 1) AND (b GT 2)) OR (c EQ 3))");
    assert_eq!(shape("a || b && c"), "(a OR (b AND c))");
    assert_eq!(shape("(1 + 2) * 3"), "(Parentheses((1 Plus 2)) Mult 3)");
    assert_eq!(shape("-a * 2"), "(UnaryMinus(a) Mult 2)");
    assert_eq!(shape("1 + 2 + 3 * 4 - 5"), "(((1 Plus 2) Plus (3 Mult 4)) Minus 5)");
}
