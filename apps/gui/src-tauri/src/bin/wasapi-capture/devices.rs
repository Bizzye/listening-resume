//! WASAPI endpoint helpers: resolve a `DeviceSpec`, list endpoints, play the test tone.
//! Every function here touches COM, so callers must have initialized it on their thread.

use crate::protocol::{DeviceSpec, Source};
use std::time::Duration;
use wasapi::{get_default_device, Device, DeviceCollection, Direction, ShareMode};

/// System audio is captured by opening a *render* endpoint in loopback mode.
pub fn direction(source: Source) -> Direction {
    match source {
        Source::System => Direction::Render,
        Source::Mic => Direction::Capture,
    }
}

/// Active endpoints of a direction as (friendly name, device).
fn active_devices(dir: &Direction) -> Vec<(String, Device)> {
    let Ok(collection) = DeviceCollection::new(dir) else {
        return Vec::new();
    };
    let count = collection.get_nbr_devices().unwrap_or(0);
    (0..count)
        .filter_map(|i| collection.get_device_at_index(i).ok())
        .filter_map(|d| d.get_friendlyname().ok().map(|n| (n, d)))
        .collect()
}

/// Exact friendly-name match first; substring match kept for older callers that passed
/// partial names.
fn find_named(dir: &Direction, name: &str) -> Option<Device> {
    let mut devices = active_devices(dir);
    if let Some(i) = devices.iter().position(|(n, _)| n == name) {
        return Some(devices.swap_remove(i).1);
    }
    devices
        .into_iter()
        .find(|(n, _)| n.contains(name))
        .map(|(_, d)| d)
}

pub fn resolve(dir: &Direction, spec: &DeviceSpec) -> Result<Device, String> {
    match spec {
        DeviceSpec::Default => {
            get_default_device(dir).map_err(|e| format!("no default device available ({e})"))
        }
        DeviceSpec::Named(name) => find_named(dir, name).ok_or_else(|| "not found".to_string()),
    }
}

/// Endpoint id of the current OS default (stable identifier, unlike the friendly name).
pub fn default_id(dir: &Direction) -> Option<String> {
    get_default_device(dir).ok()?.get_id().ok()
}

/// Print `DEVICES:<json>`. Shape is consumed by the Node adapter — keep it stable:
/// render endpoints are listed as loopback "monitors" (display name suffixed " (Loopback)"),
/// capture endpoints as microphones; `id` is always the plain friendly name.
pub fn list_devices() {
    let mut out = Vec::new();
    for (dir, is_monitor) in [(Direction::Render, true), (Direction::Capture, false)] {
        let default_name = get_default_device(&dir)
            .and_then(|d| d.get_friendlyname())
            .ok();
        for (name, _) in active_devices(&dir) {
            out.push(serde_json::json!({
                "id": name,
                "name": if is_monitor { format!("{name} (Loopback)") } else { name.clone() },
                "isMonitor": is_monitor,
                "isDefault": default_name.as_deref() == Some(name.as_str()),
                "type": if is_monitor { "monitor" } else { "microphone" },
            }));
        }
    }
    crate::emit(&format!(
        "DEVICES:{}",
        serde_json::to_string(&out).unwrap_or_else(|_| "[]".to_string())
    ));
}

/// Render a ~0.8 s sine beep to the given render device. Used by the GUI's "Test Sound" so it
/// can target the selected device (SoundPlayer can only reach the system default).
pub fn play_tone(spec: &DeviceSpec) -> Result<(), String> {
    let device = resolve(&Direction::Render, spec).or_else(|e| {
        eprintln!("Device {spec:?}: {e}; using the default output");
        resolve(&Direction::Render, &DeviceSpec::Default)
    })?;
    eprintln!(
        "Playing test tone on: {}",
        device.get_friendlyname().unwrap_or_default()
    );
    render_tone(&device).map_err(|e| e.to_string())
}

fn render_tone(device: &Device) -> Result<(), Box<dyn std::error::Error>> {
    let mut client = device.get_iaudioclient()?;
    let fmt = client.get_mixformat()?;
    let sr = fmt.get_samplespersec() as f32;
    let ch = fmt.get_nchannels() as usize;
    let bps = fmt.get_bitspersample();
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
    let fade = (sr * 0.02) as usize; // 20 ms fade in/out to avoid clicks
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
                    16 => buf.extend_from_slice(&((v * 32_767.0) as i16).to_le_bytes()),
                    // Unknown container: write silence of the right size.
                    _ => buf.extend(std::iter::repeat(0u8).take(bps as usize / 8)),
                }
            }
            frame_idx += 1;
        }
        render.write_to_device(to_write, blockalign, &buf, None)?;
    }
    std::thread::sleep(Duration::from_millis(200)); // let the buffer drain
    client.stop_stream().ok();
    Ok(())
}
