//! Pure audio helpers: sample decoding, channel mapping, resampling, jitter buffering,
//! mixing, soft limiting and level metering. No Windows/COM dependencies, so everything
//! here is unit-tested with `cargo test --bin wasapi-capture`.

use std::collections::VecDeque;

// ---------------------------------------------------------------------------------------------
// Sample decoding
// ---------------------------------------------------------------------------------------------

/// Native sample encodings WASAPI shared mode can hand us. In practice the mix format is
/// almost always 32-bit float, but USB mics occasionally expose integer PCM.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SampleEncoding {
    F32,
    I16,
    I24,
    /// 32-bit integer container (also covers 24-in-32: valid bits are MSB-aligned).
    I32,
    /// Anything else: decoded as silence so the timeline keeps moving.
    Unsupported {
        bytes: usize,
    },
}

impl SampleEncoding {
    pub fn from_format(is_float: bool, bits_per_sample: u16) -> Self {
        match (is_float, bits_per_sample) {
            (true, 32) => Self::F32,
            (false, 16) => Self::I16,
            (false, 24) => Self::I24,
            (false, 32) => Self::I32,
            (_, bits) => Self::Unsupported {
                bytes: (bits as usize / 8).max(1),
            },
        }
    }

    pub fn bytes(self) -> usize {
        match self {
            Self::F32 | Self::I32 => 4,
            Self::I24 => 3,
            Self::I16 => 2,
            Self::Unsupported { bytes } => bytes,
        }
    }
}

/// Decode little-endian interleaved samples into f32 in [-1, 1]. Trailing bytes that don't
/// form a whole sample are ignored.
pub fn decode_samples(bytes: &[u8], enc: SampleEncoding, out: &mut Vec<f32>) {
    let n = enc.bytes();
    out.reserve(bytes.len() / n);
    for b in bytes.chunks_exact(n) {
        let v = match enc {
            SampleEncoding::F32 => f32::from_le_bytes([b[0], b[1], b[2], b[3]]),
            SampleEncoding::I16 => i16::from_le_bytes([b[0], b[1]]) as f32 / 32_768.0,
            // Place the 3 bytes in the top of an i32 so the sign bit lands correctly.
            SampleEncoding::I24 => {
                i32::from_le_bytes([0, b[0], b[1], b[2]]) as f32 / 2_147_483_648.0
            }
            SampleEncoding::I32 => {
                i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32 / 2_147_483_648.0
            }
            SampleEncoding::Unsupported { .. } => 0.0,
        };
        // Guard against NaN/inf from a misbehaving driver poisoning the mix.
        out.push(if v.is_finite() { v } else { 0.0 });
    }
}

// ---------------------------------------------------------------------------------------------
// Channel mapping
// ---------------------------------------------------------------------------------------------

/// Map interleaved `in_ch` audio to `out_ch` (1 or 2).
/// - to mono: average of all input channels;
/// - mono to stereo: duplicate;
/// - N>2 to stereo: keep front-left/front-right (surround channels are dropped — shared-mode
///   loopback endpoints are stereo in practice).
pub fn map_channels(input: &[f32], in_ch: usize, out_ch: usize, out: &mut Vec<f32>) {
    let in_ch = in_ch.max(1);
    let frames = input.len() / in_ch;
    out.reserve(frames * out_ch);
    for f in input.chunks_exact(in_ch) {
        match (in_ch, out_ch) {
            (a, b) if a == b => out.extend_from_slice(f),
            (_, 1) => out.push(f.iter().sum::<f32>() / in_ch as f32),
            (1, _) => out.extend(std::iter::repeat(f[0]).take(out_ch)),
            (_, 2) => out.extend_from_slice(&f[..2]),
            // Unsupported layout (args validation restricts out_ch to 1|2): average + duplicate.
            _ => {
                let m = f.iter().sum::<f32>() / in_ch as f32;
                out.extend(std::iter::repeat(m).take(out_ch));
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Resampling
// ---------------------------------------------------------------------------------------------

/// Number of taps of the anti-aliasing FIR used when downsampling (odd → symmetric, linear phase).
const AA_TAPS: usize = 63;

/// Streaming resampler: optional windowed-sinc low-pass (only when downsampling, so content above
/// the new Nyquist doesn't alias into speech) followed by linear interpolation. All state carries
/// across calls, so splitting the input into arbitrary buffers yields the same output.
pub struct Resampler {
    channels: usize,
    /// Nominal input frames consumed per output frame (in_rate / out_rate).
    base_step: f64,
    /// `base_step` scaled by the drift-compensation factor (see `set_rate_adjust`).
    step: f64,
    /// Position of the next output frame, in input frames, relative to `last` (index 0).
    pos: f64,
    /// Last input frame of the previous buffer (interpolation needs one frame of look-behind).
    last: Vec<f32>,
    passthrough: bool,
    aa: Option<Fir>,
}

impl Resampler {
    pub fn new(in_rate: u32, out_rate: u32, channels: usize) -> Self {
        let channels = channels.max(1);
        let step = in_rate.max(1) as f64 / out_rate.max(1) as f64;
        let aa = (in_rate > out_rate).then(|| {
            // Cutoff a bit below the output Nyquist, expressed as a fraction of the input rate.
            Fir::lowpass(0.45 * out_rate as f64 / in_rate as f64, AA_TAPS, channels)
        });
        Self {
            channels,
            base_step: step,
            step,
            // Start at index 1 = first sample of the first buffer (index 0 is the zero `last`).
            pos: 1.0,
            last: vec![0.0; channels],
            passthrough: in_rate == out_rate,
            aa,
        }
    }

    /// Fine-tune the conversion ratio for clock-drift compensation: `adjust` > 0 consumes input
    /// slightly faster (fewer output frames per input frame), < 0 slower. Clamped to
    /// ±`MAX_RATE_ADJUST_HARD`; non-finite values reset to nominal. A non-zero adjustment turns
    /// the same-rate passthrough off for good; the switch is seamless because passthrough keeps
    /// the interpolation state current.
    pub fn set_rate_adjust(&mut self, adjust: f64) {
        let adjust = if adjust.is_finite() {
            adjust.clamp(-MAX_RATE_ADJUST_HARD, MAX_RATE_ADJUST_HARD)
        } else {
            0.0
        };
        if adjust != 0.0 {
            self.passthrough = false;
        }
        self.step = self.base_step * (1.0 + adjust);
    }

    /// Resample interleaved frames, appending to `out`.
    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if self.passthrough {
            out.extend_from_slice(input);
            // Keep the look-behind current (pos stays 1.0 = "next input frame") so a later
            // switch to interpolation continues without a glitch.
            let ch = self.channels;
            let frames = input.len() / ch;
            if frames > 0 {
                self.last
                    .copy_from_slice(&input[(frames - 1) * ch..frames * ch]);
            }
            return;
        }
        let filtered;
        let input = match self.aa.as_mut() {
            Some(fir) => {
                filtered = fir.process(input);
                &filtered[..]
            }
            None => input,
        };
        let ch = self.channels;
        let frames = input.len() / ch;
        if frames == 0 {
            return;
        }
        // Virtual sequence: s[0] = last, s[i] = input frame i-1 (i = 1..=frames).
        let sample = |i: usize, c: usize| -> f32 {
            if i == 0 {
                self.last[c]
            } else {
                input[(i - 1) * ch + c]
            }
        };
        let mut pos = self.pos;
        while (pos.floor() as usize) < frames {
            let i = pos.floor() as usize;
            let frac = (pos - i as f64) as f32;
            for c in 0..ch {
                let a = sample(i, c);
                let b = sample(i + 1, c);
                out.push(a + (b - a) * frac);
            }
            pos += self.step;
        }
        self.pos = pos - frames as f64;
        self.last
            .copy_from_slice(&input[(frames - 1) * ch..frames * ch]);
    }
}

/// Streaming multichannel FIR filter (interleaved I/O).
struct Fir {
    taps: Vec<f32>,
    channels: usize,
    /// Per-channel history of the last `taps.len() - 1` input samples.
    history: Vec<Vec<f32>>,
}

impl Fir {
    /// Blackman-windowed sinc low-pass, unity DC gain. `cutoff` in cycles/sample (0..0.5).
    fn lowpass(cutoff: f64, n: usize, channels: usize) -> Self {
        let m = (n - 1) as f64;
        let mut taps: Vec<f64> = (0..n)
            .map(|i| {
                let x = i as f64 - m / 2.0;
                let sinc = if x == 0.0 {
                    2.0 * cutoff
                } else {
                    (2.0 * std::f64::consts::PI * cutoff * x).sin() / (std::f64::consts::PI * x)
                };
                let w = 0.42 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / m).cos()
                    + 0.08 * (4.0 * std::f64::consts::PI * i as f64 / m).cos();
                sinc * w
            })
            .collect();
        let sum: f64 = taps.iter().sum();
        for t in &mut taps {
            *t /= sum;
        }
        Self {
            taps: taps.into_iter().map(|t| t as f32).collect(),
            channels,
            history: vec![vec![0.0; n - 1]; channels],
        }
    }

    fn process(&mut self, input: &[f32]) -> Vec<f32> {
        let ch = self.channels;
        let frames = input.len() / ch;
        let n = self.taps.len();
        let mut out = vec![0.0; frames * ch];
        for c in 0..ch {
            let hist = &mut self.history[c];
            let mut ext = Vec::with_capacity(hist.len() + frames);
            ext.extend_from_slice(hist);
            ext.extend((0..frames).map(|f| input[f * ch + c]));
            for f in 0..frames {
                // Taps are symmetric, so correlation == convolution.
                let acc: f32 = ext[f..f + n]
                    .iter()
                    .zip(&self.taps)
                    .map(|(x, t)| x * t)
                    .sum();
                out[f * ch + c] = acc;
            }
            hist.clear();
            hist.extend_from_slice(&ext[ext.len() - (n - 1)..]);
        }
        out
    }
}

// ---------------------------------------------------------------------------------------------
// Clock-drift compensation
// ---------------------------------------------------------------------------------------------

/// Normal bound of the drift correction (±0.5 % ≈ ±9 cents of pitch: inaudible on speech, and
/// ~15x the worst real-world crystal error of a few hundred ppm).
pub const MAX_RATE_ADJUST: f64 = 0.005;
/// Bound used only while the backlog is far above/below target (`CATCH_UP_ERROR`), so a
/// pathological backlog drains in seconds instead of minutes, without cutting audio.
pub const MAX_RATE_ADJUST_CATCH_UP: f64 = 0.02;
/// Absolute safety clamp applied by the resampler.
pub const MAX_RATE_ADJUST_HARD: f64 = 0.05;
/// Fill error (seconds) beyond which the catch-up bound applies.
const CATCH_UP_ERROR: f64 = 0.25;
/// Time constant (s) of the fill-level smoothing: the raw fill is a sawtooth (device bursts vs
/// mixer ticks); the controller should only see its mean.
const FILL_SMOOTHING_TAU: f64 = 1.0;
/// PI gains for the loop `d(error)/dt = drift - adjust` (error in seconds of buffered audio):
/// natural frequency 0.1 rad/s, damping ~0.7 → settles in about a minute without oscillating.
const DRIFT_KP: f64 = 0.14;
const DRIFT_KI: f64 = 0.01;
/// Error (s) up to which the integrator runs at (nearly) full weight.
const INTEGRATE_FULL_ERROR: f64 = 0.004;
/// After (re)priming, the controller runs proportional-only for this long (s): about 1.4
/// P-time-constants, so the priming step has mostly decayed before the integrator sees it.
/// Short sounds after silence therefore never touch the drift estimate.
const SETTLE_SECS: f64 = 10.0;

/// PI controller that keeps a jitter buffer's fill at `target` by nudging the producer's
/// resampling ratio. The mixer is paced by the wall clock while each device runs on its own
/// crystal; without this a +100 ppm device grows the backlog by ~0.36 s/hour (until the hard
/// cap cuts it) and a -100 ppm one periodically runs dry (silence re-primes → clicks).
#[derive(Debug, Clone)]
pub struct DriftController {
    target: f64,
    smoothed: Option<f64>,
    /// ∫ error dt, bounded so the integral term alone never exceeds `MAX_RATE_ADJUST`.
    integral: f64,
    adjust: f64,
}

impl DriftController {
    pub fn new(target_secs: f64) -> Self {
        Self {
            target: target_secs,
            smoothed: None,
            integral: 0.0,
            adjust: 0.0,
        }
    }

    /// Feed one observation of the buffer fill (seconds), taken `dt` seconds after the previous
    /// one. `integrate` = false runs proportional-only (used while the fill is still settling
    /// after a (re)prime, whose step is a disturbance, not drift). Returns the new ratio
    /// adjustment (see `Resampler::set_rate_adjust`).
    pub fn update(&mut self, fill_secs: f64, dt: f64, integrate: bool) -> f64 {
        if !(fill_secs.is_finite() && dt.is_finite() && dt > 0.0) {
            return self.adjust;
        }
        let dt = dt.min(1.0); // a stall must not dump a huge step into the integrator
        let smoothed = match self.smoothed {
            None => fill_secs,
            Some(prev) => prev + (fill_secs - prev) * (1.0 - (-dt / FILL_SMOOTHING_TAU).exp()),
        };
        self.smoothed = Some(smoothed);
        let error = smoothed - self.target;
        // Integrate small errors fully but large ones only weakly: real clock drift shows up
        // as a small, persistent error (P alone holds it at drift/KP ≈ 2 ms for 300 ppm), while
        // big ones are transients (re-prime overshoot after a silence gap, a stall) that would
        // otherwise wind the drift estimate off. The P term still corrects those quickly.
        let weight = if integrate {
            1.0 / (1.0 + (error / INTEGRATE_FULL_ERROR).powi(2))
        } else {
            0.0
        };
        let i_bound = MAX_RATE_ADJUST / DRIFT_KI;
        self.integral = (self.integral + error * dt * weight).clamp(-i_bound, i_bound);
        let bound = if error.abs() > CATCH_UP_ERROR {
            MAX_RATE_ADJUST_CATCH_UP
        } else {
            MAX_RATE_ADJUST
        };
        self.adjust = (DRIFT_KP * error + DRIFT_KI * self.integral).clamp(-bound, bound);
        self.adjust
    }

    pub fn adjust(&self) -> f64 {
        self.adjust
    }

    /// The learned clock offset (integral term): device rate relative to the wall clock,
    /// as a fraction (1e-4 = +100 ppm).
    pub fn drift_estimate(&self) -> f64 {
        DRIFT_KI * self.integral
    }

    /// Forget everything (a new device has a different clock).
    pub fn reset(&mut self) {
        *self = Self::new(self.target);
    }
}

// ---------------------------------------------------------------------------------------------
// Jitter buffer (capture thread → mixer)
// ---------------------------------------------------------------------------------------------

/// Counters for diagnostics and tests.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct JitterStats {
    /// Pulls that ran dry while flowing (→ silence + re-prime).
    pub underruns: u64,
    /// Samples discarded by the hard cap.
    pub dropped_samples: u64,
}

/// Bounded FIFO between a capture thread (pushes device-paced bursts) and the wall-clock mixer
/// (pulls exactly what real time demands).
///
/// - Priming: at start and after running dry (loopback goes quiet when nothing plays) the mixer
///   gets silence until `prime` samples are queued, so bursts arriving just after a mixer tick
///   don't cause repeated tiny gaps. Priming fills straight to the drift target.
/// - Drift: while flowing, every pull feeds the fill level to a `DriftController`; the producer
///   applies `rate_adjust()` to its resampler, which keeps the fill near target with no drops.
///   The controller is frozen while the buffer is dry, so silence gaps don't wind it up.
/// - Bounded (last resort): if the backlog still exceeds `cap`, only the oldest excess is
///   dropped — never a big cut — and the controller's catch-up range drains the rest.
pub struct JitterBuffer {
    q: VecDeque<f32>,
    channels: usize,
    rate: f64,
    prime: usize,
    cap: usize,
    primed: bool,
    /// Seconds of audio delivered since the last (re)prime.
    flowing_secs: f64,
    drift: DriftController,
    stats: JitterStats,
}

impl JitterBuffer {
    /// `target_frames` (= priming level and drift target) and `cap_frames` are in frames at
    /// `rate`; internally tracked in samples.
    pub fn new(channels: usize, rate: u32, target_frames: usize, cap_frames: usize) -> Self {
        let channels = channels.max(1);
        let rate = rate.max(1) as f64;
        // Prime a bit below target: priming completes on the first pull that finds at least
        // `prime` queued, i.e. typically part-way into a device burst, so the mean fill that
        // follows lands near target instead of one half-burst above it (which would read as
        // drift after every silence gap).
        let prime = (target_frames - target_frames / 8).max(1) * channels;
        let cap = (cap_frames * channels).max(prime + channels);
        Self {
            q: VecDeque::with_capacity(cap),
            channels,
            rate,
            prime,
            cap,
            primed: false,
            flowing_secs: 0.0,
            drift: DriftController::new(target_frames as f64 / rate),
            stats: JitterStats::default(),
        }
    }

    pub fn push(&mut self, samples: &[f32]) {
        // Only whole frames, so channel alignment can never slip.
        let whole = samples.len() - samples.len() % self.channels;
        self.q.extend(&samples[..whole]);
        if self.q.len() > self.cap {
            // Both lengths are whole frames, so the cut stays frame-aligned.
            let excess = self.q.len() - self.cap;
            self.q.drain(..excess);
            self.stats.dropped_samples += excess as u64;
        }
    }

    /// Fill `out` with queued samples, zero-padding what's missing. Returns how many real
    /// (non-padded) samples were delivered.
    pub fn pull(&mut self, out: &mut [f32]) -> usize {
        if !self.primed && self.q.len() >= self.prime.max(1) {
            self.primed = true;
            self.flowing_secs = 0.0;
        }
        let mut n = 0;
        if self.primed {
            if self.q.len() >= out.len() {
                let samples_per_sec = self.rate * self.channels as f64;
                let dt = out.len() as f64 / samples_per_sec;
                self.flowing_secs += dt;
                self.drift.update(
                    self.q.len() as f64 / samples_per_sec,
                    dt,
                    self.flowing_secs > SETTLE_SECS,
                );
            }
            n = out.len().min(self.q.len());
            for (o, s) in out[..n].iter_mut().zip(self.q.drain(..n)) {
                *o = s;
            }
            if n < out.len() {
                self.primed = false; // ran dry → rebuild the cushion before resuming
                self.stats.underruns += 1;
            }
        }
        out[n..].fill(0.0);
        n
    }

    /// Ratio adjustment the producer should apply to its resampler.
    pub fn rate_adjust(&self) -> f64 {
        self.drift.adjust()
    }

    /// See `DriftController::drift_estimate`.
    pub fn drift_estimate(&self) -> f64 {
        self.drift.drift_estimate()
    }

    /// Call when the producer switches device (different clock).
    pub fn reset_drift(&mut self) {
        self.drift.reset();
    }

    pub fn stats(&self) -> JitterStats {
        self.stats
    }

    /// Queued frames.
    #[cfg(test)]
    pub fn frames(&self) -> usize {
        self.q.len() / self.channels
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.q.len()
    }
}

// ---------------------------------------------------------------------------------------------
// Mixing, limiting, metering
// ---------------------------------------------------------------------------------------------

/// Soft limiter: linear (transparent) up to ±0.8, then a smooth tanh knee that asymptotes
/// to ±1.0 so the mixed signal never hard-clips. Mirrors the Linux pipeline's `alimiter`.
pub fn soft_limit(x: f32) -> f32 {
    const T: f32 = 0.8;
    let a = x.abs();
    if a <= T {
        x
    } else {
        let over = (a - T) / (1.0 - T);
        x.signum() * (T + (1.0 - T) * over.tanh())
    }
}

/// Map RMS amplitude (linear, full scale = 1.0) to a perceptual 0..1 level:
/// dBFS = 20·log10(rms), then -60 dBFS → 0 and 0 dBFS → 1 linearly (clamped).
/// Reference points: full-scale sine (-3 dBFS) ≈ 0.95, normal speech (~-30 dBFS) ≈ 0.5,
/// room noise floor (~-60 dBFS) ≈ 0. A linear RMS scale would leave speech barely visible.
pub fn rms_to_level(rms: f32) -> f32 {
    const FLOOR_DB: f32 = -60.0;
    if rms.is_nan() || rms <= 0.0 {
        return 0.0;
    }
    let db = 20.0 * rms.log10();
    ((db - FLOOR_DB) / -FLOOR_DB).clamp(0.0, 1.0)
}

/// Accumulates sum of squares over a window; `take()` returns the mapped level and resets.
#[derive(Default)]
pub struct LevelMeter {
    sum_sq: f64,
    count: u64,
}

impl LevelMeter {
    #[inline]
    pub fn add(&mut self, s: f32) {
        self.sum_sq += (s as f64) * (s as f64);
        self.count += 1;
    }

    pub fn take(&mut self) -> f32 {
        let rms = if self.count == 0 {
            0.0
        } else {
            (self.sum_sq / self.count as f64).sqrt()
        };
        *self = Self::default();
        rms_to_level(rms as f32)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct MixGains {
    pub sys_muted: bool,
    pub mic_muted: bool,
    pub mic_volume: f32,
}

/// Mix equally sized system + mic blocks (already at the output format) into 16-bit PCM.
/// Mute zeroes a source's contribution; meters see the post-mute, post-gain signal — i.e.
/// what is actually being recorded.
pub fn mix_block(
    sys: &[f32],
    mic: &[f32],
    g: MixGains,
    sys_meter: &mut LevelMeter,
    mic_meter: &mut LevelMeter,
    out: &mut Vec<i16>,
) {
    debug_assert_eq!(sys.len(), mic.len());
    out.reserve(sys.len());
    for (&s, &m) in sys.iter().zip(mic) {
        let s = if g.sys_muted { 0.0 } else { s };
        let m = if g.mic_muted { 0.0 } else { m * g.mic_volume };
        sys_meter.add(s);
        mic_meter.add(m);
        // Soft-limit the sum: system + (boosted) mic can exceed 1.0 and hard-clip ("estourado").
        out.push((soft_limit(s + m) * 32_767.0).clamp(-32_768.0, 32_767.0) as i16);
    }
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f32, b: f32, eps: f32) -> bool {
        (a - b).abs() <= eps
    }

    // --- decoding ---

    #[test]
    fn decodes_f32() {
        let mut bytes = Vec::new();
        for v in [0.5f32, -0.25, 1.0] {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        let mut out = Vec::new();
        decode_samples(&bytes, SampleEncoding::F32, &mut out);
        assert_eq!(out, vec![0.5, -0.25, 1.0]);
    }

    #[test]
    fn decodes_i16_and_ignores_partial_sample() {
        let mut bytes = Vec::new();
        for v in [16_384i16, -32_768, 0] {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        bytes.push(0x7f); // dangling half-sample
        let mut out = Vec::new();
        decode_samples(&bytes, SampleEncoding::I16, &mut out);
        assert_eq!(out, vec![0.5, -1.0, 0.0]);
    }

    #[test]
    fn decodes_i24_with_sign() {
        // 0x400000 = +0.5, 0xC00000 = -0.5 (24-bit two's complement)
        let bytes = [0x00, 0x00, 0x40, 0x00, 0x00, 0xC0];
        let mut out = Vec::new();
        decode_samples(&bytes, SampleEncoding::I24, &mut out);
        assert!(
            approx(out[0], 0.5, 1e-6) && approx(out[1], -0.5, 1e-6),
            "{out:?}"
        );
    }

    #[test]
    fn decodes_i32_and_sanitizes_nan() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&(i32::MIN / 2).to_le_bytes());
        let mut out = Vec::new();
        decode_samples(&bytes, SampleEncoding::I32, &mut out);
        assert!(approx(out[0], -0.5, 1e-6));

        let mut out = Vec::new();
        decode_samples(&f32::NAN.to_le_bytes(), SampleEncoding::F32, &mut out);
        assert_eq!(out, vec![0.0]);
    }

    #[test]
    fn encoding_from_format() {
        assert_eq!(SampleEncoding::from_format(true, 32), SampleEncoding::F32);
        assert_eq!(SampleEncoding::from_format(false, 16), SampleEncoding::I16);
        assert_eq!(SampleEncoding::from_format(false, 24), SampleEncoding::I24);
        assert_eq!(SampleEncoding::from_format(false, 32), SampleEncoding::I32);
        let u = SampleEncoding::from_format(true, 64);
        assert_eq!(u, SampleEncoding::Unsupported { bytes: 8 });
        let mut out = Vec::new();
        decode_samples(&[1u8; 16], u, &mut out);
        assert_eq!(out, vec![0.0, 0.0]);
    }

    // --- channel mapping ---

    #[test]
    fn stereo_to_mono_averages() {
        let mut out = Vec::new();
        map_channels(&[1.0, 0.0, 0.5, 0.5, -1.0, 1.0], 2, 1, &mut out);
        assert_eq!(out, vec![0.5, 0.5, 0.0]);
    }

    #[test]
    fn mono_to_stereo_duplicates() {
        let mut out = Vec::new();
        map_channels(&[0.1, 0.2], 1, 2, &mut out);
        assert_eq!(out, vec![0.1, 0.1, 0.2, 0.2]);
    }

    #[test]
    fn surround_to_stereo_keeps_front_pair_and_identity_passes() {
        let mut out = Vec::new();
        map_channels(&[0.1, 0.2, 0.3, 0.4, 0.5, 0.6], 6, 2, &mut out);
        assert_eq!(out, vec![0.1, 0.2]);
        let mut out = Vec::new();
        map_channels(&[0.1, 0.2, 0.3, 0.4], 2, 2, &mut out);
        assert_eq!(out, vec![0.1, 0.2, 0.3, 0.4]);
        let mut out = Vec::new();
        map_channels(&[0.3, 0.6, 0.9, 0.0, 0.0, 0.0], 6, 1, &mut out);
        assert!(approx(out[0], 0.3, 1e-6));
    }

    // --- resampling ---

    #[test]
    fn same_rate_is_passthrough() {
        let mut r = Resampler::new(48_000, 48_000, 2);
        let mut out = Vec::new();
        r.process(&[0.1, 0.2, 0.3, 0.4], &mut out);
        assert_eq!(out, vec![0.1, 0.2, 0.3, 0.4]);
    }

    #[test]
    fn output_length_tracks_rate_ratio() {
        for (inr, outr) in [
            (48_000, 16_000),
            (44_100, 16_000),
            (16_000, 48_000),
            (44_100, 48_000),
        ] {
            let mut r = Resampler::new(inr, outr, 1);
            let mut out = Vec::new();
            // 1 second fed in 10 ms-ish odd-sized buffers.
            let input = vec![0.0f32; inr as usize];
            for chunk in input.chunks(437) {
                r.process(chunk, &mut out);
            }
            let diff = (out.len() as i64 - outr as i64).abs();
            assert!(diff <= 2, "{inr}->{outr}: got {} frames", out.len());
        }
    }

    #[test]
    fn upsampling_interpolates_linearly() {
        // 1:2 ratio → every other output sample is a midpoint.
        let mut r = Resampler::new(8_000, 16_000, 1);
        let mut out = Vec::new();
        r.process(&[0.0, 1.0, 0.0, 1.0], &mut out);
        // One frame of look-behind is retained, so the last input isn't emitted yet.
        assert_eq!(out, vec![0.0, 0.5, 1.0, 0.5, 0.0, 0.5]);
    }

    #[test]
    fn split_buffers_match_single_buffer() {
        let input: Vec<f32> = (0..4_800)
            .map(|i| (i as f32 * 0.013).sin() * 0.8 + (i as f32 * 0.21).cos() * 0.1)
            .collect();
        let stereo: Vec<f32> = input.iter().flat_map(|&v| [v, -v]).collect();
        for (inr, outr) in [(48_000, 16_000), (16_000, 44_100)] {
            let mut a = Resampler::new(inr, outr, 2);
            let mut whole = Vec::new();
            a.process(&stereo, &mut whole);

            let mut b = Resampler::new(inr, outr, 2);
            let mut parts = Vec::new();
            for chunk in stereo.chunks(2 * 97) {
                b.process(chunk, &mut parts);
            }
            assert_eq!(whole.len(), parts.len());
            for (x, y) in whole.iter().zip(&parts) {
                assert!(approx(*x, *y, 1e-5), "{x} vs {y}");
            }
        }
    }

    #[test]
    fn downsampling_preserves_dc_and_low_tones() {
        let mut r = Resampler::new(48_000, 16_000, 1);
        let mut out = Vec::new();
        r.process(&vec![0.5f32; 4_800], &mut out);
        // Skip the FIR warm-up; the rest must settle at the DC value.
        for v in &out[40..] {
            assert!(approx(*v, 0.5, 1e-3), "{v}");
        }

        let tone: Vec<f32> = (0..48_000)
            .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 48_000.0).sin())
            .collect();
        let mut r = Resampler::new(48_000, 16_000, 1);
        let mut out = Vec::new();
        r.process(&tone, &mut out);
        let rms = (out[100..].iter().map(|v| v * v).sum::<f32>() / (out.len() - 100) as f32).sqrt();
        assert!(
            approx(rms, std::f32::consts::FRAC_1_SQRT_2, 0.02),
            "440 Hz rms {rms}"
        );
    }

    #[test]
    fn downsampling_attenuates_content_above_new_nyquist() {
        // 12 kHz tone at 48 kHz would alias to 4 kHz at 16 kHz without the low-pass.
        let tone: Vec<f32> = (0..48_000)
            .map(|i| (2.0 * std::f32::consts::PI * 12_000.0 * i as f32 / 48_000.0 + 0.3).sin())
            .collect();
        let mut r = Resampler::new(48_000, 16_000, 1);
        let mut out = Vec::new();
        r.process(&tone, &mut out);
        let rms = (out[100..].iter().map(|v| v * v).sum::<f32>() / (out.len() - 100) as f32).sqrt();
        assert!(rms < 0.05, "aliased energy too high: {rms}");
    }

    // --- jitter buffer ---

    #[test]
    fn jitter_buffer_waits_for_prime_then_flows() {
        let mut jb = JitterBuffer::new(1, 1_000, 4, 100);
        jb.push(&[1.0, 2.0]);
        let mut out = [9.0; 2];
        assert_eq!(jb.pull(&mut out), 0);
        assert_eq!(out, [0.0, 0.0]); // not primed yet → silence, data retained
        jb.push(&[3.0, 4.0]);
        assert_eq!(jb.pull(&mut out), 2);
        assert_eq!(out, [1.0, 2.0]);
        assert_eq!(jb.pull(&mut out), 2);
        assert_eq!(out, [3.0, 4.0]);
    }

    #[test]
    fn jitter_buffer_pads_underrun_and_reprimes() {
        let mut jb = JitterBuffer::new(1, 1_000, 2, 100);
        jb.push(&[1.0, 2.0, 3.0]);
        let mut out = [9.0; 4];
        assert_eq!(jb.pull(&mut out), 3);
        assert_eq!(out, [1.0, 2.0, 3.0, 0.0]);
        jb.push(&[5.0]); // below prime again → silence
        let mut out = [9.0; 1];
        assert_eq!(jb.pull(&mut out), 0);
        assert_eq!(out, [0.0]);
        jb.push(&[6.0]);
        assert_eq!(jb.pull(&mut out), 1);
        assert_eq!(out, [5.0]);
    }

    #[test]
    fn jitter_buffer_is_bounded_and_trims_only_the_oldest_excess() {
        let mut jb = JitterBuffer::new(2, 1_000, 2, 5);
        let data: Vec<f32> = (0..24).map(|i| i as f32).collect();
        jb.push(&data);
        // Cap = 5 frames × 2 ch: only the 7 oldest frames are dropped, not a cut to prime.
        assert_eq!(jb.len(), 10);
        assert_eq!(jb.frames(), 5);
        assert_eq!(jb.stats().dropped_samples, 14);
        let mut out = [0.0; 4];
        jb.pull(&mut out);
        assert_eq!(out, [14.0, 15.0, 16.0, 17.0]); // frame-aligned, newest kept in order
    }

    #[test]
    fn jitter_buffer_drops_partial_frames() {
        let mut jb = JitterBuffer::new(2, 1_000, 1, 10);
        jb.push(&[1.0, 2.0, 3.0]);
        assert_eq!(jb.len(), 2);
    }

    #[test]
    fn jitter_buffer_counts_underruns_and_freezes_drift_while_dry() {
        let mut jb = JitterBuffer::new(1, 1_000, 4, 100);
        jb.push(&[0.1; 8]);
        let mut out = [0.0; 4];
        jb.pull(&mut out);
        let adj = jb.rate_adjust();
        jb.pull(&mut out);
        jb.pull(&mut out); // dry → underrun, controller not updated
        assert_eq!(jb.stats().underruns, 1);
        for _ in 0..100 {
            jb.pull(&mut out); // still dry (not primed): no updates
        }
        assert_eq!(jb.stats().underruns, 1);
        assert!(jb.rate_adjust().abs() <= adj.abs() + 1e-3);
        jb.reset_drift();
        assert_eq!(jb.rate_adjust(), 0.0);
    }

    // --- drift compensation ---

    #[test]
    fn drift_controller_reacts_in_the_right_direction_and_is_bounded() {
        let mut c = DriftController::new(0.08);
        // Fill persistently high → consume faster (positive adjust), bounded.
        for _ in 0..10_000 {
            c.update(0.12, 0.01, true);
        }
        assert!(c.adjust() > 0.0 && c.adjust() <= MAX_RATE_ADJUST + 1e-12);
        c.reset();
        for _ in 0..10_000 {
            c.update(0.04, 0.01, true);
        }
        assert!(c.adjust() < 0.0 && c.adjust() >= -MAX_RATE_ADJUST - 1e-12);
        // Far above target → catch-up range, still bounded.
        c.reset();
        for _ in 0..10_000 {
            c.update(0.9, 0.01, true);
        }
        assert!(c.adjust() > MAX_RATE_ADJUST && c.adjust() <= MAX_RATE_ADJUST_CATCH_UP);
        // Garbage input is ignored.
        let before = c.adjust();
        assert_eq!(c.update(f64::NAN, 0.01, true), before);
        assert_eq!(c.update(0.08, 0.0, true), before);
        // Proportional-only mode never winds the integrator.
        c.reset();
        for _ in 0..10_000 {
            c.update(0.10, 0.01, false);
        }
        let p_only = c.adjust();
        c.update(0.08, 0.01, false);
        assert!(p_only > 0.0 && c.adjust().abs() < p_only);
    }

    #[test]
    fn resampler_rate_adjust_changes_output_rate_and_is_seamless() {
        // Same rate: passthrough until adjusted, then interpolating with no jump at the switch.
        let mut r = Resampler::new(8_000, 8_000, 1);
        let ramp: Vec<f32> = (0..8_000).map(|i| i as f32 / 8_000.0).collect();
        let mut out = Vec::new();
        r.process(&ramp[..4_000], &mut out);
        assert_eq!(out.len(), 4_000);
        r.set_rate_adjust(0.01);
        r.process(&ramp[4_000..], &mut out);
        for w in out.windows(2) {
            let d = w[1] - w[0];
            assert!(d > 0.0 && d < 2.0 / 8_000.0, "discontinuity {d}");
        }
        // +1 % consumes input 1 % faster → ~1 % fewer output frames.
        let mut r = Resampler::new(48_000, 16_000, 1);
        r.set_rate_adjust(0.01);
        let mut out = Vec::new();
        r.process(&vec![0.0; 48_000], &mut out);
        let expected = 16_000.0 / 1.01;
        assert!((out.len() as f64 - expected).abs() < 3.0, "{}", out.len());
        // Non-finite resets to nominal; out-of-range is clamped.
        r.set_rate_adjust(f64::NAN);
        r.set_rate_adjust(10.0);
        let mut out = Vec::new();
        r.process(&vec![0.0; 48_000], &mut out);
        let expected = 16_000.0 / (1.0 + MAX_RATE_ADJUST_HARD);
        assert!((out.len() as f64 - expected).abs() < 3.0, "{}", out.len());
    }

    struct SimResult {
        /// Underruns / dropped samples after the convergence period.
        underruns: u64,
        dropped: u64,
        /// Pre-pull fill range (ms) after convergence, outside silence gaps.
        min_fill_ms: f64,
        max_fill_ms: f64,
        /// Mean rate adjustment over the last 5 simulated minutes (while flowing).
        tail_adjust: f64,
        /// Learned drift (integral term) at the end.
        estimate: f64,
    }

    /// Simulate a capture thread whose device clock runs `ppm` off the wall clock, feeding a
    /// wall-clock mixer through Resampler → JitterBuffer, exactly like source.rs/engine.rs:
    /// device bursts every 6..14 ms (jittered), mixer pulls 10 ms per tick. With `gaps`, the
    /// device delivers nothing for 5 s out of every 30 s (loopback while nothing plays).
    fn simulate(ppm: f64, minutes: u64, compensate: bool, gaps: bool) -> SimResult {
        const RATE: u32 = 8_000;
        const SETTLE_MS: u64 = 90_000;
        let target = RATE as usize * 80 / 1_000; // same 80 ms target as source.rs
        let mut jb = JitterBuffer::new(1, RATE, target, RATE as usize);
        let mut rs = Resampler::new(RATE, RATE, 1);
        let device_rate = RATE as f64 * (1.0 + ppm * 1e-6);
        let total_ms = minutes * 60_000;
        let tail_from = total_ms.saturating_sub(5 * 60_000);
        let (mut produced, mut seed, mut next_delivery) = (0u64, 0x1234_5678u32, 10u64);
        let (mut input, mut resampled) = (Vec::new(), Vec::new());
        let mut out = vec![0.0f32; RATE as usize / 100];
        let mut base = JitterStats::default();
        let (mut min_fill, mut max_fill) = (f64::MAX, 0.0f64);
        let (mut adj_sum, mut adj_n) = (0.0, 0u64);
        let in_gap = |ms: u64| gaps && ms % 30_000 >= 25_000;
        for ms in 1..=total_ms {
            if ms >= next_delivery {
                let due = (ms as f64 / 1_000.0 * device_rate) as u64;
                let n = (due - produced) as usize;
                produced = due;
                if !in_gap(ms) {
                    input.clear();
                    input.resize(n, 0.1);
                    resampled.clear();
                    rs.process(&input, &mut resampled);
                    jb.push(&resampled);
                    if compensate {
                        rs.set_rate_adjust(jb.rate_adjust());
                    }
                }
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                next_delivery = ms + 6 + u64::from(seed >> 16) % 9;
            }
            if ms % 10 == 0 {
                let fill_ms = jb.frames() as f64 * 1_000.0 / RATE as f64;
                jb.pull(&mut out);
                if ms == SETTLE_MS {
                    base = jb.stats();
                }
                // Skip the gap and the second after it (draining / re-priming is expected).
                if ms > SETTLE_MS && !in_gap(ms) && !in_gap(ms.saturating_sub(1_000)) {
                    min_fill = min_fill.min(fill_ms);
                    max_fill = max_fill.max(fill_ms);
                }
                if ms > tail_from && !in_gap(ms) && !in_gap(ms.saturating_sub(1_000)) {
                    adj_sum += jb.rate_adjust();
                    adj_n += 1;
                }
            }
        }
        let end = jb.stats();
        SimResult {
            underruns: end.underruns - base.underruns,
            dropped: end.dropped_samples - base.dropped_samples,
            min_fill_ms: min_fill,
            max_fill_ms: max_fill,
            tail_adjust: adj_sum / adj_n.max(1) as f64,
            estimate: jb.drift_estimate(),
        }
    }

    #[test]
    fn drift_compensation_holds_fill_for_fast_and_slow_device_clocks() {
        for ppm in [100.0, -100.0, 300.0, -300.0] {
            let r = simulate(ppm, 30, true, false);
            assert_eq!(r.underruns, 0, "{ppm} ppm: underruns after convergence");
            assert_eq!(r.dropped, 0, "{ppm} ppm: drops after convergence");
            assert!(
                r.min_fill_ms > 50.0 && r.max_fill_ms < 110.0,
                "{ppm} ppm: fill {:.1}..{:.1} ms",
                r.min_fill_ms,
                r.max_fill_ms
            );
            let (mean, est) = (r.tail_adjust * 1e6, r.estimate * 1e6);
            assert!((mean - ppm).abs() < 30.0, "{ppm} ppm: mean adjust {mean:.1} ppm");
            assert!((est - ppm).abs() < 30.0, "{ppm} ppm: estimated {est:.1} ppm");
        }
    }

    #[test]
    fn without_compensation_the_same_drift_misbehaves() {
        // Sanity check that the simulation actually exercises drift.
        let slow = simulate(-100.0, 30, false, false);
        assert!(slow.underruns > 0, "slow clock should run dry");
        let fast = simulate(100.0, 30, false, false);
        assert!(fast.max_fill_ms > 200.0, "fast clock backlog {}", fast.max_fill_ms);
    }

    #[test]
    fn drift_compensation_survives_silence_gaps() {
        let r = simulate(150.0, 20, true, true);
        assert_eq!(r.dropped, 0);
        // Exactly one underrun per gap (the source genuinely went quiet), none in between.
        let gaps_after_settle = (20 * 60 - 90) / 30;
        assert!(
            r.underruns <= gaps_after_settle + 1,
            "{} underruns for {gaps_after_settle} gaps",
            r.underruns
        );
        assert!(r.min_fill_ms > 40.0 && r.max_fill_ms < 120.0, "{:.1}..{:.1}", r.min_fill_ms, r.max_fill_ms);
        // The learned drift must have the right sign and magnitude. It converges more loosely
        // than without gaps (re-prime transients leave a small bias of a few tens of ppm, i.e.
        // < 0.01 % — irrelevant; what matters is no drops and a bounded fill, asserted above).
        let est = r.estimate * 1e6;
        assert!(est > 50.0 && est < 300.0, "estimated {est:.1} ppm");
    }

    // --- limiter / levels / mixing ---

    #[test]
    fn soft_limit_is_transparent_below_knee_and_bounded() {
        assert_eq!(soft_limit(0.5), 0.5);
        assert_eq!(soft_limit(-0.8), -0.8);
        for x in [0.81f32, 1.0, 2.0, 10.0, 1e6] {
            let y = soft_limit(x);
            assert!(y > 0.8 && y <= 1.0, "{x} -> {y}");
            assert_eq!(soft_limit(-x), -y);
        }
        // Monotonic through the knee.
        assert!(soft_limit(0.9) < soft_limit(0.95));
    }

    #[test]
    fn level_mapping_is_db_scaled() {
        assert_eq!(rms_to_level(0.0), 0.0);
        assert_eq!(rms_to_level(f32::NAN), 0.0);
        assert!(approx(rms_to_level(1.0), 1.0, 1e-6));
        assert!(approx(rms_to_level(0.001), 0.0, 1e-6)); // -60 dBFS
        assert!(approx(rms_to_level(10f32.powf(-30.0 / 20.0)), 0.5, 1e-4)); // -30 dBFS
        assert_eq!(rms_to_level(1e-5), 0.0);
        assert_eq!(rms_to_level(4.0), 1.0);
    }

    #[test]
    fn meter_resets_after_take() {
        let mut m = LevelMeter::default();
        for _ in 0..100 {
            m.add(1.0);
            m.add(-1.0);
        }
        assert!(approx(m.take(), 1.0, 1e-6));
        assert_eq!(m.take(), 0.0);
    }

    #[test]
    fn mix_applies_mute_volume_and_meters_post_mute() {
        let sys = [0.5f32; 64];
        let mic = [0.25f32; 64];
        let (mut ms, mut mm) = (LevelMeter::default(), LevelMeter::default());
        let mut out = Vec::new();
        let g = MixGains {
            sys_muted: false,
            mic_muted: false,
            mic_volume: 2.0,
        };
        mix_block(&sys, &mic, g, &mut ms, &mut mm, &mut out);
        // 0.5 + 0.25*2 = 1.0 → soft-limited below full scale, never wraps.
        assert!(out.iter().all(|&s| s > 26_000 && s < 32_767), "{}", out[0]);
        assert!(approx(ms.take(), rms_to_level(0.5), 1e-5));
        assert!(approx(mm.take(), rms_to_level(0.5), 1e-5));

        let mut out = Vec::new();
        let g = MixGains {
            sys_muted: true,
            mic_muted: false,
            mic_volume: 1.0,
        };
        mix_block(&sys, &mic, g, &mut ms, &mut mm, &mut out);
        assert!(out.iter().all(|&s| s == (0.25 * 32_767.0) as i16));
        assert_eq!(ms.take(), 0.0);
        assert!(mm.take() > 0.0);

        let mut out = Vec::new();
        let g = MixGains {
            sys_muted: true,
            mic_muted: true,
            mic_volume: 1.0,
        };
        mix_block(&sys, &mic, g, &mut ms, &mut mm, &mut out);
        assert!(out.iter().all(|&s| s == 0));
        assert_eq!((ms.take(), mm.take()), (0.0, 0.0));
    }

    #[test]
    fn mix_never_wraps_on_extreme_input() {
        let (mut ms, mut mm) = (LevelMeter::default(), LevelMeter::default());
        let mut out = Vec::new();
        let g = MixGains {
            sys_muted: false,
            mic_muted: false,
            mic_volume: 2.0,
        };
        mix_block(&[1.0, -1.0], &[1.0, -1.0], g, &mut ms, &mut mm, &mut out);
        assert!(out[0] > 30_000 && out[1] < -30_000);
    }
}
