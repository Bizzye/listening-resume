use std::process::{Command, Child};
use std::sync::Mutex;
use std::path::PathBuf;
use tauri::{Manager, image::Image, tray::TrayIconBuilder, menu::{Menu, MenuItem}};
#[allow(unused_imports)]
use tauri::WebviewWindowBuilder;

struct ServerProcess(Mutex<Option<Child>>);

const TRAY_ID: &str = "recording-tray";

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

#[tauri::command]
fn set_tray_recording(app: tauri::AppHandle, recording: bool) {
  eprintln!("[tray] set_tray_recording called, recording={}", recording);
  if let Some(tray) = app.tray_by_id(TRAY_ID) {
    let icon_bytes = if recording {
      include_bytes!("../icons/tray/icon-recording.png").to_vec()
    } else {
      include_bytes!("../icons/tray/icon-normal.png").to_vec()
    };
    if let Ok(icon) = Image::from_bytes(&icon_bytes) {
      let _ = tray.set_icon(Some(icon));
      eprintln!("[tray] icon updated ok");
    } else {
      eprintln!("[tray] ERROR: failed to parse icon bytes");
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
      let icon_bytes = include_bytes!("../icons/tray/icon-normal.png");
      let icon = Image::from_bytes(icon_bytes)
        .expect("failed to load tray icon");

      let show_item = MenuItem::with_id(app, "show", "Abrir", true, None::<&str>)?;
      let quit_item = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;
      let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

      TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("Listening Resume")
        .menu(&menu)
        .on_menu_event(|app, event| {
          match event.id.as_ref() {
            "show" => {
              if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
              }
            }
            "quit" => {
              app.exit(0);
            }
            _ => {}
          }
        })
        .on_tray_icon_event(|tray, event| {
          if let tauri::tray::TrayIconEvent::Click { .. } = event {
            if let Some(window) = tray.app_handle().get_webview_window("main") {
              let _ = window.show();
              let _ = window.set_focus();
            }
          }
        })
        .build(app)?;

      // Resolve the bundled server script path
      let server_script = app.path().resolve(
        "resources/server-bundle.mjs",
        tauri::path::BaseDirectory::Resource,
      ).expect("failed to resolve server-bundle.mjs");

      // Set NODE_PATH so native modules can be found
      let node_modules = app.path().resolve(
        "resources/node_modules",
        tauri::path::BaseDirectory::Resource,
      ).expect("failed to resolve node_modules");

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
        .env("PATH", &new_path);

      // On Windows, suppress the console window the child node.exe would otherwise
      // pop up — the API server is an internal detail, not something the end user
      // should see. CREATE_NO_WINDOW (0x08000000).
      #[cfg(target_os = "windows")]
      {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
      }

      let child = cmd
        .spawn()
        .unwrap_or_else(|e| panic!(
          "Failed to start API server: {}. Node binary: {:?}. Ensure Node.js is installed.",
          e, node_bin
        ));

      app.manage(ServerProcess(Mutex::new(Some(child))));

      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      if let tauri::RunEvent::Exit = event {
        // Kill the server process on app exit
        if let Some(state) = app.try_state::<ServerProcess>() {
          if let Ok(mut guard) = state.0.lock() {
            if let Some(mut child) = guard.take() {
              let _ = child.kill();
            }
          }
        }
      }
    });
}
