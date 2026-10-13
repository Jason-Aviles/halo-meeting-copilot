//! Acoustic echo cancellation with sonora (a Rust port of WebRTC's AEC3).
//!
//! The speaker audio ("them") is the far-end reference. When it leaks from the
//! speakers back into the microphone, AEC3 estimates the delay and removes it,
//! so the mic stream ("you") only carries the user's own voice.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use sonora::config::{EchoCanceller as AecConfig, HighPassFilter, NoiseSuppression};
use sonora::{AudioProcessing, Config, StreamConfig};

/// Both streams are 16 kHz mono PCM16, matching what the window sends.
const SAMPLE_RATE: u32 = 16_000;
/// sonora processes audio in 10 ms frames.
const FRAME: usize = (SAMPLE_RATE / 100) as usize;

fn to_napi(err: impl std::fmt::Display) -> Error {
    Error::from_reason(format!("echo canceller: {err}"))
}

#[napi]
pub struct EchoCanceller {
    apm: AudioProcessing,
    render_pending: Vec<i16>,
    capture_pending: Vec<i16>,
    scratch: Vec<i16>,
}

#[napi]
impl EchoCanceller {
    #[napi(constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        let config = Config {
            echo_canceller: Some(AecConfig::default()),
            noise_suppression: Some(NoiseSuppression::default()),
            high_pass_filter: Some(HighPassFilter::default()),
            ..Default::default()
        };
        let stream = StreamConfig::new(SAMPLE_RATE, 1);
        let apm = AudioProcessing::builder()
            .config(config)
            .capture_config(stream)
            .render_config(stream)
            .build();
        Self {
            apm,
            render_pending: Vec::new(),
            capture_pending: Vec::new(),
            scratch: vec![0; FRAME],
        }
    }

    /// Feeds far-end audio (what's playing through the speakers).
    #[napi]
    pub fn push_render(&mut self, pcm: Int16Array) -> Result<()> {
        self.render_pending.extend_from_slice(&pcm);
        let whole = self.render_pending.len() / FRAME * FRAME;
        for frame in self.render_pending[..whole].chunks_exact(FRAME) {
            self.apm
                .process_render_i16(frame, &mut self.scratch)
                .map_err(to_napi)?;
        }
        self.render_pending.drain(..whole);
        Ok(())
    }

    /// Removes speaker echo from microphone audio. Returns the cleaned samples;
    /// a partial trailing frame is held until the next call.
    #[napi]
    pub fn process_capture(&mut self, pcm: Int16Array) -> Result<Int16Array> {
        self.capture_pending.extend_from_slice(&pcm);
        let whole = self.capture_pending.len() / FRAME * FRAME;
        let mut out = vec![0i16; whole];
        for (frame, dest) in self.capture_pending[..whole]
            .chunks_exact(FRAME)
            .zip(out.chunks_exact_mut(FRAME))
        {
            self.apm.process_capture_i16(frame, dest).map_err(to_napi)?;
        }
        self.capture_pending.drain(..whole);
        Ok(Int16Array::new(out))
    }
}
