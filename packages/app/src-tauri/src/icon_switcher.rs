use tauri::{AppHandle, Manager};

pub const ICONS: &[(&str, &[u8])] = &[
    ("midnight-4b", include_bytes!("../icons/switcher/midnight-4b.png")),
    ("midnight-4a", include_bytes!("../icons/switcher/midnight-4a.png")),
    ("vibrant-cyber", include_bytes!("../icons/switcher/vibrant-cyber.png")),
    ("medium-bright", include_bytes!("../icons/switcher/medium-bright.png")),
    ("dark-screen", include_bytes!("../icons/switcher/dark-screen.png")),
    ("neon-robot", include_bytes!("../icons/switcher/neon-robot.png")),
    ("minimal-play", include_bytes!("../icons/switcher/minimal-play.png")),
    ("classic-original", include_bytes!("../icons/switcher/classic-original.png")),
    ("original-tv", include_bytes!("../icons/switcher/neon-robot.png")),
];

#[tauri::command]
pub fn set_app_icon(app: AppHandle, icon_id: String) -> Result<(), String> {
    let (_, icon_bytes) = ICONS
        .iter()
        .find(|(id, _)| *id == icon_id.as_str())
        .ok_or_else(|| format!("Unknown icon_id: {}", icon_id))?;

    let image = tauri::image::Image::from_bytes(icon_bytes)
        .map_err(|e| format!("Failed to parse icon image: {}", e))?;

    let windows = app.webview_windows();
    if windows.is_empty() {
        return Err("No webview windows found".to_string());
    }

    for (_, win) in windows {
        let _ = win.set_icon(image.clone());
    }

    Ok(())
}
