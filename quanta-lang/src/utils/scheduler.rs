use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex};

use quanta_parser::error::Error;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

use crate::utils::canvas::Canvas;

/// How long the interpreter may run before handing control back to the browser
/// so it can process input events and stay responsive.
const YIELD_BUDGET_MS: f64 = 8.0;

/// Frame rate used until the program calls `setFps`.
const DEFAULT_FPS: i32 = 30;

/// A display refresh that lands this close before the target time still counts,
/// so a 60 fps target on a 60 Hz display doesn't skip frames because of jitter.
const FRAME_TOLERANCE_MS: f64 = 2.0;

#[wasm_bindgen(inline_js = r#"
export function now_ms() {
    return performance.now();
}

// Resolves on the next macrotask. Unlike setTimeout(0), it isn't clamped to 4 ms
// when called repeatedly.
export function next_macrotask() {
    return new Promise(resolve => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
            channel.port1.close();
            resolve();
        };
        channel.port2.postMessage(null);
    });
}

export function next_animation_frame() {
    return new Promise(resolve => requestAnimationFrame(resolve));
}

export function wait_ms(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
"#)]
extern "C" {
    fn now_ms() -> f64;
    fn next_macrotask() -> js_sys::Promise;
    fn next_animation_frame() -> js_sys::Promise;
    fn wait_ms(ms: f64) -> js_sys::Promise;
}

#[derive(Debug)]
struct Clock {
    /// 0 means no cap: one frame per display refresh.
    frame_interval_ms: f64,
    last_frame_at: f64,
    last_yield_at: f64,
}

/// Decides when a running program pauses: on `frame()`, on `sleep()`, and
/// briefly whenever it has run longer than the yield budget. Shared by the
/// main, keyboard and mouse executions of one program.
#[derive(Debug, Clone)]
pub struct Scheduler {
    clock: Arc<Mutex<Clock>>,
    cancelled: Arc<AtomicBool>,
}

impl Scheduler {
    pub fn new() -> Scheduler {
        Scheduler {
            clock: Arc::new(Mutex::new(Clock {
                frame_interval_ms: 1000.0 / DEFAULT_FPS as f64,
                last_frame_at: 0.0,
                last_yield_at: 0.0,
            })),
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Resets the clock to the current time. Called when the program starts.
    pub fn start(&self) {
        let now = now_ms();
        let mut clock = self.clock.lock().unwrap();
        clock.last_frame_at = now;
        clock.last_yield_at = now;
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// Sets the frame rate `frame()` keeps. 0 removes the cap, so frames
    /// follow the display's refresh rate.
    pub fn set_fps(&self, fps: i32) {
        self.clock.lock().unwrap().frame_interval_ms = if fps == 0 { 0.0 } else { 1000.0 / fps as f64 };
    }

    /// Lets the browser handle events and paint if the program has been
    /// running longer than the yield budget. Drawing done so far is flushed
    /// first, so programs without `frame()` still show progress.
    pub async fn maybe_yield(&self, canvas: &Canvas) -> Result<(), Error> {
        self.check_cancelled()?;
        let last_yield_at = self.clock.lock().unwrap().last_yield_at;
        if now_ms() - last_yield_at < YIELD_BUDGET_MS {
            return Ok(());
        }
        canvas.flush(false);
        let _ = JsFuture::from(next_macrotask()).await;
        self.mark_yielded();
        self.check_cancelled()
    }

    pub async fn sleep(&self, ms: i32) -> Result<(), Error> {
        let _ = JsFuture::from(wait_ms(ms as f64)).await;
        self.mark_yielded();
        self.check_cancelled()
    }

    /// Waits for the first display refresh at least one frame interval after
    /// the previous frame. If that time has already passed (a slow frame, or
    /// the program slept), it only yields once so the frame gets painted.
    /// Without a cap, it always waits for the next display refresh.
    pub async fn wait_for_next_frame(&self) -> Result<(), Error> {
        let (target, interval) = {
            let clock = self.clock.lock().unwrap();
            (clock.last_frame_at + clock.frame_interval_ms, clock.frame_interval_ms)
        };
        let now = if interval == 0.0 {
            let _ = JsFuture::from(next_animation_frame()).await;
            self.check_cancelled()?;
            now_ms()
        } else if now_ms() >= target - FRAME_TOLERANCE_MS {
            let _ = JsFuture::from(next_macrotask()).await;
            self.check_cancelled()?;
            now_ms()
        } else {
            loop {
                let _ = JsFuture::from(next_animation_frame()).await;
                self.check_cancelled()?;
                let now = now_ms();
                if now >= target - FRAME_TOLERANCE_MS {
                    break now;
                }
            }
        };
        let mut clock = self.clock.lock().unwrap();
        // Keep frames on the ideal schedule so the average rate matches the
        // target, unless we fell more than a whole frame behind (slow frame,
        // hidden tab): then start counting from now instead of catching up.
        clock.last_frame_at = if now - target > interval { now } else { target };
        clock.last_yield_at = now;
        Ok(())
    }

    fn mark_yielded(&self) {
        self.clock.lock().unwrap().last_yield_at = now_ms();
    }

    fn check_cancelled(&self) -> Result<(), Error> {
        if self.is_cancelled() {
            return Err(Error::runtime(String::from("Program stopped"), (0, 0, 0, 0)));
        }
        Ok(())
    }
}
