//! Native child WebView for the embedded Jellyfin tab.
//!
//! The Jellyfin web UI is shown inside a child WebView docked below the app's
//! titlebar/toolbar. A Tauri initialization script intercepts playback at the
//! media-element level: Jellyfin 10.10 removed the `window.playbackManager` /
//! `window.playerManager` globals (the manager is now a webpack-module
//! singleton injected into plugins), but *every* Jellyfin web version still
//! ends playback in a real `<video>`/`<audio>` element with the direct-stream
//! URL. The script watches for those elements, encodes the resolved stream URL
//! into `document.title` (a `ynotv-jf:play:` prefix), and blanks Jellyfin's own
//! element so its player cannot run. Rust listens for title changes via
//! `WebviewBuilder::on_document_title_changed` (works cross-origin and needs no
//! remote-domain IPC) and forwards the stream to the frontend
//! (`jellyfin:play` event), which drives it through ynoTV's normal VOD play
//! pipeline — fullscreen transparent player view, Now Playing bar, mpv engine.
//!
//! Once playback starts the frontend **destroys** the child WebView (via
//! `jellyfin_embed_close`) so it can't cover the player surface; the frontend
//! re-creates the WebView (same Jellyfin session — the WebView2 data profile is
//! shared) when playback ends, because returning to the Jellyfin tab mounts the
//! page again. `jellyfin_confirm_playback` records the handoff so the
//! mpv-status idle listener can emit `jellyfin:playback-state { playing: false }`
//! (gated, so the buffering blip on load doesn't count as the stream ending).
//!
//! The child WebView is created with the `unstable` feature (`add_child`).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{
    AppHandle, Emitter, Listener, LogicalPosition, LogicalSize, Manager, Position, Runtime, Size,
    WebviewUrl,
};

/// Label used for the embedded Jellyfin child webview.
const JELLYFIN_LABEL: &str = "jellyfin-embed";

/// Prefix used to signal a play request from the injected page script.
const PLAY_PREFIX: &str = "ynotv-jf:play:";

/// How long after hiding the webview to wait before an idle mpv status can
/// re-show it. Skips the brief "core idle" blip that precedes buffering of a
/// freshly loaded stream.
const RE_SHOW_COOLDOWN: Duration = Duration::from_secs(4);

/// Minimum interval between `/Sessions/Playing/Progress` reports (the Jellyfin
/// web client itself reports roughly every 10s).
const PROGRESS_INTERVAL: Duration = Duration::from_secs(8);

/// Managed state: remembers whether the Jellyfin child webview is open, when it
/// was last hidden for playback, whether the mpv-status listener is wired, and
/// the active playback-reporting session (when a Jellyfin stream plays through
/// mpv, we report position/pause/stop to the server so resume points and the
/// dashboard stay accurate).
#[derive(Default)]
pub struct JellyfinEmbedState {
    open: Mutex<bool>,
    last_hidden_at: Mutex<Option<Instant>>,
    status_listener_registered: AtomicBool,
    report: Mutex<Option<JellyfinReportSession>>,
}

/// Live playback-reporting session for a Jellyfin stream playing through mpv.
#[derive(Clone)]
struct JellyfinReportSession {
    /// e.g. `http://localhost:8096`
    server_base: String,
    api_key: String,
    item_id: String,
    media_source_id: Option<String>,
    /// Resume position carried in by the stream URL (`startTimeTicks`).
    start_ticks: u64,
    /// Client-generated id the server uses to tie start/progress/stop together.
    play_session_id: String,
    /// Position (100ns units) of the last report we actually sent.
    last_report_ticks: u64,
    last_report_at: Instant,
    /// Playing state (as reported to the server) for pause/unpause events.
    last_was_playing: Option<bool>,
    stopped: bool,
}

/// Shared HTTP client for Jellyfin API calls (avoids building one per report).
fn http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// Parse a direct-stream URL like
/// `http://host:8096/Videos/{itemId}/stream.mkv?...&api_key=...&startTimeTicks=...`
/// into `(server_base, api_key, item_id, media_source_id, start_ticks)`.
fn parse_play_url(url: &str) -> Option<(String, String, String, Option<String>, u64)> {
    let u = tauri::Url::parse(url).ok()?;
    let host = u.host_str()?;
    let server_base = match u.port() {
        Some(p) => format!("{}://{}:{}", u.scheme(), host, p),
        None => format!("{}://{}", u.scheme(), host),
    };
    let segs: Vec<&str> = u.path().split('/').collect();
    // /Videos/{id}/... or /Audio/{id}/...
    if segs.len() < 3 || (segs[1] != "Videos" && segs[1] != "Audio") {
        return None;
    }
    let item_id = segs[2].to_string();
    let pairs: Vec<(String, String)> = u
        .query_pairs()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    let api_key = pairs
        .iter()
        .find(|(k, _)| k == "api_key")
        .map(|(_, v)| v.clone())
        .unwrap_or_default();
    let media_source_id = pairs
        .iter()
        .find(|(k, _)| k == "mediaSourceId")
        .map(|(_, v)| v.clone());
    let start_ticks = pairs
        .iter()
        .find(|(k, _)| k == "startTimeTicks")
        .and_then(|(_, v)| v.parse::<u64>().ok())
        .unwrap_or(0);
    Some((server_base, api_key, item_id, media_source_id, start_ticks))
}

/// Fire-and-forget POST to the Jellyfin session API.
fn post_jellyfin(path: String, server_base: String, api_key: String, body: serde_json::Value) {
    tauri::async_runtime::spawn(async move {
        let url = format!("{}{}", server_base, path);
        let send = http_client()
            .post(&url)
            .header("X-Emby-Token", api_key)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await;
        if let Err(e) = send {
            log::debug!("[Jellyfin] API report to {} failed: {}", url, e);
        }
    });
}

/// POST /Sessions/Playing — start a playback session (what makes the item show
/// as "now playing" on the server and seeds its resume position).
fn report_start(s: &JellyfinReportSession) {
    let body = serde_json::json!({
        "ItemId": s.item_id,
        "MediaSourceId": s.media_source_id.clone().unwrap_or_default(),
        "PositionTicks": s.start_ticks,
        "IsPaused": false,
        "PlayMethod": "DirectPlay",
        "PlaySessionId": s.play_session_id,
        "PlaybackStartTimeTicks": s.start_ticks,
        "VolumeLevel": 100,
    });
    post_jellyfin(
        "/Sessions/Playing".into(),
        s.server_base.clone(),
        s.api_key.clone(),
        body,
    );
}

/// POST /Sessions/Playing/Progress — periodic position updates + explicit
/// pause/unpause events.
fn report_progress(s: &JellyfinReportSession, pos_ticks: u64, event: &str, is_paused: bool) {
    let body = serde_json::json!({
        "ItemId": s.item_id,
        "MediaSourceId": s.media_source_id.clone().unwrap_or_default(),
        "PositionTicks": pos_ticks,
        "IsPaused": is_paused,
        "PlayMethod": "DirectPlay",
        "PlaySessionId": s.play_session_id,
        "PlaybackStartTimeTicks": s.start_ticks,
        "EventName": event,
    });
    post_jellyfin(
        "/Sessions/Playing/Progress".into(),
        s.server_base.clone(),
        s.api_key.clone(),
        body,
    );
}

/// POST /Sessions/Playing/Stopped — final position when playback ends.
fn report_stopped(s: &JellyfinReportSession, pos_ticks: u64) {
    let body = serde_json::json!({
        "ItemId": s.item_id,
        "MediaSourceId": s.media_source_id.clone().unwrap_or_default(),
        "PositionTicks": pos_ticks,
        "PlaySessionId": s.play_session_id,
        "Failed": false,
    });
    post_jellyfin(
        "/Sessions/Playing/Stopped".into(),
        s.server_base.clone(),
        s.api_key.clone(),
        body,
    );
}

/// Deserialize the play payload that the injected script writes to
/// `document.title`.
#[derive(serde::Deserialize)]
struct PlayPayload {
    url: String,
    #[allow(dead_code)]
    position_ticks: Option<u64>,
    title: Option<String>,
    item_id: Option<String>,
    media_source_id: Option<String>,
    subtitle_stream_id: Option<i64>,
    subtitle_url: Option<String>,
    subtitle_tracks: Option<Vec<serde_json::Value>>,
}

/// Remove an existing Jellyfin embed child webview, if present.
fn close_existing<R: Runtime>(app: &AppHandle<R>) {
    if let Some(wv) = app.get_webview(JELLYFIN_LABEL) {
        let _ = wv.close();
    }
}

/// Wire the one-time app-wide listener that, while a Jellyfin stream plays
/// through mpv, (a) reports position/pause/stop to the Jellyfin API so resume
/// positions and the dashboard stay accurate, and (b) tells the frontend when
/// playback has ended so the Jellyfin page can be restored.
fn ensure_status_listener<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<JellyfinEmbedState>();
    if state
        .status_listener_registered
        .swap(true, Ordering::SeqCst)
    {
        return;
    }

    let listener_app = app.clone();
    let _ = app.listen("mpv-status", move |event| {
        let value = match serde_json::from_str::<serde_json::Value>(event.payload()) {
            Ok(v) => v,
            Err(_) => return,
        };
        let idle = value
            .get("coreIdle")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let playing = value
            .get("playing")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let position = value
            .get("position")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);

        // ---- 1. Jellyfin API progress reporting (only for Jellyfin sessions) ----
        {
            let state = listener_app.state::<JellyfinEmbedState>();
            let mut guard = state.report.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(session) = guard.as_mut() {
                // MPV can briefly report position=0 while the stream is
                // loading or immediately after a seek. Never let that transient
                // value overwrite Jellyfin's authoritative start position.
                let reported_position_ticks = (position * 10_000_000.0).max(0.0) as u64;
                let pos_ticks = if reported_position_ticks == 0 && session.last_report_ticks > 0 {
                    session.last_report_ticks
                } else {
                    reported_position_ticks
                };
                if session.stopped {
                    // Stop already sent — drop the session.
                    *guard = None;
                } else if idle && !playing {
                    session.stopped = true;
                    session.last_report_ticks = pos_ticks;
                    let snap = session.clone();
                    drop(guard);
                    report_stopped(&snap, pos_ticks);
                } else {
                    let now = Instant::now();
                    let since = now.duration_since(session.last_report_at);
                    let was_playing = session.last_was_playing.unwrap_or(true);
                    let event = if playing && !was_playing {
                        Some(("unpause", false))
                    } else if !playing && was_playing {
                        Some(("pause", true))
                    } else if playing && since >= PROGRESS_INTERVAL {
                        Some(("timeupdate", false))
                    } else {
                        None
                    };
                    if let Some((name, is_paused)) = event {
                        session.last_report_at = now;
                        session.last_report_ticks = pos_ticks;
                        session.last_was_playing = Some(playing);
                        let snap = session.clone();
                        drop(guard);
                        report_progress(&snap, pos_ticks, name, is_paused);
                    }
                }
            }
        }

        // ---- 2. Idle -> playback-ended signal (existing re-show gating) ----
        if !idle || playing {
            return;
        }
        let state = listener_app.state::<JellyfinEmbedState>();
        let was_watching_jellyfin = {
            let mut last = state
                .last_hidden_at
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let active = match *last {
                Some(t) => t.elapsed() >= RE_SHOW_COOLDOWN,
                None => false,
            };
            if active {
                *last = None;
            }
            active
        };
        if !was_watching_jellyfin {
            return;
        }
        let _ = listener_app.emit(
            "jellyfin:playback-state",
            serde_json::json!({ "playing": false }),
        );
    });
}

/// Open (or re-open) the embedded Jellyfin child WebView at the given logical
/// bounds, with the Jellyfin media-hijack init script injected.
#[tauri::command]
pub async fn jellyfin_embed_open<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    close_existing(&app);

    ensure_status_listener(&app);

    let window = app
        .get_window("main")
        .ok_or("main window not found")?;

    let parsed_url = url.parse::<tauri::Url>().map_err(|e| e.to_string())?;
    if parsed_url.scheme() != "http" && parsed_url.scheme() != "https" {
        return Err("Jellyfin URL must use http:// or https://".into());
    }

    let webview_builder =
        tauri::webview::WebviewBuilder::new(JELLYFIN_LABEL, WebviewUrl::External(parsed_url))
            .initialization_script(INIT_SCRIPT)
            .on_document_title_changed(move |wv, title| {
                if let Some(raw) = title.strip_prefix(PLAY_PREFIX) {
                    match serde_json::from_str::<PlayPayload>(raw.trim()) {
                        Ok(payload) => {
                            // Forward the captured stream URL to the frontend,
                            // which drives it through the app's normal VOD play
                            // pipeline (fullscreen player view, Now Playing bar,
                            // mpv error handling). The frontend destroys the
                            // child WebView once playback actually starts.
                            let app = wv.app_handle().clone();
                            let _ = app.emit(
                                "jellyfin:play",
                                serde_json::json!({
                                    "url": payload.url,
                                    "title": payload.title.clone().unwrap_or_default(),
                                    "itemId": payload.item_id,
                                    "mediaSourceId": payload.media_source_id,
                                    "subtitleStreamId": payload.subtitle_stream_id,
                                    "subtitleUrl": payload.subtitle_url,
                                    "subtitleTracks": payload.subtitle_tracks,
                                }),
                            );
                            log::info!("[Jellyfin] Play request forwarded to frontend");
                        }
                        Err(e) => {
                            log::error!("[Jellyfin] Failed to parse play payload: {}", e);
                        }
                    }
                }
            });

    let child = window
        .add_child(
            webview_builder,
            Position::Logical(LogicalPosition::new(x, y)),
            Size::Logical(LogicalSize::new(width, height)),
        )
        .map_err(|e| e.to_string())?;

    child
        .set_auto_resize(false)
        .map_err(|e| e.to_string())?;

    if let Ok(mut guard) = app.state::<JellyfinEmbedState>().open.lock() {
        *guard = true;
    }

    log::info!(
        "[Jellyfin] Embed opened at {}x{} @ ({}, {})",
        width,
        height,
        x,
        y
    );
    Ok(())
}

/// Reposition / resize the embedded Jellyfin child WebView (e.g. on window
/// resize or when the toolbar height changes).
#[tauri::command]
pub async fn jellyfin_embed_resize<R: Runtime>(
    app: AppHandle<R>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let child = app
        .get_webview(JELLYFIN_LABEL)
        .ok_or("Jellyfin embed not open")?;

    child
        .set_position(Position::Logical(LogicalPosition::new(x, y)))
        .map_err(|e| e.to_string())?;
    child
        .set_size(Size::Logical(LogicalSize::new(width, height)))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Close the embedded Jellyfin child WebView.
#[tauri::command]
pub async fn jellyfin_embed_close<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    close_existing(&app);
    if let Ok(mut guard) = app.state::<JellyfinEmbedState>().open.lock() {
        *guard = false;
    }
    Ok(())
}

/// Hide or reveal the embedded Jellyfin child WebView without destroying it.
#[tauri::command]
pub async fn jellyfin_embed_set_visible<R: Runtime>(
    app: AppHandle<R>,
    visible: bool,
) -> Result<(), String> {
    if let Some(child) = app.get_webview(JELLYFIN_LABEL) {
        if visible {
            child.show().map_err(|e| e.to_string())?;
        } else {
            child.hide().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// True when the embedded Jellyfin child WebView currently exists.
#[tauri::command]
pub async fn jellyfin_embed_is_open<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    Ok(app.get_webview(JELLYFIN_LABEL).is_some())
}

/// Called by the frontend after it has driven the handed-off stream into mpv
/// (via the app's normal play pipeline). Records the handoff time so the
/// mpv-status idle listener can gate its "playback ended" signal, starts a
/// Jellyfin playback-reporting session for the stream (resume positions +
/// dashboard), and re-asserts the full-window video surface geometry so the
/// freshly loaded stream is guaranteed sized/positioned.
#[tauri::command]
pub async fn jellyfin_confirm_playback<R: Runtime>(
    app: AppHandle<R>,
    url: String,
) -> Result<(), String> {
    let state = app.state::<JellyfinEmbedState>();
    *state
        .last_hidden_at
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());

    match parse_play_url(&url) {
        Some((server_base, api_key, item_id, media_source_id, start_ticks)) => {
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let session = JellyfinReportSession {
                server_base,
                api_key,
                item_id: item_id.clone(),
                media_source_id,
                start_ticks,
                play_session_id: format!("ynotv-{}", now_ms),
                last_report_ticks: start_ticks,
                last_report_at: Instant::now(),
                last_was_playing: Some(true),
                stopped: false,
            };

            // Close out any previous unreported session first.
            let mut guard = state.report.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(prev) = guard.take() {
                if !prev.stopped {
                    let prev_snap = prev.clone();
                    drop(guard);
                    report_stopped(&prev_snap, prev_snap.last_report_ticks);
                    guard = state.report.lock().unwrap_or_else(|e| e.into_inner());
                }
            }
            *guard = Some(session.clone());
            drop(guard);

            report_start(&session);
            log::info!("[Jellyfin] Reporting playback for item {}", item_id);
        }
        None => {
            log::warn!("[Jellyfin] Could not parse play URL — skipping server progress reporting");
        }
    }

    let _ = crate::mpv_set_geometry(app.clone(), 0, 0, 0, 0).await;
    Ok(())
}

/// Tell the injected page script to un-hijack its media elements and let
/// Jellyfin's own web player take over (used when the mpv handoff failed, so
/// the page stays fully usable).
#[tauri::command]
pub async fn jellyfin_embed_reenable<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(wv) = app.get_webview(JELLYFIN_LABEL) {
        let _ = wv.eval("window.__ynotvJfReenable && window.__ynotvJfReenable()");
    }
    Ok(())
}

/// The init script injected into the Jellyfin page before it boots.
///
/// Jellyfin 10.10 removed the `window.playbackManager` / `window.playerManager`
/// globals (the manager is a webpack-module singleton now), so the old
/// manager-hook approach no longer intercepts anything. Instead we hook at the
/// media-element level — the one choke point every Jellyfin web version has:
///
///  1. Patch `HTMLMediaElement.prototype.play` and watch the DOM (MutationObserver
///     + polling) for `<video>` / `<audio>` elements.
///  2. When an element's `currentSrc` points at the Jellyfin server
///     (`/Videos/...` / `/Audio/...` direct stream), capture the URL, write it
///     to `document.title` (with our `ynotv-jf:play:` prefix), pause + blank the
///     element, and keep it paused via a guard interval so Jellyfin's own
///     player cannot actually play.
///  3. `play()` on a hijacked element returns a pending promise so Jellyfin's
///     player waits forever instead of surfacing a playback error.
///
/// Non-Jellyfin media (e.g. YouTube trailers in embeds, blob:/MSE sources) is
/// left untouched. If the Rust side fails to load the stream in mpv it calls
/// `window.__ynotvJfReenable()` to un-hijack elements for the next attempt.
const INIT_SCRIPT: &str = r##"
(function () {
    if (window.__ynotvJfHooked) return;
    window.__ynotvJfHooked = true;

    var SIGNAL = "ynotv-jf:play:";
    var lastSignalKey = null;
    var lastSignalAt = 0;
    var warned = false;

    function warn(msg) {
        if (!warned && window.console && console.warn) {
            warned = true;
            console.warn("[ynotv-jf]", msg);
        }
    }

    function itemTitle() {
        try {
            var t = (document.title || "").replace(/\s*-\s*Jellyfin\s*$/i, "");
            return (t || "").trim();
        } catch (e) {
            return "";
        }
    }

    function signal(payload) {
        try { document.title = SIGNAL + JSON.stringify(payload); } catch (e) {}
    }

    function pickApiClient() {
        return window.ApiClient ||
            window.apiClient ||
            (window.connectionManager && window.connectionManager.apiClient) ||
            null;
    }

    function serverOrigin() {
        try {
            var api = pickApiClient();
            if (api && typeof api.serverAddress === "function") {
                var a = api.serverAddress();
                if (a) { try { return new URL(a).origin; } catch (e) {} }
            }
        } catch (e) {}
        try { return new URL(window.location.origin).origin; } catch (e) {}
        return window.location.origin;
    }

    function subtitleStreamInfo(elem) {
        try {
            var api = pickApiClient();
            var itemId = null;
            var mediaSourceId = null;
            var selected = null;
            // Jellyfin exposes the playback options on the media element in
            // some versions; use them when available, otherwise derive the
            // external subtitle URL from the selected track's src.
            var tracks = elem && elem.textTracks ? elem.textTracks : [];
            for (var i = 0; i < tracks.length; i++) {
                if (tracks[i].mode === 'showing' && tracks[i].src) {
                    selected = tracks[i];
                    break;
                }
            }
            if (!selected && tracks.length) selected = tracks[0];
            var subtitleUrl = selected && selected.src ? selected.src : null;
            var m = (elem && (elem.currentSrc || elem.src || '')).match(/\\/Videos\\/([^/]+)/i);
            if (m) itemId = m[1];
            var sourceMatch = (elem && (elem.currentSrc || elem.src || '')).match(/[?&]mediaSourceId=([^&]+)/i);
            if (sourceMatch) mediaSourceId = decodeURIComponent(sourceMatch[1]);
            var subtitleTracks = [];
            // Jellyfin renders external tracks as <track> elements. Preserve
            // every track so the native MPV selector can expose them later.
            var nodes = elem && elem.querySelectorAll ? elem.querySelectorAll('track') : [];
            for (var j = 0; j < nodes.length; j++) {
                var node = nodes[j];
                var kind = (node.kind || '').toLowerCase();
                if (kind && kind !== 'subtitles' && kind !== 'captions') continue;
                subtitleTracks.push({
                    index: j,
                    title: node.label || '',
                    lang: node.srclang || '',
                    isExternal: true,
                    deliveryUrl: node.src || '',
                    selected: node.default === true,
                    default: node.default === true
                });
            }
            return { itemId: itemId, mediaSourceId: mediaSourceId, subtitleUrl: subtitleUrl, subtitleStreamId: null, subtitleTracks: subtitleTracks };
        } catch (e) { return {}; }
    }

    function accessToken() {
        try {
            var api = pickApiClient();
            if (api && typeof api.accessToken === "function") {
                var t = api.accessToken();
                if (t) return t;
            }
        } catch (e) {}
        try {
            var raw = localStorage.getItem("jellyfin_credentials");
            if (raw) {
                var list = JSON.parse(raw);
                if (Array.isArray(list) && list[0]) return list[0].AccessToken || list[0].accessToken || "";
            }
        } catch (e) {}
        return "";
    }

    function isJellyfinStreamUrl(rawUrl) {
        if (!rawUrl || typeof rawUrl !== "string") return false;
        if (rawUrl.indexOf("blob:") === 0 || rawUrl.indexOf("data:") === 0) return false;
        var u;
        try { u = new URL(rawUrl); } catch (e) { return false; }
        if (u.protocol !== "http:" && u.protocol !== "https:") return false;
        if (u.pathname.indexOf("/Videos/") === -1 && u.pathname.indexOf("/Audio/") === -1) return false;
        try {
            return u.origin === new URL(serverOrigin()).origin;
        } catch (e) { return false; }
    }

    // Jellyfin normally applies a saved resume point by seeking the media
    // element; it is not always encoded in the stream URL. Capture the
    // element's currentTime at the play() boundary and carry it to mpv as
    // startTimeTicks. A URL/hash value wins when the server already supplied
    // one, while currentTime is the fallback for the normal web-client path.
    function buildPlayableUrl(rawUrl, elem) {
        var u = new URL(rawUrl);
        var startTicks = 0;
        var existingTicks = parseInt(u.searchParams.get("startTimeTicks") || "0", 10);
        if (isFinite(existingTicks) && existingTicks > 0) {
            startTicks = existingTicks;
        } else if (u.hash && u.hash.indexOf("#t=") === 0) {
            var secs = parseFloat(u.hash.slice(3));
            if (isFinite(secs) && secs > 0) startTicks = Math.round(secs * 10000000);
        } else {
            try {
                var currentTime = Number(elem && elem.currentTime);
                if (isFinite(currentTime) && currentTime > 0) {
                    startTicks = Math.round(currentTime * 10000000);
                }
            } catch (e) {}
        }
        u.hash = "";
        if (startTicks > 0 && (!u.searchParams.has("startTimeTicks") || existingTicks <= 0)) {
            u.searchParams.set("startTimeTicks", String(startTicks));
        }
        if (!u.searchParams.has("api_key")) {
            var token = accessToken();
            if (token) u.searchParams.append("api_key", token);
        }
        return { url: u.toString(), position_ticks: startTicks > 0 ? startTicks : null };
    }

    function blankMedia(elem) {
        try { elem.pause(); } catch (e) {}
        try { elem.removeAttribute("src"); if (elem.load) elem.load(); } catch (e) {}
        if (elem.__ynotvGuardTimer) return;
        // htmlVideoPlayer may re-assign src after 'emptied' — keep it paused
        // until the element leaves the DOM.
        var guard = setInterval(function () {
            try { elem.pause(); } catch (e) {}
            if (!elem.isConnected) clearInterval(guard);
        }, 200);
        setTimeout(function () { clearInterval(guard); }, 600000);
        elem.__ynotvGuardTimer = guard;
    }

    function releaseMedia(elem) {
        elem.__ynotvHandled = false;
        elem.__ynotvLastSrc = null;
        elem.__ynotvSignaled = false;
        if (elem.__ynotvGuardTimer) {
            clearInterval(elem.__ynotvGuardTimer);
            elem.__ynotvGuardTimer = null;
        }
    }

    function captureMedia(elem, fromPlay) {
        if (!elem) return false;
        var src;
        try { src = elem.currentSrc || elem.src || ""; } catch (e) { src = ""; }

        if (!isJellyfinStreamUrl(src)) {
            // Switched away from a Jellyfin stream on a hijacked element
            // (e.g. trailer or next-item edge) — let it play normally.
            if (elem.__ynotvHandled) releaseMedia(elem);
            return false;
        }

        var sameHandled = elem.__ynotvHandled && elem.__ynotvLastSrc === src;
        // DOM scans can see the URL before Jellyfin has applied its saved
        // currentTime. Do not signal or blank during a scan; wait for the
        // patched play() call, where the resume seek has normally completed.
        if (sameHandled && (!fromPlay || elem.__ynotvSignaled)) return true;
        if (elem.__ynotvHandled && !sameHandled) releaseMedia(elem);

        if (!elem.__ynotvHandled) {
            elem.__ynotvHandled = true;
            elem.__ynotvLastSrc = src;
            elem.__ynotvSignaled = false;
        }
        if (!fromPlay) return true;

        var built;
        try { built = buildPlayableUrl(src, elem); } catch (e) { return false; }

        blankMedia(elem);

        var key = built.url + "|" + built.position_ticks;
        var now = Date.now();
        var subtitle = subtitleStreamInfo(elem);
        if (key === lastSignalKey && now - lastSignalAt < 10000) {
            elem.__ynotvSignaled = true;
            return true;
        }
        lastSignalKey = key;
        lastSignalAt = now;
        elem.__ynotvSignaled = true;
        signal({
            url: built.url,
            position_ticks: built.position_ticks,
            title: itemTitle(),
            item_id: subtitle.itemId,
            media_source_id: subtitle.mediaSourceId,
            subtitle_stream_id: subtitle.subtitleStreamId,
            subtitle_url: subtitle.subtitleUrl,
            subtitle_tracks: subtitle.subtitleTracks
        });
        return true;
    }

    function scanMedia(root) {
        var list;
        try { list = root.querySelectorAll ? root.querySelectorAll("video,audio") : []; } catch (e) { return; }
        for (var i = 0; i < list.length; i++) captureMedia(list[i], false);
    }

    function installDomWatcher() {
        scanMedia(document);
        var mo = null;
        try {
            mo = new MutationObserver(function (muts) {
                for (var i = 0; i < muts.length; i++) {
                    var m = muts[i];
                    if (m.type === "attributes") {
                        var t = m.target;
                        if (t && (t.tagName === "VIDEO" || t.tagName === "AUDIO")) captureMedia(t, false);
                        continue;
                    }
                    var nodes = m.addedNodes || [];
                    for (var j = 0; j < nodes.length; j++) {
                        var n = nodes[j];
                        if (!n || n.nodeType !== 1) continue;
                        if (n.tagName === "VIDEO" || n.tagName === "AUDIO") captureMedia(n, false);
                        scanMedia(n);
                    }
                }
            });
        } catch (e) {}
        if (mo) {
            mo.observe(document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ["src"]
            });
        }
        // Property-set src doesn't change the attribute, so poll as a fallback.
        setInterval(function () { scanMedia(document); }, 300);
    }

    // The play() choke point: htmlVideoPlayer assigns src then calls play().
    // Return a pending promise so Jellyfin's own player waits forever instead
    // of surfacing a playback error for media we've handed to mpv.
    (function patchPlay() {
        try {
            var orig = HTMLMediaElement.prototype.play;
            if (!orig || orig.__ynotvPatched) return;
            var wrapper = function () {
                if (captureMedia(this, true)) {
                    this.__ynotvHandled = true;
                    return new Promise(function () {});
                }
                return orig.apply(this, arguments);
            };
            wrapper.__ynotvPatched = true;
            HTMLMediaElement.prototype.play = wrapper;
        } catch (e) {}
    })();

    window.__ynotvJfReenable = function () {
        try {
            var els = document.querySelectorAll("video,audio");
            for (var i = 0; i < els.length; i++) releaseMedia(els[i]);
        } catch (e) {}
        warn("re-enabled Jellyfin web player after failed mpv handoff");
    };

})();
"##;