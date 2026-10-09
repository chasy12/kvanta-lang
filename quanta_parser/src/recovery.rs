//! Verification-only recovery. Bad statements are quarantined in a copy of
//! the source; the compiler never executes the resulting partial AST.
use std::collections::HashSet;

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
            if c == '\\' { i += 2; continue; }
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

/// Index just past the last code character of `line`, ignoring a trailing
/// `//` comment and whitespace; 0 for a blank or comment-only line.
fn code_end(line: &[char]) -> usize {
    let mut string = false;
    let mut last = 0;
    let mut i = 0;
    while i < line.len() {
        let c = line[i];
        if string {
            if c == '\\' { i += 2; continue; }
            if c == '"' { string = false; last = i + 1; }
        } else if c == '/' && line.get(i + 1) == Some(&'/') {
            break;
        } else {
            if c == '"' { string = true; }
            if !c.is_whitespace() { last = i + 1; }
        }
        i += 1;
    }
    last
}

/// When `pos` is the first token on its line, the index just past the code
/// on the closest earlier line that has any: where a forgotten `;` belongs.
fn previous_code_end(chars: &[char], pos: usize) -> Option<usize> {
    let line_start = chars[..pos].iter().rposition(|c| *c == '\n')? + 1;
    if !chars[line_start..pos].iter().all(|c| c.is_whitespace()) { return None; }
    let mut end = line_start - 1;
    loop {
        let start = chars[..end].iter().rposition(|c| *c == '\n').map_or(0, |i| i + 1);
        let code = code_end(&chars[start..end]);
        if code > 0 { return Some(start + code); }
        if start == 0 { return None; }
        end = start - 1;
    }
}

fn row_column(chars: &[char], index: usize) -> (usize, usize) {
    let row = 1 + chars[..index].iter().filter(|c| **c == '\n').count();
    let line_start = chars[..index].iter().rposition(|c| *c == '\n').map_or(0, |i| i + 1);
    (row, index - line_start + 1)
}

/// Names that the statements in `text` declare (variables and functions),
/// best effort, since the text failed to parse.
fn declared_names(text: &[char]) -> Vec<String> {
    let mut tokens = vec![];
    let mut i = 0;
    while i < text.len() {
        let c = text[i];
        if c == '"' {
            i += 1;
            while i < text.len() && text[i] != '"' { i += if text[i] == '\\' { 2 } else { 1 }; }
            tokens.push("\"".to_string());
        } else if c == '/' && text.get(i + 1) == Some(&'/') {
            while i < text.len() && text[i] != '\n' { i += 1; }
        } else if c.is_alphanumeric() || c == '_' {
            let start = i;
            while i < text.len() && (text[i].is_alphanumeric() || text[i] == '_') { i += 1; }
            tokens.push(text[start..i].iter().collect());
            continue;
        } else if !c.is_whitespace() {
            tokens.push(c.to_string());
        }
        i += 1;
    }
    let mut names = vec![];
    for statement in tokens.split(|token| matches!(token.as_str(), ";" | "{" | "}")) {
        let mut rest = statement;
        if rest.first().is_some_and(|token| token == "global") { rest = &rest[1..]; }
        if rest.first().is_some_and(|token| token == "func") {
            names.extend(rest.get(1).cloned());
            continue;
        }
        if rest.first().is_some_and(|token| token == "const") { rest = &rest[1..]; }
        let name = match rest.first().map(String::as_str) {
            Some("int" | "float" | "bool" | "color" | "string") => rest.get(1),
            Some("array") => {
                let mut depth = 0;
                let close = rest.iter().position(|token| {
                    match token.as_str() { "<" => depth += 1, ">" => depth -= 1, _ => {} }
                    token == ">" && depth == 0
                });
                close.and_then(|close| rest.get(close + 1))
            },
            _ => None,
        };
        if let Some(name) = name.filter(|name| name.chars().next().is_some_and(|c| c.is_alphabetic() || c == '_')) {
            names.push(name.clone());
        }
    }
    names
}

pub fn parse_ast_recovering(source: &str) -> (Option<AstProgram>, Vec<Error>) {
    let (ast, errors, _) = parse_ast_recovering_with_quarantine(source);
    (ast, errors)
}

/// Like `parse_ast_recovering`, also returning the names declared by the
/// quarantined code, so uses of them are not reported as undefined.
pub fn parse_ast_recovering_with_quarantine(source: &str) -> (Option<AstProgram>, Vec<Error>, HashSet<String>) {
    // Too-deep nesting can't be recovered from region by region: report it once.
    if let Err(error) = crate::check_nesting(source) { return (None, vec![error], HashSet::new()); }
    let mut chars: Vec<char> = source.chars().collect();
    let mut candidates = regions(source);
    let mut errors = vec![];
    let mut quarantined = HashSet::new();
    loop {
        let working: String = chars.iter().collect();
        match parse_ast_with_diagnostics(&working) {
            Ok((ast, diagnostics)) => {
                errors.extend(diagnostics);
                return (Some(ast), errors, quarantined);
            },
            Err(mut error) => {
                let pos = position(&chars, error.start);
                // An error at the first token of a line usually means the
                // previous statement is missing its `;`. Insert it, as
                // rustc and clang do, if that lets parsing get further.
                if let Some(end) = previous_code_end(&chars, pos) {
                    let mut repaired = chars.clone();
                    repaired.insert(end, ';');
                    let progressed = match parse_ast_with_diagnostics(&repaired.iter().collect::<String>()) {
                        Ok(_) => true,
                        Err(next) => position(&repaired, next.start) > pos + 1,
                    };
                    if progressed {
                        let (row, column) = row_column(&repaired, end);
                        errors.push(Error::parse("Probably missing ';'".to_string(), (row, column, row, column)));
                        chars = repaired;
                        candidates = regions(&chars.iter().collect::<String>());
                        continue;
                    }
                }
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
                    .copied()
                    // Blanking a broken block header alone would orphan its
                    // body and closing `}`, so quarantine the whole block.
                    .map(|region| if chars[region.end - 1] != '{' { region } else {
                        candidates.iter().filter(|r| r.start == region.start && r.end > region.end)
                            .min_by_key(|r| r.end).copied().unwrap_or(region)
                    });
                let Some(region) = region else { return (None, errors, quarantined); };
                quarantined.extend(declared_names(&chars[region.start..region.end]));
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
    #[test]
    fn escaped_quotes_do_not_hide_later_bad_statements() {
        for source in [r#"print("\";{}");
circle(1,,2);
rectangle(1,,2,3);"#, r#"print("a\"b");
circle(1,,2);
rectangle(1,,2,3);"#] {
            let (ast, errors) = parse_ast_recovering(source);
            assert!(ast.is_some());
            assert_eq!(errors.len(), 2, "{:?}", errors);
            assert_eq!(errors.iter().map(|error| error.start.0).collect::<Vec<_>>(), vec![2,3]);
        }
    }
    #[test]
    fn blames_a_missing_semicolon_on_its_own_line_without_cascading() {
        let source = "func main() {\n  int speed = 3\n  array<int, 16> bx = {0...};\n  array<int, 16> by = {0...};\n  for i in (0..16) {\n    circle(bx[i], by[i], speed);\n  }\n}\n";
        let (ast, errors) = parse_ast_recovering(source);
        assert!(ast.is_some());
        assert_eq!(errors.len(), 1, "{:?}", errors);
        assert_eq!(errors[0].message, "Probably missing ';'");
        assert_eq!(errors[0].start, (2, 16));
    }
    #[test]
    fn missing_semicolon_skips_trailing_and_standalone_comments() {
        let source = "int a = 1 // one; {\n// note\n\n    int b = 2;\nprint(a + b);";
        let (ast, errors) = parse_ast_recovering(source);
        assert!(ast.is_some());
        assert_eq!(errors.len(), 1, "{:?}", errors);
        assert_eq!(errors[0].message, "Probably missing ';'");
        assert_eq!(errors[0].start, (1, 10));
    }
    #[test]
    fn reports_names_declared_by_quarantined_statements() {
        let source = "global {\n  array<array<int, 2>, 2> grid = {{1,,2}};\n}\nfunc broken(int x {\n}\nfunc main() {\n  const int n = (1;\n  print(n);\n}";
        let (_, errors, names) = parse_ast_recovering_with_quarantine(source);
        assert!(!errors.is_empty());
        for name in ["grid", "broken", "n"] {
            assert!(names.contains(name), "{} not in {:?}", name, names);
        }
        assert!(!names.contains("main") && !names.contains("print"), "{:?}", names);
    }

}
