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
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::{SampleFormat, StreamConfig};
    use hound::{WavSpec, WavWriter};
    use std::env;
    use std::io::BufRead;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    pub fn run() {
        let args: Vec<String> = env::args().collect();

        if args.contains(&"--list-devices".to_string()) {
            list_devices();
            return;
        }

        let output_dir = get_arg(&args, "--output-dir").expect("--output-dir required");
        let prefix = get_arg(&args, "--prefix").unwrap_or_else(|| "chunk".to_string());
        let chunk_seconds: u64 = get_arg(&args, "--chunk-seconds")
            .unwrap_or_else(|| "120".to_string())
            .parse()
            .expect("invalid --chunk-seconds");
        let sample_rate: u32 = get_arg(&args, "--sample-rate")
            .unwrap_or_else(|| "16000".to_string())
            .parse()
            .expect("invalid --sample-rate");
        let channels: u16 = get_arg(&args, "--channels")
            .unwrap_or_else(|| "1".to_string())
            .parse()
            .expect("invalid --channels");
        let device_name = get_arg(&args, "--device");

        let host = cpal::host_from_id(cpal::HostId::Wasapi)
            .expect("WASAPI host not available");

        // Get the output device (for loopback capture)
        let device = if let Some(name) = &device_name {
            host.output_devices()
                .expect("Failed to enumerate output devices")
                .find(|d| d.name().map(|n| n.contains(name.as_str())).unwrap_or(false))
                .unwrap_or_else(|| {
                    eprintln!("Device '{}' not found, using default output", name);
                    host.default_output_device().expect("No default output device")
                })
        } else {
            host.default_output_device().expect("No default output device")
        };

        let device_actual_name = device.name().unwrap_or_else(|_| "Unknown".to_string());
        eprintln!("Capturing from: {} (loopback)", device_actual_name);

        // Get default output config
        let supported_config = device
            .default_output_config()
            .expect("Failed to get default output config");

        let config: StreamConfig = StreamConfig {
            channels,
            sample_rate: cpal::SampleRate(sample_rate),
            buffer_size: cpal::BufferSize::Default,
        };

        let spec = WavSpec {
            channels,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };

        let output_path = PathBuf::from(&output_dir);
        std::fs::create_dir_all(&output_path).expect("Failed to create output directory");

        let running = Arc::new(AtomicBool::new(true));
        let running_clone = running.clone();

        // Spawn stdin reader for graceful stop
        std::thread::spawn(move || {
            let stdin = std::io::stdin();
            for line in stdin.lock().lines() {
                if let Ok(cmd) = line {
                    if cmd.trim() == "q" {
                        running_clone.store(false, Ordering::SeqCst);
                        break;
                    }
                }
            }
            // stdin closed = parent died
            running_clone.store(false, Ordering::SeqCst);
        });

        let mut chunk_index: u32 = 0;
        let chunk_duration = Duration::from_secs(chunk_seconds);

        while running.load(Ordering::SeqCst) {
            let chunk_path = output_path.join(format!(
                "{}_{:04}.wav",
                prefix, chunk_index
            ));

            let writer = Arc::new(Mutex::new(Some(
                WavWriter::create(&chunk_path, spec).expect("Failed to create WAV file"),
            )));

            let writer_clone = writer.clone();
            let running_stream = running.clone();
            let chunk_start = Instant::now();
            let chunk_done = Arc::new(AtomicBool::new(false));
            let chunk_done_clone = chunk_done.clone();
            let chunk_dur = chunk_duration;

            let err_fn = |err| eprintln!("Stream error: {}", err);

            let stream = match supported_config.sample_format() {
                SampleFormat::F32 => device.build_input_stream_with_loopback(
                    &config,
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        if chunk_start.elapsed() >= chunk_dur || !running_stream.load(Ordering::SeqCst) {
                            chunk_done_clone.store(true, Ordering::SeqCst);
                            return;
                        }
                        if let Ok(mut guard) = writer_clone.lock() {
                            if let Some(ref mut w) = *guard {
                                for &sample in data {
                                    let s = (sample * 32767.0).clamp(-32768.0, 32767.0) as i16;
                                    let _ = w.write_sample(s);
                                }
                            }
                        }
                    },
                    err_fn,
                    None,
                ),
                SampleFormat::I16 => device.build_input_stream_with_loopback(
                    &config,
                    move |data: &[i16], _: &cpal::InputCallbackInfo| {
                        if chunk_start.elapsed() >= chunk_dur || !running_stream.load(Ordering::SeqCst) {
                            chunk_done_clone.store(true, Ordering::SeqCst);
                            return;
                        }
                        if let Ok(mut guard) = writer_clone.lock() {
                            if let Some(ref mut w) = *guard {
                                for &sample in data {
                                    let _ = w.write_sample(sample);
                                }
                            }
                        }
                    },
                    err_fn,
                    None,
                ),
                _ => {
                    eprintln!("Unsupported sample format: {:?}", supported_config.sample_format());
                    std::process::exit(1);
                }
            };

            let stream = stream.expect("Failed to build loopback stream");
            stream.play().expect("Failed to start stream");

            // Wait for chunk to finish
            while !chunk_done.load(Ordering::SeqCst) && running.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(100));
                if chunk_start.elapsed() >= chunk_duration {
                    break;
                }
            }

            drop(stream);

            // Finalize the WAV file
            if let Ok(mut guard) = writer.lock() {
                if let Some(w) = guard.take() {
                    let _ = w.finalize();
                }
            }

            // Notify parent that chunk is ready
            println!("CHUNK:{}", chunk_path.display());

            chunk_index += 1;

            if !running.load(Ordering::SeqCst) {
                break;
            }
        }

        eprintln!("Capture stopped. {} chunks written.", chunk_index);
    }

    fn list_devices() {
        let host = match cpal::host_from_id(cpal::HostId::Wasapi) {
            Ok(h) => h,
            Err(e) => {
                eprintln!("WASAPI host not available: {}", e);
                println!("DEVICES:[]");
                return;
            }
        };

        let mut devices = Vec::new();
        if let Ok(output_devices) = host.output_devices() {
            for device in output_devices {
                if let Ok(name) = device.name() {
                    let is_default = host
                        .default_output_device()
                        .and_then(|d| d.name().ok())
                        .map(|n| n == name)
                        .unwrap_or(false);
                    devices.push(serde_json::json!({
                        "id": name,
                        "name": format!("{} (Loopback)", name),
                        "isMonitor": true,
                        "isDefault": is_default
                    }));
                }
            }
        }

        println!("DEVICES:{}", serde_json::to_string(&devices).unwrap_or_else(|_| "[]".to_string()));
    }

    fn get_arg(args: &[String], flag: &str) -> Option<String> {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1))
            .cloned()
    }
}
