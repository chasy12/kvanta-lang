use quanta_parser::{ast::{BaseType, BaseValue, BaseValueType, Coords}, error::Error};

/// Defaults belong to a program. Each text draw takes a copy before applying overrides.
#[derive(Debug, Clone, PartialEq)]
pub struct TextStyle {
    pub color: u32,
    pub size: i32,
    pub font: String,
    pub align: String,
    pub bold: bool,
    pub italic: bool,
    /// Distance between lines as a multiple of the font size.
    pub line_height: f32,
}

impl Default for TextStyle {
    fn default() -> Self {
        Self {
            color: 0xffffffff,
            size: 24,
            font: "system-ui".into(),
            align: "left".into(),
            bold: false,
            italic: false,
            line_height: 1.2,
        }
    }
}

pub fn option_type(name: &str) -> Option<BaseType> {
    Some(match name {
        "color" => BaseType::Color,
        "size" => BaseType::Int,
        "font" | "align" => BaseType::StringType,
        "bold" | "italic" => BaseType::Bool,
        "lineHeight" => BaseType::Float,
        _ => return None,
    })
}

pub const SETTERS: [(&str, &str); 7] = [
    ("setTextColor", "color"),
    ("setTextSize", "size"),
    ("setTextFont", "font"),
    ("setTextAlign", "align"),
    ("setTextBold", "bold"),
    ("setTextItalic", "italic"),
    ("setTextLineHeight", "lineHeight"),
];

impl TextStyle {
    /// Setters and per-call options share validation and error locations.
    pub fn apply(&mut self, name: &str, value: &BaseValue, coords: Coords) -> Result<(), Error> {
        use BaseValueType::*;
        match (name, &value.val) {
            ("color", Color(r, g, b, a)) => self.color = u32::from_be_bytes([*r, *g, *b, *a]),
            ("size", Int(size)) if *size > 0 => self.size = *size,
            ("font", StringVal(font)) if !font.trim().is_empty() && !font.chars().any(char::is_control) => {
                self.font = font.trim().to_string();
            },
            ("align", StringVal(align)) if matches!(align.as_str(), "left" | "center" | "right" | "start" | "end") => {
                self.align = align.clone();
            },
            ("bold", Bool(bold)) => self.bold = *bold,
            ("italic", Bool(italic)) => self.italic = *italic,
            ("lineHeight", Float(height)) if height.is_finite() && *height > 0.0 => self.line_height = *height,
            _ => {
                let requirement = match name {
                    "size" => "a positive int",
                    "font" => "a non-empty font name without control characters",
                    "align" => "left, center, right, start or end",
                    "lineHeight" => "a positive finite float",
                    _ => "a value of the declared option type",
                };
                return Err(Error::runtime(format!("Text option '{}' requires {}", name, requirement), coords));
            },
        }
        Ok(())
    }
}
