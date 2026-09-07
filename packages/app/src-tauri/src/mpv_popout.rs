//! Popout MPV player — standalone window for Live TV / VOD playback.
//!
//! Spawns a separate MPV process that is NOT embedded in the Tauri window,
//! giving it its own OS-level window. Controlled via IPC (named pipe on
//! Windows, Unix socket on macOS).

use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime, Manager};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;
use tokio::io::AsyncWriteExt;
use serde_json::{json, Value};

// ─── State ───────────────────────────────────────────────────────────────────

pub struct PopoutInstance {
    pub pid: u32,
    #[cfg(target_os = "windows")]
    pub hwnd: isize,
    pub ipc_tx: Option<tokio::sync::mpsc::Sender<String>>,
}

pub struct PopoutMpvState {
    pub instance: Mutex<Option<PopoutInstance>>,
}

impl PopoutMpvState {
    pub fn new() -> Self {
        PopoutMpvState {
            instance: Mutex::new(None),
        }
    }
}

// ─── Socket / Pipe path ─────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn popout_socket_path() -> String {
    format!(r"\\.\pipe\mpv-popout-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis())
}

#[cfg(target_os = "macos")]
fn popout_socket_path() -> String {
    let tmp = std::env::temp_dir();
    let pid = std::process::id();
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis();
    tmp.join(format!("mpv-popout-{}-{}.sock", pid, ts)).to_string_lossy().to_string()
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn popout_socket_path() -> String {
    String::from("/tmp/mpv-popout.sock")
}

// ─── IPC helpers ─────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
async fn connect_ipc_windows(socket_path: &str) -> Result<tokio::sync::mpsc::Sender<String>, String> {
    use tokio::net::windows::named_pipe::ClientOptions;
    use tokio::io::AsyncReadExt;

    let stream = {
        let mut retries = 20;
        loop {
            match ClientOptions::new().open(socket_path) {
                Ok(s) => break Ok(s),
                Err(_) if retries > 0 => {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    retries -= 1;
                }
                Err(e) => break Err(format!("Popout IPC connect failed: {}", e)),
            }
        }
    }?;

    let (mut reader, mut writer) = tokio::io::split(stream);
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(32);

    // Drain reader so MPV doesn't deadlock
    tauri::async_runtime::spawn(async move {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
    });

    tauri::async_runtime::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let _ = writer.write_all(msg.as_bytes()).await;
            let _ = writer.write_all(b"\n").await;
            let _ = writer.flush().await;
        }
    });

    Ok(tx)
}

#[cfg(target_os = "macos")]
async fn connect_ipc_macos(socket_path: &str) -> Result<tokio::sync::mpsc::Sender<String>, String> {
    use tokio::net::UnixStream;
    use tokio::io::AsyncReadExt;

    let stream = {
        let mut retries = 20;
        loop {
            match UnixStream::connect(socket_path).await {
                Ok(s) => break Ok(s),
                Err(_) if retries > 0 => {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    retries -= 1;
                }
                Err(e) => break Err(format!("Popout IPC connect failed: {}", e)),
            }
        }
    }?;

    let (mut reader, mut writer) = tokio::io::split(stream);
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(32);

    // Drain reader
    tauri::async_runtime::spawn(async move {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
    });

    tauri::async_runtime::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let _ = writer.write_all(msg.as_bytes()).await;
            let _ = writer.write_all(b"\n").await;
            let _ = writer.flush().await;
        }
    });

    Ok(tx)
}

async fn connect_ipc(socket_path: &str) -> Result<tokio::sync::mpsc::Sender<String>, String> {
    #[cfg(target_os = "windows")]
    { connect_ipc_windows(socket_path).await }
    #[cfg(target_os = "macos")]
    { connect_ipc_macos(socket_path).await }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    { Err("Unsupported platform".to_string()) }
}

pub async fn send_ipc(tx: &tokio::sync::mpsc::Sender<String>, command: &str, args: Vec<Value>) {
    let mut cmd_args = vec![Value::String(command.to_string())];
    cmd_args.extend(args);
    let msg = json!({ "command": cmd_args }).to_string();
    let _ = tx.send(msg).await;
}

// ─── Window helpers ──────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn set_always_on_top(hwnd_raw: isize, on_top: bool) -> Result<(), String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_TOPMOST, HWND_NOTOPMOST, SWP_NOMOVE, SWP_NOSIZE, SWP_NOACTIVATE};

    let hwnd = HWND(hwnd_raw as _);
    let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE;
    unsafe {
        let insert_after = if on_top { HWND_TOPMOST } else { HWND_NOTOPMOST };
        log::info!("[MPV-POPOUT] Calling SetWindowPos with HWND={:?}, on_top={}", hwnd, on_top);
        let res = SetWindowPos(hwnd, insert_after, 0, 0, 0, 0, flags);
        match res {
            Ok(_) => {
                log::info!("[MPV-POPOUT] SetWindowPos succeeded for HWND={:?}", hwnd);
                Ok(())
            }
            Err(e) => {
                log::error!("[MPV-POPOUT] SetWindowPos failed for HWND={:?}: {}", hwnd, e);
                Err(format!("SetWindowPos failed: {}", e))
            }
        }
    }
}

/// Find a top-level window by process ID using EnumWindows and GetWindowThreadProcessId.
/// The popout MPV is NOT a child window (no --wid), so EnumChildWindows won't find it.
#[cfg(target_os = "windows")]
fn find_hwnd_by_pid(target_pid: u32) -> Option<isize> {
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, IsWindowVisible, GetWindowThreadProcessId, GetClassNameW};

    struct SearchData { pid: u32, result: isize }
    let mut data = SearchData { pid: target_pid, result: 0 };

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let data = &mut *(lparam.0 as *mut SearchData);
        let mut process_id: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
        if process_id == data.pid {
            let mut class_name = [0u16; 256];
            let len = GetClassNameW(hwnd, &mut class_name);
            let class_str = if len > 0 {
                String::from_utf16_lossy(&class_name[..len as usize])
            } else {
                String::new()
            };
            let visible = IsWindowVisible(hwnd).as_bool();
            log::info!("[MPV-POPOUT-ENUM] Found window owned by PID {}: HWND={:?}, class={}, visible={}", 
                data.pid, hwnd, class_str, visible);
            // MPV main window has class name "mpv"
            if class_str == "mpv" {
                data.result = hwnd.0 as isize;
                return BOOL(0); // Stop enumeration
            }
        }
        BOOL(1)
    }

    unsafe {
        let _ = EnumWindows(Some(enum_proc), LPARAM(&mut data as *mut SearchData as isize));
    }

    if data.result == 0 { None } else { Some(data.result) }
}

#[cfg(target_os = "windows")]
fn get_parent_hwnd<R: Runtime>(app: &AppHandle<R>) -> Result<isize, String> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let window = app.get_window("main")
        .ok_or("Main window not found")?;
    let handle = window.window_handle().map_err(|e| e.to_string())?;
    match handle.as_raw() {
        RawWindowHandle::Win32(h) => Ok(h.hwnd.get() as isize),
        _ => Err("Unsupported window handle".to_string()),
    }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/// Kill the existing popout MPV instance.
pub async fn kill_popout<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<PopoutMpvState>();
    let maybe_pid = {
        let mut inst = state.instance.lock().unwrap();
        if let Some(popout) = inst.take() {
            drop(popout.ipc_tx);
            Some(popout.pid)
        } else {
            None
        }
    };

    if let Some(pid) = maybe_pid {
        #[cfg(target_os = "windows")]
        {
            use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
            unsafe {
                if let Ok(ph) = OpenProcess(PROCESS_TERMINATE, false, pid) {
                    let _ = TerminateProcess(ph, 0);
                }
            }
        }
        #[cfg(target_os = "macos")]
        {
            let _ = std::process::Command::new("kill").arg(format!("{}", pid)).output();
        }
    }

    // Emit closed event
    let _ = app.emit("popout-closed", ());
}

/// Spawn (or respawn) the popout MPV window and load a URL.
pub async fn spawn_and_load<R: Runtime>(
    app: &AppHandle<R>,
    url: String,
    always_on_top: bool,
    custom_params: Vec<String>,
) -> Result<(), String> {
    // Kill any existing instance first
    kill_popout(app).await;

    let socket_path = popout_socket_path();

    // Base args — NO --wid so MPV creates its own window
    // NOTE: Native MPV controls are ENABLED so the popout behaves like
    // a normal media player window (hover for OSC, keyboard shortcuts, etc.)
    let mut args = vec![
        format!("--input-ipc-server={}", socket_path),
        "--title=YNOTV_POPOUT".into(),
        "--force-window=immediate".into(),
        "--idle=yes".into(),
        "--keep-open=yes".into(),
        "--cache=yes".into(),
        "--volume=100".into(),
        "--mute=no".into(),
        "--no-border".into(),
    ];

    if always_on_top {
        args.push("--ontop".into());
    }

    // If SOCKS5 proxy is configured, pass it to MPV
    if let Ok(proxy) = std::env::var("ALL_PROXY") {
        args.push(format!("--http-proxy={}", proxy));
    }

    // On Windows, omit --wid to get a standalone window.
    // On macOS, MPV naturally creates its own window.

    // Append user-provided custom parameters (already sanitized by caller)
    for param in &custom_params {
        args.push(param.clone());
    }

    let sidecar = app.shell().sidecar("mpv")
        .map_err(|e| format!("Sidecar error: {}", e))?;

    let (mut rx, child) = sidecar.args(&args).spawn()
        .map_err(|e| format!("Failed to spawn popout MPV: {}", e))?;

    let pid = child.pid();
    let app_handle_stderr = app.clone();

    // Monitor stderr AND process death.
    // When MPV dies naturally (user closes the window), we emit popout-closed
    // so the frontend floating widget can disappear.
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stderr(line) => {
                    log::debug!("[MPV-POPOUT] Stderr: {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Terminated(_) => {
                    // Check if the instance is still in state.
                    // If yes, MPV died on its own (user closed window) — clean up and notify frontend.
                    // If no, kill_popout() already handled it — do nothing.
                    let state = app_handle_stderr.state::<PopoutMpvState>();
                    let was_alive = {
                        let mut inst = state.instance.lock().unwrap();
                        if inst.is_some() {
                            let _ = inst.take();
                            true
                        } else {
                            false
                        }
                    };
                    if was_alive {
                        let _ = app_handle_stderr.emit("popout-closed", ());
                        log::info!("[MPV-POPOUT] Process terminated naturally — emitted popout-closed");
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    // Wait for MPV to create its window
    tokio::time::sleep(Duration::from_millis(1500)).await;

    // Connect IPC
    let ipc_tx = connect_ipc(&socket_path).await.ok();
    let ipc_tx_clone = ipc_tx.clone();

    #[cfg(target_os = "windows")]
    {
        // Try to find the popout HWND — it's a top-level window, not a child.
        // We retry up to 10 times with a 300ms delay to give MPV enough time to initialize its window.
        let mut hwnd: isize = 0;
        for attempt in 1..=10 {
            if let Some(found) = find_hwnd_by_pid(pid) {
                hwnd = found;
                log::info!("[MPV-POPOUT] Successfully resolved HWND: {:?} on attempt {}", hwnd, attempt);
                break;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }

        if hwnd != 0 {
            // Set always-on-top if requested
            if always_on_top {
                let _ = set_always_on_top(hwnd, true);
            }
        } else {
            log::warn!("[MPV-POPOUT] Warning: Failed to find HWND for PID {} after retries", pid);
        }

        let state = app.state::<PopoutMpvState>();
        let mut inst = state.instance.lock().unwrap();
        *inst = Some(PopoutInstance { pid, hwnd, ipc_tx });
    }

    #[cfg(target_os = "macos")]
    {
        let state = app.state::<PopoutMpvState>();
        let mut inst = state.instance.lock().unwrap();
        *inst = Some(PopoutInstance { pid, ipc_tx });
    }

    // Load the URL
    if let Some(ref tx) = ipc_tx_clone {
        send_ipc(tx, "loadfile", vec![json!(url)]).await;
    }

    // Emit opened event
    let _ = app.emit("popout-opened", ());

    Ok(())
}

/// Load a new URL into an existing popout.
pub async fn load_url<R: Runtime>(app: &AppHandle<R>, url: String) -> Result<(), String> {
    let tx = {
        let state = app.state::<PopoutMpvState>();
        let inst = state.instance.lock().unwrap();
        inst.as_ref().and_then(|i| i.ipc_tx.clone())
    };

    if let Some(tx) = tx {
        send_ipc(&tx, "loadfile", vec![json!(url)]).await;
        Ok(())
    } else {
        Err("Popout not running".to_string())
    }
}

/// Stop playback in the popout (keep window alive).
pub async fn stop<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let tx = {
        let state = app.state::<PopoutMpvState>();
        let inst = state.instance.lock().unwrap();
        inst.as_ref().and_then(|i| i.ipc_tx.clone())
    };
    if let Some(tx) = tx {
        send_ipc(&tx, "stop", vec![]).await;
    }
    Ok(())
}

/// Set an MPV property on the popout.
pub async fn set_property<R: Runtime>(
    app: &AppHandle<R>,
    property: &str,
    value: Value,
) -> Result<(), String> {
    let tx = {
        let state = app.state::<PopoutMpvState>();
        let inst = state.instance.lock().unwrap();
        inst.as_ref().and_then(|i| i.ipc_tx.clone())
    };
    if let Some(tx) = tx {
        send_ipc(&tx, "set_property", vec![json!(property), value]).await;
    }
    Ok(())
}

/// Get whether the popout is currently running.
pub fn is_running<R: Runtime>(app: &AppHandle<R>) -> bool {
    let state = app.state::<PopoutMpvState>();
    let inst = state.instance.lock().unwrap();
    inst.is_some()
}

/// Toggle always-on-top on Windows.
/// If the HWND wasn't captured during spawn (e.g. timing race), searches top-level windows.
pub async fn set_always_on_top_cmd<R: Runtime>(app: &AppHandle<R>, on_top: bool) -> Result<(), String> {
    // Send to MPV via IPC dynamically
    let _ = set_property(app, "ontop", json!(on_top)).await;

    #[cfg(target_os = "windows")]
    {
        let mut hwnd = 0;
        let mut pid = 0;
        {
            let state = app.state::<PopoutMpvState>();
            let inst = state.instance.lock().unwrap();
            if let Some(ref popout) = *inst {
                hwnd = popout.hwnd;
                pid = popout.pid;
            }
        }
        // Fall back to searching all top-level windows by PID
        if hwnd == 0 && pid != 0 {
            if let Some(found) = find_hwnd_by_pid(pid) {
                hwnd = found;
                // Persist the discovered HWND
                let state = app.state::<PopoutMpvState>();
                let mut inst = state.instance.lock().unwrap();
                if let Some(ref mut popout) = inst.as_mut() {
                    popout.hwnd = found;
                }
            }
        }
        if hwnd != 0 {
            set_always_on_top(hwnd, on_top)?;
        }
    }
    // macOS: not supported via this API
    let _ = on_top;
    Ok(())
}
