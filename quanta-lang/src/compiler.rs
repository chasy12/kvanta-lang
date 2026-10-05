
use quanta_parser::{parse_ast, parse_ast_recovering, error::Error};
//use crate::linear_runtime;
use crate::program::create_program;
use crate::utils::canvas::Canvas;
use crate::utils::message::{CompilationMessage};
//use crate::utils::message::{LinearCompilationMessage};
use crate::{Compiler, runtime::Runtime};

impl Compiler {
    fn verify(&self, source: &str) -> Vec<Error> {
        let (ast, mut errors) = parse_ast_recovering(source);
        if let Some(ast) = ast {
            errors.extend(create_program(ast).verify_all());
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


