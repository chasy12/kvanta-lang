use std::{collections::HashMap, sync::{Arc, Mutex}};

use futures::{channel::oneshot, future::{select, Either}};
use js_sys::{Function, Promise};
use quanta_parser::{ast::{BaseValueType, Coords}, error::Error};
use wasm_bindgen::JsValue;
use wasm_bindgen_futures::JsFuture;

#[derive(Debug, Default)]
struct State {
    handler: Option<Function>,
    pending: HashMap<u64, oneshot::Sender<()>>,
    next_id: u64,
    cancelled: bool,
}

/// One input channel shared by main, nested functions and event handlers.
/// Cancellation wakes reads even if the JavaScript callback never resolves.
#[derive(Debug, Clone, Default)]
pub struct Input {
    state: Arc<Mutex<State>>,
}

impl Input {
    pub fn set_handler(&self, handler: Function) {
        self.state.lock().unwrap().handler = Some(handler);
    }

    pub fn cancel(&self) {
        let pending = {
            let mut state = self.state.lock().unwrap();
            state.cancelled = true;
            state.handler = None;
            std::mem::take(&mut state.pending)
        };
        for (_, sender) in pending {
            let _ = sender.send(());
        }
    }

    pub async fn read(&self, kind: &str, coords: Coords) -> Result<BaseValueType, Error> {
        let response = self.request(&JsValue::from_str(kind), coords).await?;
        let raw = response.as_string().ok_or_else(|| invalid_input(kind, coords))?;
        parse_value(kind, &raw).ok_or_else(|| invalid_input(kind, coords))
    }

    pub async fn read_many(&self, kinds: &[&str], coords: Coords) -> Result<Vec<BaseValueType>, Error> {
        let descriptor = js_sys::Array::new();
        for kind in kinds { descriptor.push(&JsValue::from_str(kind)); }
        let response = self.request(descriptor.as_ref(), coords).await?;
        let raw = response.as_string().ok_or_else(|| {
            Error::runtime(String::from("Invalid input row: expected text"), coords)
        })?;
        parse_row(kinds, &raw, coords)
    }

    async fn request(&self, descriptor: &JsValue, coords: Coords) -> Result<JsValue, Error> {
        let (id, handler, cancelled) = {
            let mut state = self.state.lock().unwrap();
            if state.cancelled {
                return Err(Error::runtime(String::from("Program stopped"), coords));
            }
            let handler = state.handler.clone().ok_or_else(|| {
                Error::runtime(String::from("Input handler is not set"), coords)
            })?;
            let id = state.next_id;
            state.next_id += 1;
            let (sender, receiver) = oneshot::channel();
            state.pending.insert(id, sender);
            (id, handler, receiver)
        };

        // Never keep a mutex guard while invoking JavaScript or awaiting it.
        let result = match handler.call1(&JsValue::NULL, descriptor) {
            Ok(response) => {
                match select(JsFuture::from(Promise::resolve(&response)), cancelled).await {
                    Either::Left((response, _)) => response.map_err(|_| {
                        Error::runtime(String::from("Input request failed"), coords)
                    }),
                    Either::Right(_) => Err(Error::runtime(String::from("Program stopped"), coords)),
                }
            }
            Err(_) => Err(Error::runtime(String::from("Input request failed"), coords)),
        };
        {
            let mut state = self.state.lock().unwrap();
            state.pending.remove(&id);
            if state.cancelled {
                return Err(Error::runtime(String::from("Program stopped"), coords));
            }
        }
        let response = result?;
        if response.is_null() {
            return Err(Error::runtime(String::from("Input request cancelled"), coords));
        }
        Ok(response)
    }
}

fn parse_row(kinds: &[&str], raw: &str, coords: Coords) -> Result<Vec<BaseValueType>, Error> {
    let values: Vec<_> = raw.split_whitespace().collect();
    if values.len() != kinds.len() {
        return Err(Error::runtime(format!("Input row expects {} values, got {}", kinds.len(), values.len()), coords));
    }
    kinds.iter().zip(values).enumerate().map(|(index, (kind, raw))| {
        parse_value(kind, raw).ok_or_else(|| {
            let position = index + 1;
            let message = match *kind {
                "int" => format!("Invalid int input at position {}: expected a whole number from -2147483648 to 2147483647", position),
                "float" => format!("Invalid float input at position {}: expected a finite decimal number", position),
                "bool" => format!("Invalid bool input at position {}: expected true or false", position),
                _ => return invalid_input(kind, coords),
            };
            Error::runtime(message, coords)
        })
    }).collect()
}

fn invalid_input(kind: &str, coords: Coords) -> Error {
    let message = match kind {
        "int" => "Invalid int input: expected a whole number from -2147483648 to 2147483647",
        "float" => "Invalid float input: expected a finite decimal number",
        "bool" => "Invalid bool input: expected true or false",
        "string" => "Invalid string input: expected text",
        _ => return Error::runtime(format!("Invalid {} input", kind), coords),
    };
    Error::runtime(message.to_string(), coords)
}

fn parse_value(kind: &str, raw: &str) -> Option<BaseValueType> {
    let trimmed = raw.trim();
    match kind {
        "int" => trimmed.parse::<i32>().ok().map(BaseValueType::Int),
        "float" => trimmed.parse::<f32>().ok().filter(|value| value.is_finite()).map(BaseValueType::Float),
        "bool" => match trimmed {
            "true" => Some(BaseValueType::Bool(true)),
            "false" => Some(BaseValueType::Bool(false)),
            _ => None,
        },
        "string" => Some(BaseValueType::StringVal(raw.to_string())),
        _ => None,
    }
}
