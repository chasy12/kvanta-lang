//! Verification-only recovery. Bad statements are quarantined in a copy of
//! the source; the compiler never executes the resulting partial AST.
use crate::{ast::AstProgram, error::Error, parse_ast_with_diagnostics};

#[derive(Clone, Copy)]
struct Region { start: usize, end: usize }

struct Block { start: usize, statement: usize, parens: usize, brackets: usize, arrays: usize }

fn code_header(chars: &[char]) -> bool {
    let token: String = chars.iter().copied().skip_while(|c| c.is_whitespace())
        .take_while(|c| c.is_alphanumeric() || *c == '_').collect();
    matches!(token.as_str(), "func" | "global" | "if" | "else" | "for" | "while")
}

/// Locate synchronization boundaries without treating punctuation inside
/// strings, comments, parenthesized expressions or array literals as code.
fn regions(source: &str) -> Vec<Region> {
    let chars: Vec<char> = source.chars().collect();
    let mut result = vec![];
    let mut blocks = vec![Block { start: 0, statement: 0, parens: 0, brackets: 0, arrays: 0 }];
    let mut string = false;
    let mut comment = false;
    let mut leading_comment = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if comment {
            if c == '\n' {
                comment = false;
                if leading_comment { blocks.last_mut().unwrap().statement = i + 1; }
            }
            i += 1;
            continue;
        }
        if string {
            if c == '"' { string = false; }
            i += 1;
            continue;
        }
        if c == '"' { string = true; i += 1; continue; }
        if c == '/' && chars.get(i + 1) == Some(&'/') {
            leading_comment = chars[blocks.last().unwrap().statement..i].iter().all(|c| c.is_whitespace());
            comment = true;
            i += 2;
            continue;
        }
        let depth = blocks.len();
        let block = blocks.last_mut().unwrap();
        match c {
            '(' => block.parens += 1,
            ')' => block.parens = block.parens.saturating_sub(1),
            '[' => block.brackets += 1,
            ']' => block.brackets = block.brackets.saturating_sub(1),
            '{' => {
                let code = code_header(&chars[block.statement..i]);
                if code && block.arrays == 0 {
                    let start = block.statement;
                    result.push(Region { start, end: i + 1 });
                    blocks.push(Block { start, statement: i + 1, parens: 0, brackets: 0, arrays: 0 });
                } else { block.arrays += 1; }
            },
            '}' if block.arrays > 0 => block.arrays -= 1,
            '}' if depth > 1 => {
                let block = blocks.pop().unwrap();
                if block.statement < i { result.push(Region { start: block.statement, end: i }); }
                result.push(Region { start: block.start, end: i + 1 });
                blocks.last_mut().unwrap().statement = i + 1;
            },
            ';' if block.arrays == 0 => {
                result.push(Region { start: block.statement, end: i + 1 });
                block.statement = i + 1;
                block.parens = 0;
                block.brackets = 0;
            },
            '\n' if block.parens == 0 && block.brackets == 0 && block.arrays == 0 => {
                // This candidate enables recovery of a missing semicolon.
                // It is used only after strict parsing failed.
                if !code_header(&chars[block.statement..i]) {
                    result.push(Region { start: block.statement, end: i });
                    block.statement = i + 1;
                }
            },
            _ => {},
        }
        i += 1;
    }
    for block in blocks {
        result.push(Region { start: block.statement, end: chars.len() });
        result.push(Region { start: block.start, end: chars.len() });
    }
    result
}

fn position(chars: &[char], (row, column): (usize, usize)) -> usize {
    let mut line = 1;
    let mut col = 1;
    for (i, c) in chars.iter().enumerate() {
        if line == row && col >= column.max(1) { return i; }
        if *c == '\n' { line += 1; col = 1; } else { col += 1; }
    }
    chars.len()
}

pub fn parse_ast_recovering(source: &str) -> (Option<AstProgram>, Vec<Error>) {
    let mut chars: Vec<char> = source.chars().collect();
    let candidates = regions(source);
    let mut errors = vec![];
    loop {
        let working: String = chars.iter().collect();
        match parse_ast_with_diagnostics(&working) {
            Ok((ast, diagnostics)) => {
                errors.extend(diagnostics);
                return (Some(ast), errors);
            },
            Err(mut error) => {
                let pos = position(&chars, error.start);
                if error.message.starts_with("ERROR ") && error.message.contains(" on line '") {
                    if let Some(line) = source.lines().nth(error.start.0.saturating_sub(1)) {
                        let prefix = error.message.split(" on line '").next().unwrap();
                        error.message = format!("{} on line '{}'", prefix, line);
                    }
                }
                errors.push(error);
                let contains_code = |region: &&Region| chars[region.start..region.end].iter().any(|c| !c.is_whitespace());
                let region = candidates.iter().filter(contains_code)
                    .filter(|r| r.start <= pos && pos < r.end)
                    .min_by_key(|r| r.end - r.start)
                    .or_else(|| candidates.iter().filter(contains_code)
                        .filter(|r| r.end <= pos)
                        .max_by_key(|r| (r.end, usize::MAX - (r.end - r.start))))
                    .copied();
                let Some(region) = region else { return (None, errors); };
                for c in &mut chars[region.start..region.end] {
                    if *c != '\n' && *c != '\r' { *c = ' '; }
                }
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovers_siblings_on_the_same_line() {
        let (ast, errors) = parse_ast_recovering("circle(1,,2); rectangle(1,,2,3);");
        assert!(ast.is_some());
        assert_eq!(errors.len(), 2);
    }
    #[test]
    fn collects_ast_errors_inside_one_expression() {
        let (_, errors) = parse_ast_recovering("array<color,2> palette = {Color::Nope,Color::Wrong};");
        assert_eq!(errors.len(), 2, "{:?}", errors);
    }
    #[test]
    fn rejects_out_of_range_literals_without_panicking() {
        let (_, errors) = parse_ast_recovering("int x = 999999999999999999999; float y = 999999999999999999999999999999999999999999999999999.0;");
        assert_eq!(errors.len(), 2);
        assert!(crate::parse_ast("int x = 999999999999999999999;").is_err());
    }
    #[test]
    fn preserves_strings_arrays_comments_and_coordinates() {
        let (_, errors) = parse_ast_recovering("print(\"😀;{}\"); // ;{}\ncolor a = Color::Nope;\ncolor b = Color::Wrong;");
        assert_eq!(errors.len(), 2);
        assert_eq!(errors[0].start.0, 2);
        assert_eq!(errors[1].start.0, 3);
    }
    #[test]
    fn recovers_nested_statements_and_later_functions() {
        let (ast, errors) = parse_ast_recovering("// start\nfunc broken() {\n circle(1,,2);\n rectangle(1,,2,3);\n}\nfunc main() {\n circle(1,,2);\n}");
        assert!(ast.is_some());
        assert_eq!(errors.len(), 3, "{:?}", errors);
        assert_eq!(errors.iter().map(|error| error.start.0).collect::<Vec<_>>(), vec![3, 4, 7]);
    }
    #[test]
    fn recognizes_headers_with_tabs_and_newlines() {
        for header in ["func\tfirst()", "func\nfirst()", "func first()\n"] {
            let (_, errors) = parse_ast_recovering(&format!("{} {{\n circle(1,,2);\n rectangle(1,,2,3);\n}}\nfunc main() {{ circle(1,,2); }}", header));
            assert_eq!(errors.len(), 3, "{} {:?}", header, errors);
        }
        let (_, errors) = parse_ast_recovering("for\ti in (0..1) { circle(1,,2); rectangle(1,,2,3); }");
        assert_eq!(errors.len(), 2);
    }
    #[test]
    fn recovers_missing_semicolons_without_hiding_later_errors() {
        let (ast, errors) = parse_ast_recovering("int a = 1\nint b = 2\ncircle(true,false,1);");
        assert!(ast.is_some());
        assert_eq!(errors.len(), 2, "{:?}", errors);
        assert_eq!(errors.iter().map(|error| error.start.0).collect::<Vec<_>>(), vec![1, 2]);
    }
}
