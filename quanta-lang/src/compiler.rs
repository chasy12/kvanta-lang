
use std::collections::HashSet;

use quanta_parser::{parse_ast, parse_ast_recovering_with_quarantine, error::Error};
//use crate::linear_runtime;
use crate::program::create_program;
use crate::utils::canvas::Canvas;
use crate::utils::message::{CompilationMessage};
//use crate::utils::message::{LinearCompilationMessage};
use crate::{Compiler, runtime::Runtime};

/// Whether `error` only says that a name is undefined although the user did
/// declare it, in code that failed to parse and was already reported.
fn uses_quarantined(error: &Error, quarantined: &HashSet<String>) -> bool {
    let message = error.message.as_str();
    let name = message.strip_prefix("Variable ").and_then(|rest| rest.strip_suffix(" is not defined!"))
        .and_then(|variable| variable.split('[').next())
        .or_else(|| message.strip_prefix("Unknown function '").and_then(|rest| rest.strip_suffix('\'')))
        .or_else(|| message.strip_prefix("Unknown command: "));
    name.is_some_and(|name| quarantined.contains(name))
}

impl Compiler {
    fn verify(&self, source: &str) -> Vec<Error> {
        let (ast, mut errors, quarantined) = parse_ast_recovering_with_quarantine(source);
        if let Some(ast) = ast {
            errors.extend(create_program(ast).verify_all().into_iter().filter(|error| !uses_quarantined(error, &quarantined)));
        }
        errors.sort_by(|a, b| (a.start, a.finish).cmp(&(b.start, b.finish)));
        errors.dedup_by(|a, b| a.start == b.start && a.finish == b.finish && a.message == b.message);
        errors
    }

    pub fn check(&self, source: &str) -> CompilationMessage {
        CompilationMessage::diagnostics(self.verify(source))
    }

    pub async fn compile(&mut self, source : &str) -> CompilationMessage {
        let errors = self.verify(source);
        if !errors.is_empty() {
            return CompilationMessage::diagnostics(errors);
        }
        // Recovered source is only inspected. Executable code always comes
        // from the unchanged source through the strict parser/type checker.
        match parse_ast(source) {
            Ok(ast) => {
                let mut program = create_program(ast);
                match program.type_check() {
                    Err(error) =>  {
                        CompilationMessage::create_error_message(error)
                    },
                    Ok(_) => {
                        CompilationMessage::ok(Runtime::new(program, Canvas::new()).await)
                    }
                }
            },
            Err(err) => {
                CompilationMessage::create_error_message(err)
            }
        }
    }

    // pub fn linear_compile(&mut self, source : &str) -> LinearCompilationMessage {
    //     match parse_ast(source) {
    //         Ok(ast) => {
    //             let mut program = create_program(ast);
    //             match program.type_check() {
    //                 Err(error) =>  {
    //                     LinearCompilationMessage::create_error_message(error)
    //                 },
    //                 Ok(_) => {
    //                     let (c, r) = construct_canvas();
    //                     LinearCompilationMessage::ok(linear_runtime::Runtime::new(program, c, r))
    //                 }
    //             }
    //         },
    //         Err(err) => {
    //             LinearCompilationMessage::create_error_message(err)
    //         }
    //     }
    // }

    
}



#[cfg(test)]
mod tests {
    use crate::Compiler;

    #[test]
    fn uses_of_a_broken_declaration_are_not_reported_as_undefined() {
        let errors = Compiler::new().verify("array<int, 2> bx = {0,,1};\nprint(bx[0]);\nbx[1] = 2;\nprint(missing);");
        let messages: Vec<_> = errors.iter().map(|error| (error.start.0, error.message.as_str())).collect();
        assert_eq!(errors.len(), 2, "{:?}", messages);
        assert_eq!(errors[0].start.0, 1);
        assert_eq!(errors[1].message, "Variable missing is not defined!");
    }

    #[test]
    fn calls_to_a_broken_function_are_not_reported_as_unknown() {
        let errors = Compiler::new().verify("func helper(int x {\n}\nfunc main() {\n  helper(1);\n  int y = helper(2);\n}");
        assert_eq!(errors.len(), 1, "{:?}", errors);
    }
}
