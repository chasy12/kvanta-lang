
use error::Error;
use pest::Parser;
use pest_derive::Parser;

use crate::ast::{builder::AstBuilder, AstProgram};
pub mod ast;
pub mod error;
mod recovery;
pub use recovery::{parse_ast_recovering, parse_ast_recovering_with_quarantine};

#[derive(Parser)]
#[grammar = "../grammar/grammar.pest"]
pub struct QuantaParser;

pub fn parse_ast(source : &str) -> Result<AstProgram, Error> {
    let (ast, diagnostics) = parse_ast_with_diagnostics(source)?;
    if let Some(error) = diagnostics.into_iter().next() { Err(error) } else { Ok(ast) }
}

/// Deepest allowed nesting of `(`, `[` and `{` brackets, counted together.
pub const MAX_NESTING: usize = 64;

/// Rejects source nested deeper than `MAX_NESTING` before it reaches the
/// recursive parser and AST builder, which would overflow the stack on it.
/// Brackets inside strings and comments don't count. The error points at the
/// first bracket that is too deep.
fn check_nesting(source: &str) -> Result<(), Error> {
    let (mut line, mut column, mut depth) = (1, 1, 0usize);
    let mut chars = source.chars().peekable();
    while let Some(c) = chars.next() {
        let start = (line, column);
        match c {
            '\n' => { line += 1; column = 1; continue; },
            '"' => {
                // A string literal runs to the next unescaped quote and may span lines.
                column += 1;
                while let Some(inner) = chars.next() {
                    if inner == '\n' { line += 1; column = 1; continue; }
                    column += 1;
                    if inner == '\\' {
                        if let Some(escaped) = chars.next() {
                            if escaped == '\n' { line += 1; column = 1; } else { column += 1; }
                        }
                    } else if inner == '"' { break; }
                }
                continue;
            },
            '/' if chars.peek() == Some(&'/') => {
                while chars.peek().map_or(false, |next| *next != '\n') { chars.next(); }
                continue;
            },
            '(' | '[' | '{' => {
                depth += 1;
                if depth > MAX_NESTING {
                    return Err(Error::parse(
                        String::from("Code is nested too deeply (more than 64 levels)"),
                        (start.0, start.1, start.0, start.1 + 1),
                    ));
                }
            },
            ')' | ']' | '}' => depth = depth.saturating_sub(1),
            _ => {},
        }
        column += 1;
    }
    Ok(())
}

fn parse_ast_with_diagnostics(source: &str) -> Result<(AstProgram, Vec<Error>), Error> {
    check_nesting(source)?;
    let parsed_doc = QuantaParser::parse(Rule::document, source);
    let mut builder = AstBuilder::new();
    match parsed_doc {
        Ok(doc) => {
            let ast = builder.build_ast_from_doc(doc)?;
            Ok((ast, builder.diagnostics.into_inner()))
        },
        Err(err) => Err(Error::from_pest_error(err))
    }
}


#[cfg(test)]
mod tests {
    use std::{fs};

    use super::*;

    #[test]
    fn it_works() {
        let text = "func mouse(int x, int y) {
    setFigureColor(Color::Red);
    rectangle(x, y, x+100, y+100);
}

func keyboard(int key) {
    if (key == Key::Space) {
        setFigureColor(Color::Blue);
    } else {
      if (key == Key::A) {
          setFigureColor(Color::Black);
      } else {
          setFigureColor(Color::Yellow);
      }
    }
}

func main() {
   setLineColor(Color::Green);
   for i in (0..10000) {
      circle(320, 240, i % 100);
   }
   rectangle(0, 0, 100, 100);
}
";
        let wrong_text = "circle(320q, 240, 100);";
        assert!(parse_ast(text).is_ok());
        assert!(parse_ast(wrong_text).is_err());
    }

    #[test]
    fn test_file() {
        let file_path = "../grammar/test.txt";

        let contents = fs::read_to_string(file_path)
            .expect("Should have been able to read the file");
        assert!(contents.len() > 0);
        let res = parse_ast(contents.as_str());
        match &res {
            Ok(_ast) => {},
            Err(error) => {println!("{}", error)}
        }
        assert!(res.is_ok());
    }
}
