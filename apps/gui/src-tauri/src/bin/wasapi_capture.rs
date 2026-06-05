//! WASAPI Loopback Audio Capture
//!
//! Captures system audio output via Windows WASAPI loopback mode and writes
//! WAV chunks to disk. No "Stereo Mix" or virtual audio cable required.
//!
//! Usage:
//!   wasapi-capture --output-dir <DIR> --prefix <PREFIX> --chunk-seconds <N>
//!                  [--sample-rate <RATE>] [--channels <CH>] [--device <NAME>]
//!
//! Protocol:
//!   - Prints "CHUNK:<path>" to stdout when a chunk is ready
//!   - Prints "DEVICES:<json>" when --list-devices is used
//!   - Reads stdin: "q\n" to stop gracefully

#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("wasapi-capture is only supported on Windows");
    std::process::exit(1);
}

#[cfg(target_os = "windows")]
fn main() {
    wasapi_main::run();
}

#[cfg(target_os = "windows")]
mod wasapi_main {
    use hound::{WavSpec, WavWriter};
    use std::collections::VecDeque;
    use std::env;
    use std::io::BufRead;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};
    use wasapi::*;

    pub fn run() {
        wasapi::initialize_mta().expect("Failed to initialize COM MTA");

        let args: Vec<String> = env::args().collect();

        if args.contains(&"--list-devices".to_string()) {
            list_devices();
            return;
        }

        if args.contains(&"--play-tone".to_string()) {
            // Render a short test tone to a specific output device. Used by the GUI's
            // "Test Sound" so it can target the selected device (SoundPlayer can only
            // reach the system default).
            play_tone(get_arg(&args, "--device").as_deref());
            return;
        }

        let output_dir = get_arg(&args, "--output-dir").expect("--output-dir required");
        let prefix = get_arg(&args, "--prefix").unwrap_or_else(|| "chunk".to_string());
        let chunk_seconds: u64 = get_arg(&args, "--chunk-seconds")
            .unwrap_or_else(|| "120".to_string())
            .parse()
            .expect("invalid --chunk-seconds");
        let device_name_filter = get_arg(&args, "--device");
        let mic_name_filter = get_arg(&args, "--mic");
        let mic_volume: f32 = get_arg(&args, "--mic-volume")
            .and_then(|v| v.parse().ok())
            .unwrap_or(1.2);

        let device = find_render_device(device_name_filter.as_deref());
        let dev_name = device.get_friendlyname().unwrap_or_else(|_| "Unknown".to_string());
        eprintln!("Capturing from: {} (loopback)", dev_name);

        let output_path = PathBuf::from(&output_dir);
        std::fs::create_dir_all(&output_path).expect("Failed to create output directory");

        let running = Arc::new(AtomicBool::new(true));
        let running_clone = running.clone();

        // Runtime mute flags toggled live via stdin commands (no chunk restart needed —
        // the mix loop reads them per frame). Muting zeroes that source's contribution.
        let mute_sys = Arc::new(AtomicBool::new(false));
        let mute_mic = Arc::new(AtomicBool::new(false));
        let mute_sys_cmd = mute_sys.clone();
        let mute_mic_cmd = mute_mic.clone();

        std::thread::spawn(move || {
            let stdin = std::io::stdin();
            for line in stdin.lock().lines() {
                if let Ok(cmd) = line {
                    match cmd.trim() {
                        "q" => {
                            running_clone.store(false, Ordering::SeqCst);
                            break;
                        }
                        "mute-sys" => mute_sys_cmd.store(true, Ordering::Relaxed),
                        "unmute-sys" => mute_sys_cmd.store(false, Ordering::Relaxed),
                        "mute-mic" => mute_mic_cmd.store(true, Ordering::Relaxed),
                        "unmute-mic" => mute_mic_cmd.store(false, Ordering::Relaxed),
                        _ => {}
                    }
                }
            }
            running_clone.store(false, Ordering::SeqCst);
        });

        // Optional microphone — captured on its own WASAPI stream in a background thread and
        // mixed into the loopback audio below. Mic failure must never break system capture.
        let mic_shared: Arc<Mutex<MicState>> = Arc::new(Mutex::new(MicState::default()));
        let mut mic_sr: u32 = 0;
        if let Some(mic_filter) = mic_name_filter.as_deref() {
            match start_mic_thread(mic_filter, running.clone(), mic_shared.clone()) {
                Ok(sr) => {
                    mic_sr = sr;
                    eprintln!("Mixing mic: {} ({} Hz, vol {})", mic_filter, sr, mic_volume);
                }
                Err(e) => {
                    eprintln!("Mic capture disabled ({}). Recording system audio only.", e)
                }
            }
        }
        let mic_enabled = mic_sr > 0;

        // Mic mixing state, persisted across chunks so the mic stream stays continuous.
        // `mic_local` holds drained mono samples; a fractional cursor resamples mic_sr → native_sr.
        let mut mic_local: VecDeque<f32> = VecDeque::new();
        let mut mic_cursor: f64 = 0.0;
        let mut mic_current: f32 = 0.0;

        let mut chunk_index: u32 = 0;
        let chunk_duration = Duration::from_secs(chunk_seconds);

        while running.load(Ordering::SeqCst) {
            let chunk_path = output_path.join(format!("{}_{:04}.wav", prefix, chunk_index));

            let mut audio_client = device.get_iaudioclient().expect("Failed to get audio client");

            // Use the device's native mix format to avoid AUDCLNT_E_UNSUPPORTED_FORMAT.
            // In WASAPI shared mode, the audio engine only accepts its own mix format.
            let mix_format = audio_client.get_mixformat().expect("Failed to get mix format");
            let native_sr = mix_format.get_samplespersec() as u32;
            let native_ch = mix_format.get_nchannels() as u16;
            let native_bps = mix_format.get_bitspersample() as u16;
            let blockalign = mix_format.get_blockalign() as usize;

            let (def_period, _min_period) = audio_client.get_periods().expect("Failed to get periods");

            // initialize_client() FIRST — required before SetEventHandle can be called.
            // The wasapi crate initializes with AUDCLNT_STREAMFLAGS_EVENTCALLBACK, so
            // set_get_eventhandle() must follow before start_stream().
            audio_client
                .initialize_client(
                    &mix_format,
                    def_period,
                    &Direction::Capture,
                    &ShareMode::Shared,
                    true, // loopback
                )
                .expect("Failed to initialize loopback client");

            let h_event = audio_client.set_get_eventhandle().expect("Failed to create event handle");

            let capture_client = audio_client
                .get_audiocaptureclient()
                .expect("Failed to get capture client");

            audio_client.start_stream().expect("Failed to start stream");

            // Output WAV as 16-bit int regardless of native format (Groq Whisper compatible).
            let spec = WavSpec {
                channels: native_ch,
                sample_rate: native_sr,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            };
            let mut writer = WavWriter::create(&chunk_path, spec).expect("Failed to create WAV");
            let chunk_start = Instant::now();
            let mut sample_queue: VecDeque<u8> = VecDeque::new();

            let bytes_per_sample = (native_bps as usize) / 8;
            let frame_bytes = bytes_per_sample * native_ch as usize;
            // mic_sr → native_sr nearest-neighbour resample step.
            let mic_step = if mic_enabled {
                mic_sr as f64 / native_sr as f64
            } else {
                0.0
            };
            // Output is paced by wall clock at native_sr: WASAPI loopback delivers no data
            // while the system is silent (and the buffer-ready event may not fire at all), so
            // relying on loopback alone would drop silence gaps and make mic-only recording
            // impossible. We instead emit exactly the number of frames that real time demands,
            // pulling system audio when present and substituting silence otherwise.
            let mut frames_written: u64 = 0;

            while running.load(Ordering::SeqCst) && chunk_start.elapsed() < chunk_duration {
                // Wait on the buffer-ready event (paces the loop without busy-spinning and avoids
                // overrun when audio is active). On timeout we still proceed to the wall-clock fill.
                let _ = h_event.wait_for_event(100);
                let _ = capture_client.read_from_device_to_deque(blockalign, &mut sample_queue);

                // Drain whatever the mic thread produced into a local buffer (one lock per batch).
                // Cap the backlog so a rate mismatch can't build unbounded latency / memory.
                if mic_enabled {
                    if let Ok(mut guard) = mic_shared.lock() {
                        while let Some(s) = guard.samples.pop_front() {
                            mic_local.push_back(s);
                        }
                    }
                    let max_backlog = mic_sr as usize; // ~1s
                    while mic_local.len() > max_backlog {
                        mic_local.pop_front();
                    }
                }
                // Bound system backlog too (loopback bursts) — keep at most ~1s queued.
                let max_sys_bytes = native_sr as usize * frame_bytes;
                while sample_queue.len() > max_sys_bytes {
                    for _ in 0..frame_bytes {
                        sample_queue.pop_front();
                    }
                }

                let sys_muted = mute_sys.load(Ordering::Relaxed);
                let mic_muted = mute_mic.load(Ordering::Relaxed);
                let target =
                    (chunk_start.elapsed().as_secs_f64() * native_sr as f64) as u64;
                while frames_written < target {
                    let have_sys = sample_queue.len() >= frame_bytes;

                    // One mic sample per output frame, applied to every channel. Always advance
                    // the mic cursor (keep the stream continuous) but zero the value when muted.
                    let mic_val = if mic_enabled {
                        mic_cursor += mic_step;
                        let advance = mic_cursor.floor() as i64;
                        if advance > 0 {
                            for _ in 0..advance {
                                if let Some(s) = mic_local.pop_front() {
                                    mic_current = s;
                                }
                            }
                            mic_cursor -= advance as f64;
                        }
                        if mic_muted {
                            0.0
                        } else {
                            mic_current * mic_volume
                        }
                    } else {
                        0.0
                    };

                    for _ in 0..native_ch {
                        let sys_f = if have_sys {
                            match native_bps {
                                32 => {
                                    let b = [
                                        sample_queue.pop_front().unwrap(),
                                        sample_queue.pop_front().unwrap(),
                                        sample_queue.pop_front().unwrap(),
                                        sample_queue.pop_front().unwrap(),
                                    ];
                                    f32::from_le_bytes(b)
                                }
                                16 => {
                                    let b = [
                                        sample_queue.pop_front().unwrap(),
                                        sample_queue.pop_front().unwrap(),
                                    ];
                                    i16::from_le_bytes(b) as f32 / 32768.0
                                }
                                _ => {
                                    for _ in 0..bytes_per_sample {
                                        sample_queue.pop_front();
                                    }
                                    0.0
                                }
                            }
                        } else {
                            0.0 // system silence — keep the timeline going
                        };
                        // Drop the system contribution when muted (queue was still consumed above
                        // so the timeline stays aligned).
                        let sys_f = if sys_muted { 0.0 } else { sys_f };
                        // Soft-limit the sum: summing system + (boosted) mic can exceed 1.0 and
                        // hard-clip ("estourado"). soft_limit is transparent below 0.8 and knees
                        // smoothly toward 1.0 — same intent as the Linux path's `alimiter`.
                        let mixed =
                            (soft_limit(sys_f + mic_val) * 32767.0).clamp(-32768.0, 32767.0) as i16;
                        let _ = writer.write_sample(mixed);
                    }
                    frames_written += 1;
                }
            }

            audio_client.stop_stream().ok();
            writer.finalize().expect("Failed to finalize WAV");
            println!("CHUNK:{}", chunk_path.display());
            chunk_index += 1;
        }

        eprintln!("Capture stopped. {} chunks written.", chunk_index);
    }

    fn find_render_device(name_filter: Option<&str>) -> Device {
        if let Some(filter) = name_filter {
            if let Ok(collection) = DeviceCollection::new(&Direction::Render) {
                if let Ok(count) = collection.get_nbr_devices() {
                    for i in 0..count {
                        if let Ok(dev) = collection.get_device_at_index(i) {
                            if let Ok(name) = dev.get_friendlyname() {
                                if name.contains(filter) {
                                    return dev;
                                }
                            }
                        }
                    }
                }
            }
            eprintln!("Device '{}' not found, using default", filter);
        }
        get_default_device(&Direction::Render).expect("No default render device")
    }

    fn list_devices() {
        let mut devices = Vec::new();

        // Render devices — captured via loopback (system audio / "monitor").
        let default_render = get_default_device(&Direction::Render)
            .and_then(|d| d.get_friendlyname())
            .ok();
        if let Ok(collection) = DeviceCollection::new(&Direction::Render) {
            if let Ok(count) = collection.get_nbr_devices() {
                for i in 0..count {
                    if let Ok(dev) = collection.get_device_at_index(i) {
                        if let Ok(name) = dev.get_friendlyname() {
                            let is_default = default_render.as_deref() == Some(name.as_str());
                            devices.push(serde_json::json!({
                                "id": name,
                                "name": format!("{} (Loopback)", name),
                                "isMonitor": true,
                                "isDefault": is_default,
                                "type": "monitor"
                            }));
                        }
                    }
                }
            }
        }

        // Capture devices — physical microphones / line-in.
        let default_capture = get_default_device(&Direction::Capture)
            .and_then(|d| d.get_friendlyname())
            .ok();
        if let Ok(collection) = DeviceCollection::new(&Direction::Capture) {
            if let Ok(count) = collection.get_nbr_devices() {
                for i in 0..count {
                    if let Ok(dev) = collection.get_device_at_index(i) {
                        if let Ok(name) = dev.get_friendlyname() {
                            let is_default = default_capture.as_deref() == Some(name.as_str());
                            devices.push(serde_json::json!({
                                "id": name,
                                "name": name,
                                "isMonitor": false,
                                "isDefault": is_default,
                                "type": "microphone"
                            }));
                        }
                    }
                }
            }
        }

        println!(
            "DEVICES:{}",
            serde_json::to_string(&devices).unwrap_or_else(|_| "[]".to_string())
        );
    }

    /// Render a ~0.8s sine beep to the given render device (or default) via WASAPI.
    fn play_tone(device_name: Option<&str>) {
        let device = find_render_device(device_name);
        let name = device.get_friendlyname().unwrap_or_default();
        eprintln!("Playing test tone on: {}", name);

        let run = || -> Result<(), Box<dyn std::error::Error>> {
            let mut client = device.get_iaudioclient()?;
            let fmt = client.get_mixformat()?;
            let sr = fmt.get_samplespersec() as f32;
            let ch = fmt.get_nchannels() as usize;
            let bps = fmt.get_bitspersample() as u16;
            let blockalign = fmt.get_blockalign() as usize;
            let (def_period, _) = client.get_periods()?;
            client.initialize_client(
                &fmt,
                def_period,
                &Direction::Render,
                &ShareMode::Shared,
                false,
            )?;
            let h_event = client.set_get_eventhandle()?;
            let render = client.get_audiorenderclient()?;
            client.start_stream()?;

            let total_frames = (sr * 0.8) as usize;
            let fade = (sr * 0.02) as usize; // 20ms fade in/out to avoid clicks
            let freq = 660.0f32;
            let mut frame_idx = 0usize;

            while frame_idx < total_frames {
                if h_event.wait_for_event(300).is_err() {
                    break;
                }
                let avail = client.get_available_space_in_frames()? as usize;
                if avail == 0 {
                    continue;
                }
                let to_write = avail.min(total_frames - frame_idx);
                let mut buf: Vec<u8> = Vec::with_capacity(to_write * blockalign);
                for _ in 0..to_write {
                    let t = frame_idx as f32 / sr;
                    let env = if frame_idx < fade {
                        frame_idx as f32 / fade as f32
                    } else if frame_idx > total_frames - fade {
                        (total_frames - frame_idx) as f32 / fade as f32
                    } else {
                        1.0
                    };
                    let v = (2.0 * std::f32::consts::PI * freq * t).sin() * 0.3 * env;
                    for _ in 0..ch {
                        match bps {
                            32 => buf.extend_from_slice(&v.to_le_bytes()),
                            16 => {
                                let s = (v * 32767.0).clamp(-32768.0, 32767.0) as i16;
                                buf.extend_from_slice(&s.to_le_bytes());
                            }
                            _ => {}
                        }
                    }
                    frame_idx += 1;
                }
                render.write_to_device(to_write, blockalign, &buf, None)?;
            }
            std::thread::sleep(Duration::from_millis(200)); // let the buffer drain
            client.stop_stream().ok();
            Ok(())
        };

        if let Err(e) = run() {
            eprintln!("Test tone failed: {}", e);
            std::process::exit(1);
        }
    }

    /// Soft limiter: linear (transparent) up to ±0.8, then a smooth tanh knee that asymptotes
    /// to ±1.0 so the mixed signal never hard-clips. Mirrors the Linux pipeline's `alimiter`.
    fn soft_limit(x: f32) -> f32 {
        const T: f32 = 0.8;
        let a = x.abs();
        if a <= T {
            x
        } else {
            let over = (a - T) / (1.0 - T);
            x.signum() * (T + (1.0 - T) * over.tanh())
        }
    }

    /// Shared buffer of mono microphone samples (f32, mic's native rate) awaiting mixing.
    #[derive(Default)]
    struct MicState {
        samples: VecDeque<f32>,
    }

    fn find_capture_device(filter: &str) -> Option<Device> {
        if let Ok(collection) = DeviceCollection::new(&Direction::Capture) {
            if let Ok(count) = collection.get_nbr_devices() {
                for i in 0..count {
                    if let Ok(dev) = collection.get_device_at_index(i) {
                        if let Ok(name) = dev.get_friendlyname() {
                            if name.contains(filter) {
                                return Some(dev);
                            }
                        }
                    }
                }
            }
        }
        None
    }

    /// Open the microphone on its own WASAPI capture stream and spawn a thread that pushes
    /// mono f32 samples into `shared`. Returns the mic's native sample rate on success.
    /// COM objects aren't Send, so the client is built inside the thread; an mpsc channel
    /// hands the setup result (sample rate or error) back to the caller.
    fn start_mic_thread(
        filter: &str,
        running: Arc<AtomicBool>,
        shared: Arc<Mutex<MicState>>,
    ) -> Result<u32, String> {
        let filter = filter.to_string();
        let (tx, rx) = std::sync::mpsc::channel::<Result<u32, String>>();

        std::thread::spawn(move || {
            // Each thread using COM must initialize it (MTA, matching the main thread).
            if wasapi::initialize_mta().is_err() {
                let _ = tx.send(Err("COM init failed".into()));
                return;
            }
            let dev = match find_capture_device(&filter) {
                Some(d) => d,
                None => {
                    let _ = tx.send(Err("microphone not found".into()));
                    return;
                }
            };
            macro_rules! bail {
                ($r:expr) => {
                    match $r {
                        Ok(v) => v,
                        Err(e) => {
                            let _ = tx.send(Err(format!("{}", e)));
                            return;
                        }
                    }
                };
            }
            let mut client = bail!(dev.get_iaudioclient());
            let fmt = bail!(client.get_mixformat());
            let sr = fmt.get_samplespersec() as u32;
            let ch = fmt.get_nchannels() as usize;
            let bps = fmt.get_bitspersample() as u16;
            let blockalign = fmt.get_blockalign() as usize;
            let (def_period, _) = bail!(client.get_periods());
            bail!(client.initialize_client(
                &fmt,
                def_period,
                &Direction::Capture,
                &ShareMode::Shared,
                false, // not loopback — real microphone input
            ));
            let h_event = bail!(client.set_get_eventhandle());
            let cap = bail!(client.get_audiocaptureclient());
            bail!(client.start_stream());
            let _ = tx.send(Ok(sr)); // setup OK — caller can proceed

            let bytes_per_sample = (bps as usize) / 8;
            let frame_bytes = bytes_per_sample * ch;
            let mut q: VecDeque<u8> = VecDeque::new();

            while running.load(Ordering::SeqCst) {
                if h_event.wait_for_event(200).is_err() {
                    continue;
                }
                let _ = cap.read_from_device_to_deque(blockalign, &mut q);

                let mut out: Vec<f32> = Vec::new();
                while q.len() >= frame_bytes {
                    let mut sum = 0.0f32;
                    for _ in 0..ch {
                        let s = match bps {
                            32 => {
                                let b = [
                                    q.pop_front().unwrap(),
                                    q.pop_front().unwrap(),
                                    q.pop_front().unwrap(),
                                    q.pop_front().unwrap(),
                                ];
                                f32::from_le_bytes(b)
                            }
                            16 => {
                                let b = [q.pop_front().unwrap(), q.pop_front().unwrap()];
                                i16::from_le_bytes(b) as f32 / 32768.0
                            }
                            _ => {
                                for _ in 0..bytes_per_sample {
                                    q.pop_front();
                                }
                                0.0
                            }
                        };
                        sum += s;
                    }
                    out.push(sum / ch as f32); // downmix to mono
                }
                if !out.is_empty() {
                    if let Ok(mut g) = shared.lock() {
                        for s in out {
                            g.samples.push_back(s);
                        }
                    }
                }
            }
            client.stop_stream().ok();
        });

        rx.recv().map_err(|_| "mic thread exited during setup".to_string())?
    }

    fn get_arg(args: &[String], flag: &str) -> Option<String> {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1))
            .cloned()
    }
}
