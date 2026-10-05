use std::fmt;

use wasm_bindgen::prelude::*;
use quanta_parser::error::{Error, ErrorType};
use crate::runtime::Runtime;
//use crate::linear_runtime;

#[derive(Clone)]
#[wasm_bindgen]
pub struct RuntimeError {
    pub error_code: u32,
    error_message: String,
    pub start_row: usize,
    pub start_column: usize,
    pub end_row: usize,
    pub end_column: usize
}

#[wasm_bindgen]
impl RuntimeError {
    pub fn get_error_message(&self) -> String {
        self.error_message.clone()
    }
}

impl RuntimeError {
    pub fn zero() -> RuntimeError {
        RuntimeError { error_code: 0, error_message: "".to_string(), start_row: 0, start_column: 0, end_row: 0, end_column: 0 }
    }

    pub fn new(error: Error) -> RuntimeError {
        RuntimeError { 
            error_code: match error.error_type {
                ErrorType::ParseError => {1},
                ErrorType::LogicError=> {2},
                ErrorType::TypeError=> {3},
                ErrorType::RuntimeError=> {4},
            }, 
            error_message: error.message.to_string(), 
            start_row: error.start.0,
            start_column: error.start.1,
            end_row: error.finish.0,
            end_column: error.finish.1
        }
    }
}


#[wasm_bindgen]
pub struct CompilationMessage {
    pub error_code: u32,
    errors: Vec<RuntimeError>,
    runtime: Option<Runtime>,
    
}


// pub struct LinearCompilationMessage {
//     pub error_code: u32,
//     error_message: String,
//     runtime: Option<linear_runtime::Runtime>
// }

#[wasm_bindgen]
impl CompilationMessage {
    #[wasm_bindgen]
    pub fn get_runtime(&self) -> Runtime {
        self.runtime.clone().unwrap()
    }

    pub fn get_error(&self) -> RuntimeError {
        self.errors.first().cloned().unwrap()
    }

    pub fn get_errors(&self) -> Vec<RuntimeError> {
        self.errors.clone()
    }

    #[wasm_bindgen]
    pub fn get_error_message(&self) -> String {
        self.errors.first().unwrap().error_message.clone()
    }
}

impl CompilationMessage {

    pub(crate) fn ok(runtime: Runtime) -> CompilationMessage {
        CompilationMessage {
            error_code: 0,
            errors: vec![],
            runtime: Some(runtime),
        }
    }

    pub(crate) fn create_error_message(error: Error) -> CompilationMessage {
        Self::diagnostics(vec![error])
    }

    pub(crate) fn diagnostics(errors: Vec<Error>) -> CompilationMessage {
        let errors: Vec<_> = errors.into_iter().map(RuntimeError::new).collect();
        CompilationMessage {
            error_code: errors.first().map_or(0, |error| error.error_code),
            runtime: None,
            errors,
        }
    }
}

// impl LinearCompilationMessage {


//     pub fn get_runtime(&self) -> linear_runtime::Runtime {
//         self.runtime.clone().unwrap()
//     }

//     pub fn get_error_message(&self) -> String {
//         self.error_message.clone()
//     }


//     pub(crate) fn ok(runtime: linear_runtime::Runtime) -> LinearCompilationMessage {
//         LinearCompilationMessage {
//             error_code: 0,
//             error_message: "".to_string(),
//             runtime: Some(runtime)
//         }
//     }

//     pub(crate) fn create_error_message(error: Error) -> LinearCompilationMessage {
//         match error.error_type {
//             ErrorType::ParseError => {
//                 LinearCompilationMessage { error_code:1, error_message: error.message.to_string(), runtime: None }
//             }
//             ErrorType::LogicError=> {
//                 LinearCompilationMessage { error_code:2, error_message: error.message.to_string(), runtime: None }
//             }
//             ErrorType::TypeError=> {
//                 LinearCompilationMessage { error_code:3, error_message: error.message.to_string(), runtime: None }
//             }
//             ErrorType::RuntimeError=> {
//                 LinearCompilationMessage { error_code:4, error_message: error.message.to_string(), runtime: None }
//             }
//         }
//     }
// }



impl fmt::Display for CompilationMessage {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "{}\n", self.error_code as usize)?;
        write!(f, "{}\n", self.get_error_message())?;
        Ok(())
    }
}
