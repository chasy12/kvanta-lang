use crate::program::create_program;
use quanta_parser::parse_ast;

fn errors(source: &str) -> Vec<quanta_parser::error::Error> {
    create_program(parse_ast(source).unwrap()).verify_all()
}

#[test]
fn diagnostics_accept_text_strings_lengths_and_foreach_input() {
    for source in [
        "string s=\"hi\"+input(); bool b=input()==\"x\"; print(s,b);",
        "array<int,2> a={1,2}; int n=len(a); text(0,0,string(n)); text(0,0,a);",
        "text(0,0,42,size:input(),bold:input(),font:input(),lineHeight:input());",
        "array<float,2> a={1.0,2.0}; for item in a { item=input(); if(item>0.0){continue;} break; }",
        "array<array<const int,2>,2> a={{1,2},{3,4}}; for row in a {read(row[0]);}",
        "int a[2]; read(a[round(input())]);",
        "func f()->int{for item in {1,2}{return item;}} func main(){print(f());}",
    ] {
        assert!(errors(source).is_empty(), "{}: {:?}", source, errors(source));
        assert!(create_program(parse_ast(source).unwrap()).type_check().is_ok(), "{}", source);
    }
}

#[test]
fn diagnostics_keep_loop_rules_and_report_named_options_together() {
    assert_eq!(errors("break; continue; int n=true;").len(), 3);
    for source in [
        "func f()->int{while(false){return 1;}} func main(){}",
        "func f()->int{for item in {} {return item;}} func main(){}",
        "func f()->int{for i in (0..2){if(i==0){break;}return 1;}} func main(){}",
    ] { assert!(!errors(source).is_empty(), "{}", source); }
    let errors=errors("text(0,0,42,size:true,bold:1,unknown:3); int n=true;");
    assert_eq!(errors.len(),4,"{:?}",errors);
}

#[test]
fn diagnostics_reject_unsized_expansion_display_and_nonarray_length() {
    for source in ["print({1...});", "text(0,0,{1...});", "string s=string({1...});", "int n=len(1);"] {
        assert!(!errors(source).is_empty(), "{}", source);
    }
}
