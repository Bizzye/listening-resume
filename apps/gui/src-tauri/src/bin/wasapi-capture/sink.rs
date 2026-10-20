//! 16-bit PCM WAV chunk writer.

use crate::protocol;
use hound::{SampleFormat, WavSpec, WavWriter};
use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// How often an open chunk's header is rewritten, so a crash leaves a valid, playable file.
const HEADER_FLUSH: Duration = Duration::from_secs(1);

/// Writes chunks of exactly `chunk_frames` frames (the last one may be shorter), creating each
/// file lazily so stopping right at a boundary never leaves an empty chunk.
pub struct ChunkSink {
    dir: PathBuf,
    prefix: String,
    spec: WavSpec,
    chunk_frames: u64,
    index: u32,
    current: Option<OpenChunk>,
}

struct OpenChunk {
    writer: WavWriter<BufWriter<File>>,
    path: PathBuf,
    frames: u64,
    last_flush: Instant,
}

impl ChunkSink {
    pub fn new(
        dir: PathBuf,
        prefix: String,
        sample_rate: u32,
        channels: u16,
        chunk_seconds: f64,
    ) -> Self {
        Self {
            dir,
            prefix,
            spec: WavSpec {
                channels: channels.max(1),
                sample_rate,
                bits_per_sample: 16,
                sample_format: SampleFormat::Int,
            },
            chunk_frames: ((chunk_seconds * sample_rate as f64).round() as u64).max(1),
            index: 0,
            current: None,
        }
    }

    /// Number of chunks finalized so far.
    pub fn chunks_written(&self) -> u32 {
        self.index
    }

    /// Append interleaved samples (whole frames). `now` drives the periodic header flush;
    /// `on_chunk` is called with the path of every chunk finalized along the way.
    pub fn write(
        &mut self,
        pcm: &[i16],
        now: Instant,
        on_chunk: &mut dyn FnMut(&Path),
    ) -> Result<(), String> {
        let ch = self.spec.channels as usize;
        let mut rest = pcm;
        while !rest.is_empty() {
            if self.current.is_none() {
                let path = self
                    .dir
                    .join(protocol::chunk_file_name(&self.prefix, self.index));
                let writer = WavWriter::create(&path, self.spec)
                    .map_err(|e| format!("cannot create {}: {e}", path.display()))?;
                self.current = Some(OpenChunk {
                    writer,
                    path,
                    frames: 0,
                    last_flush: now,
                });
            }
            let Some(chunk) = self.current.as_mut() else {
                return Err("internal error: no open chunk".into());
            };
            let room = (self.chunk_frames.saturating_sub(chunk.frames) as usize) * ch;
            let (part, later) = rest.split_at(room.min(rest.len()));
            for &s in part {
                chunk
                    .writer
                    .write_sample(s)
                    .map_err(|e| format!("write failed: {e}"))?;
            }
            chunk.frames += (part.len() / ch) as u64;
            rest = later;
            if chunk.frames >= self.chunk_frames {
                self.finish_current(on_chunk)?;
            } else if now.saturating_duration_since(chunk.last_flush) >= HEADER_FLUSH {
                // hound's flush also rewrites the header sizes.
                chunk
                    .writer
                    .flush()
                    .map_err(|e| format!("flush failed: {e}"))?;
                chunk.last_flush = now;
            }
        }
        Ok(())
    }

    /// Finalize the open chunk, if any (no-op when nothing was written since the last one).
    pub fn finish_current(&mut self, on_chunk: &mut dyn FnMut(&Path)) -> Result<(), String> {
        if let Some(chunk) = self.current.take() {
            chunk
                .writer
                .finalize()
                .map_err(|e| format!("finalize failed: {e}"))?;
            on_chunk(&chunk.path);
            self.index += 1;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let dir = std::env::temp_dir().join(format!(
                "wasapi-capture-test-{tag}-{}-{nanos}",
                std::process::id()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn wavs(&self) -> Vec<PathBuf> {
            let mut v: Vec<PathBuf> = std::fs::read_dir(&self.0)
                .unwrap()
                .map(|e| e.unwrap().path())
                .collect();
            v.sort();
            v
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// (spec, frames per header, samples) of a WAV file.
    fn read(path: &Path) -> (WavSpec, u32, Vec<i16>) {
        let mut r = hound::WavReader::open(path).unwrap();
        let samples = r.samples::<i16>().map(|s| s.unwrap()).collect();
        (r.spec(), r.duration(), samples)
    }

    fn ramp(frames: usize, ch: usize, start: i16) -> Vec<i16> {
        (0..frames * ch)
            .map(|i| start.wrapping_add(i as i16))
            .collect()
    }

    #[test]
    fn rotates_exactly_at_chunk_boundaries_and_reports_each_chunk() {
        let tmp = TempDir::new("rotate");
        // 1000 Hz stereo, 0.5 s chunks = 500 frames.
        let mut sink = ChunkSink::new(tmp.0.clone(), "rec".into(), 1_000, 2, 0.5);
        let mut done = Vec::new();
        let t0 = Instant::now();
        let data = ramp(1_234, 2, 0);
        // Odd-sized writes straddle boundaries.
        for part in data.chunks(2 * 333) {
            sink.write(part, t0, &mut |p| done.push(p.to_path_buf()))
                .unwrap();
        }
        assert_eq!(done.len(), 2, "two full chunks finalized while writing");
        sink.finish_current(&mut |p| done.push(p.to_path_buf()))
            .unwrap();
        assert_eq!(sink.chunks_written(), 3);
        assert_eq!(done, tmp.wavs());
        assert!(done[0].ends_with("rec_0000.wav") && done[2].ends_with("rec_0002.wav"));

        let mut all = Vec::new();
        for (p, frames) in done.iter().zip([500u32, 500, 234]) {
            let (spec, dur, samples) = read(p);
            assert_eq!((spec.sample_rate, spec.channels, spec.bits_per_sample), (1_000, 2, 16));
            assert_eq!(dur, frames, "{}", p.display());
            all.extend(samples);
        }
        assert_eq!(all, data, "no sample lost or duplicated across rotations");
    }

    #[test]
    fn files_are_created_lazily() {
        let tmp = TempDir::new("lazy");
        let mut sink = ChunkSink::new(tmp.0.clone(), "c".into(), 1_000, 1, 0.1);
        let mut n = 0;
        // Nothing written → no file, and finishing is a no-op.
        sink.finish_current(&mut |_| n += 1).unwrap();
        assert!(tmp.wavs().is_empty());
        sink.write(&[], Instant::now(), &mut |_| n += 1).unwrap();
        assert!(tmp.wavs().is_empty());
        // Exactly one chunk → finalized at the boundary, next file not created yet.
        sink.write(&ramp(100, 1, 0), Instant::now(), &mut |_| n += 1)
            .unwrap();
        assert_eq!(n, 1);
        assert_eq!(tmp.wavs().len(), 1);
        sink.finish_current(&mut |_| n += 1).unwrap();
        assert_eq!((n, tmp.wavs().len(), sink.chunks_written()), (1, 1, 1));
    }

    #[test]
    fn header_is_flushed_every_second_while_open() {
        let tmp = TempDir::new("flush");
        let mut sink = ChunkSink::new(tmp.0.clone(), "c".into(), 1_000, 1, 60.0);
        let t0 = Instant::now();
        let mut nop = |_: &Path| {};
        sink.write(&ramp(300, 1, 0), t0, &mut nop).unwrap();
        sink.write(&ramp(200, 1, 0), t0 + Duration::from_millis(500), &mut nop)
            .unwrap();
        let path = tmp.wavs().remove(0);
        // Under a second: the header hasn't been rewritten yet (hound writes 0 at creation).
        let header_frames = |p: &Path| hound::WavReader::open(p).map(|r| r.duration()).unwrap_or(0);
        assert_eq!(header_frames(&path), 0);
        // Past one second since creation: header (and data) flushed, file readable as-is.
        sink.write(&ramp(100, 1, 0), t0 + Duration::from_millis(1_100), &mut nop)
            .unwrap();
        assert_eq!(header_frames(&path), 600);
        // The next flush is a second after the previous one, not after creation.
        sink.write(&ramp(50, 1, 0), t0 + Duration::from_millis(1_900), &mut nop)
            .unwrap();
        assert_eq!(header_frames(&path), 600);
        sink.write(&ramp(50, 1, 0), t0 + Duration::from_millis(2_200), &mut nop)
            .unwrap();
        assert_eq!(header_frames(&path), 700);
        let mut done = Vec::new();
        sink.finish_current(&mut |p| done.push(p.to_path_buf()))
            .unwrap();
        assert_eq!(read(&done[0]).1, 700);
    }
}
