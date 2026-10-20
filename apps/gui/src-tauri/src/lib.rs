use std::process::{Command, Child, Stdio};
use std::sync::Mutex;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tauri::{Manager, image::Image, tray::TrayIconBuilder, menu::{Menu, MenuItem}};

struct ServerProcess(Mutex<Option<Child>>);

/// How long the API server gets to stop gracefully (finalize an active recording, close the
/// database) after its stdin is closed, before it is killed.
const SERVER_SHUTDOWN_GRACE: Duration = Duration::from_secs(4);

/// Stop the API server: close its stdin (with `LR_SHUTDOWN_ON_STDIN_EOF=1` the server treats
/// EOF like SIGTERM and shuts down gracefully), wait up to `SERVER_SHUTDOWN_GRACE`, then kill.
/// Idempotent; the lock is held throughout, so a concurrent caller (tray "Quit" thread vs.
/// `RunEvent::Exit`) waits for the first one to finish instead of exiting under it.
fn stop_server(app: &tauri::AppHandle) {
  let Some(state) = app.try_state::<ServerProcess>() else { return };
  let mut guard = match state.0.lock() {
    Ok(g) => g,
    Err(poisoned) => poisoned.into_inner(),
  };
  let Some(mut child) = guard.take() else { return };
  drop(child.stdin.take()); // EOF → graceful shutdown
  let deadline = Instant::now() + SERVER_SHUTDOWN_GRACE;
  loop {
    match child.try_wait() {
      Ok(Some(status)) => {
        eprintln!("[server] exited gracefully ({status})");
        return;
      }
      Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
      Ok(None) => {
        eprintln!("[server] did not stop within {SERVER_SHUTDOWN_GRACE:?}; killing it");
        break;
      }
      Err(e) => {
        eprintln!("[server] wait failed ({e}); killing it");
        break;
      }
    }
  }
  let _ = child.kill();
  let _ = child.wait();
}

/// Windows Job Object with KILL_ON_JOB_CLOSE: the node server and everything it spawns
/// (wasapi-capture, ffmpeg) are terminated by the OS when the app's last handle to the job
/// closes — including when the app crashes or is killed — so nothing can be orphaned.
#[cfg(windows)]
mod job {
  use std::os::windows::io::AsRawHandle;
  use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
  use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
  };

  pub struct Job(HANDLE);

  // SAFETY: a job handle is a plain kernel handle, usable from any thread.
  unsafe impl Send for Job {}
  unsafe impl Sync for Job {}

  impl Job {
    pub fn kill_on_close() -> std::io::Result<Self> {
      // SAFETY: plain Win32 calls; every pointer passed is valid for the call's duration.
      unsafe {
        let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if handle.is_null() {
          return Err(std::io::Error::last_os_error());
        }
        let job = Job(handle);
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        // BREAKAWAY_OK: a tool that explicitly asks to leave the job may (instead of failing
        // to start); nothing we spawn does.
        info.BasicLimitInformation.LimitFlags =
          JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        let ok = SetInformationJobObject(
          job.0,
          JobObjectExtendedLimitInformation,
          &info as *const _ as *const core::ffi::c_void,
          std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 {
          return Err(std::io::Error::last_os_error());
        }
        Ok(job)
      }
    }

    pub fn assign(&self, child: &std::process::Child) -> std::io::Result<()> {
      // SAFETY: both handles are valid; the child's handle is owned by `child` for the call.
      let ok = unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) };
      if ok == 0 {
        return Err(std::io::Error::last_os_error());
      }
      Ok(())
    }
  }

  impl Drop for Job {
    fn drop(&mut self) {
      // SAFETY: owned handle, closed exactly once.
      unsafe { CloseHandle(self.0) };
    }
  }
}

/// Keeps the job handle alive for the app's lifetime (closing it kills the server tree).
#[cfg(windows)]
struct ServerJob(#[allow(dead_code)] job::Job);

const TRAY_ID: &str = "recording-tray";
const TRAY_ICON_NORMAL: &[u8] = include_bytes!("../icons/tray/icon-normal.png");
const TRAY_ICON_RECORDING: &[u8] = include_bytes!("../icons/tray/icon-recording.png");

/// Find the node binary, checking bundled location, nvm and common locations
fn find_node() -> PathBuf {
  // First check bundled node next to the executable (resources/bin/node or node.exe)
  if let Ok(exe_path) = std::env::current_exe() {
    if let Some(exe_dir) = exe_path.parent() {
      let node_name = if cfg!(target_os = "windows") { "node.exe" } else { "node" };
      // Tauri puts resources relative to the executable
      let bundled = exe_dir.join("resources").join("bin").join(node_name);
      if bundled.exists() {
        return bundled;
      }
      // Also check directly next to exe (dev mode)
      let beside = exe_dir.join(node_name);
      if beside.exists() && beside != exe_path {
        return beside;
      }
    }
  }

  // Check if node is in PATH (cross-platform)
  let which_cmd = if cfg!(target_os = "windows") { "where" } else { "which" };
  if let Ok(output) = Command::new(which_cmd).arg("node").output() {
    if output.status.success() {
      let path = String::from_utf8_lossy(&output.stdout)
        .lines().next().unwrap_or("").trim().to_string();
      if !path.is_empty() {
        return PathBuf::from(path);
      }
    }
  }

  // Windows-specific locations
  #[cfg(target_os = "windows")]
  {
    // Check common Windows Node.js install paths
    let program_files = std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".to_string());
    let candidates = [
      PathBuf::from(&program_files).join("nodejs\\node.exe"),
      PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default()).join("Programs\\nodejs\\node.exe"),
      PathBuf::from(std::env::var("APPDATA").unwrap_or_default()).join("nvm\\current\\node.exe"),
    ];
    for candidate in &candidates {
      if candidate.exists() {
        return candidate.clone();
      }
    }
  }

  // Unix-specific: check nvm
  #[cfg(not(target_os = "windows"))]
  {
    if let Ok(home) = std::env::var("HOME") {
      let nvm_dir = std::env::var("NVM_DIR")
        .unwrap_or_else(|_| format!("{}/.nvm", home));
      
      // Try nvm default alias
      let default_path = PathBuf::from(&nvm_dir).join("alias/default");
      if let Ok(version) = std::fs::read_to_string(&default_path) {
        let version = version.trim();
        let entries = std::fs::read_dir(
          PathBuf::from(&nvm_dir).join("versions/node")
        );
        if let Ok(entries) = entries {
          for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(&format!("v{}", version)) || name == version {
              let node = entry.path().join("bin/node");
              if node.exists() {
                return node;
              }
            }
          }
        }
      }

      // Fallback: find any node version in nvm
      let versions_dir = PathBuf::from(&nvm_dir).join("versions/node");
      if let Ok(entries) = std::fs::read_dir(&versions_dir) {
        let mut versions: Vec<_> = entries.flatten().collect();
        versions.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
        if let Some(entry) = versions.first() {
          let node = entry.path().join("bin/node");
          if node.exists() {
            return node;
          }
        }
      }
    }
  }

  // Last resort
  let node_name = if cfg!(target_os = "windows") { "node.exe" } else { "node" };
  PathBuf::from(node_name)
}

fn show_main_window(app: &tauri::AppHandle) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.show();
    let _ = window.set_focus();
  }
}

#[tauri::command]
fn set_tray_recording(app: tauri::AppHandle, recording: bool) {
  if let Some(tray) = app.tray_by_id(TRAY_ID) {
    let icon_bytes = if recording { TRAY_ICON_RECORDING } else { TRAY_ICON_NORMAL };
    match Image::from_bytes(icon_bytes) {
      Ok(icon) => {
        let _ = tray.set_icon(Some(icon));
      }
      Err(e) => eprintln!("[tray] ERROR: failed to parse icon bytes: {}", e),
    }
    let tooltip = if recording {
      "Listening Resume — Gravando..."
    } else {
      "Listening Resume"
    };
    let _ = tray.set_tooltip(Some(tooltip));
  } else {
    eprintln!("[tray] ERROR: tray not found by id '{}'", TRAY_ID);
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .invoke_handler(tauri::generate_handler![set_tray_recording])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // Setup system tray
      let icon = Image::from_bytes(TRAY_ICON_NORMAL)?;

      let show_item = MenuItem::with_id(app, "show", "Abrir", true, None::<&str>)?;
      let quit_item = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;
      let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

      TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("Listening Resume")
        .menu(&menu)
        .on_menu_event(|app, event| {
          match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => {
              // Hide right away, stop the server off the UI thread (up to a few seconds while
              // it finalizes a recording), then exit. RunEvent::Exit's stop_server is a no-op.
              for window in app.webview_windows().values() {
                let _ = window.hide();
              }
              let app = app.clone();
              std::thread::spawn(move || {
                stop_server(&app);
                app.exit(0);
              });
            }
            _ => {}
          }
        })
        .on_tray_icon_event(|tray, event| {
          if let tauri::tray::TrayIconEvent::Click { .. } = event {
            show_main_window(tray.app_handle());
          }
        })
        .build(app)?;

      // Resolve the bundled server script path
      let server_script = app.path().resolve(
        "resources/server-bundle.mjs",
        tauri::path::BaseDirectory::Resource,
      )?;

      // Set NODE_PATH so native modules can be found
      let node_modules = app.path().resolve(
        "resources/node_modules",
        tauri::path::BaseDirectory::Resource,
      )?;

      // Resolve bundled bin path (may contain ffmpeg, etc.)
      let bin_dir = app.path().resolve(
        "resources/bin",
        tauri::path::BaseDirectory::Resource,
      ).unwrap_or_default();

      // Spawn the Node.js API server as a child process
      let node_bin = find_node();

      // Prepend bundled bin dir to PATH so ffmpeg can be found
      let path_env = std::env::var("PATH").unwrap_or_default();
      let new_path = if cfg!(target_os = "windows") {
        format!("{};{}", bin_dir.display(), path_env)
      } else {
        format!("{}:{}", bin_dir.display(), path_env)
      };

      let mut cmd = Command::new(&node_bin);
      cmd
        .arg(&server_script)
        .env("NODE_PATH", &node_modules)
        .env("PATH", &new_path)
        // Graceful-stop channel: the app closes the server's stdin on exit (see stop_server).
        // If this app crashes the pipe closes too, and the server shuts itself down.
        .env("LR_SHUTDOWN_ON_STDIN_EOF", "1")
        .stdin(Stdio::piped());

      // On Windows, suppress the console window the child node.exe would otherwise
      // pop up — the API server is an internal detail, not something the end user
      // should see. CREATE_NO_WINDOW (0x08000000).
      #[cfg(target_os = "windows")]
      {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
      }

      let child = cmd.spawn().map_err(|e| format!(
        "Failed to start API server: {e}. Node binary: {node_bin:?}. Ensure Node.js is installed."
      ))?;

      #[cfg(windows)]
      match job::Job::kill_on_close().and_then(|job| job.assign(&child).map(|()| job)) {
        Ok(job) => {
          app.manage(ServerJob(job));
        }
        // Not fatal: graceful stop still works; only crash-time cleanup is lost.
        Err(e) => eprintln!("[server] could not attach to a job object: {e}"),
      }

      app.manage(ServerProcess(Mutex::new(Some(child))));

      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      // Every exit path ends here (tray "Quit", closing the last window, app.exit): stop the
      // server gracefully. No-op if the tray handler already did.
      if let tauri::RunEvent::Exit = event {
        stop_server(app);
      }
    });
}
