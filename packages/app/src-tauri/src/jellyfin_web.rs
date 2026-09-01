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

/// Prefix used to signal a play request from the injected page script. The
/// title itself only carries this tiny marker — the full payload lives in the
/// page (window + localStorage), because the browser truncates document.title
/// at ~4096 chars and large payloads (episode lists, chapters, track URLs) get
/// cut mid-JSON, killing the handoff. Rust responds to the marker by starting
/// a chunked stop-and-wait flush: each payload chunk is written to the title,
/// Rust acks it by evaling the next chunk out, and the last chunk triggers the
/// normal play forwarding.
const PLAY_PREFIX: &str = "ynotv-jf:play:";

/// Prefix of the per-chunk title writes (`ynotv-jf:chunk:<i>/<total>:<data>`).
const CHUNK_PREFIX: &str = "ynotv-jf:chunk:";

/// Max payload bytes per title write (document.title caps at ~4096 chars).
const CHUNK_SIZE: usize = 3000;

/// Evaled when a play marker arrives: splits the pending payload into chunks
/// and writes chunk 0 to the title.
const PLAY_START_CHUNK_SCRIPT: &str = "(function(){var v=window.__ynotvPendingPayload;if(!v){try{v=localStorage.getItem('ynotv_jf_pending')}catch(e){}}if(!v)return;try{localStorage.removeItem('ynotv_jf_pending')}catch(e){}window.__ynotvPendingPayload=v;var c=[];for(var i=0;i<v.length;i+=3000)c.push(v.slice(i,i+3000));window.__ynotvChunks=c;window.__ynotvChunkIndex=0;document.title='ynotv-jf:chunk:0/'+c.length+':'+c[0];})();";

/// Evaled after chunk i arrives: writes chunk i+1 (if any) to the title.
const PLAY_NEXT_CHUNK_SCRIPT: &str = "(function(){var c=window.__ynotvChunks||[];var i=(window.__ynotvChunkIndex||0)+1;if(i>=c.length)return;window.__ynotvChunkIndex=i;document.title='ynotv-jf:chunk:'+i+'/'+c.length+':'+c[i];})();";

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
    /// Reassembled chunks of the in-flight play payload (chunked title flush).
    chunk_parts: Mutex<Vec<String>>,
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
    poster_url: Option<String>,
    audio_tracks: Option<Vec<serde_json::Value>>,
    /// Chapter markers from the item DTO (StartPositionTicks + Name), surfaced
    /// in the ynoTV seek bar during Jellyfin playback.
    chapters: Option<Vec<serde_json::Value>>,
    /// Series/episode context (header pill S/E info + prev/next episode list).
    server_url: Option<String>,
    api_key: Option<String>,
    series_id: Option<String>,
    series_name: Option<String>,
    episode_index: Option<i64>,
    episode_parent_index: Option<i64>,
    episode_name: Option<String>,
    episodes: Option<Vec<serde_json::Value>>,
    /// Remembered per-item subtitle selections (itemId -> stream index) so
    /// prev/next episodes and re-plays can start with the user's subtitle.
    subtitle_prefs: Option<serde_json::Value>,
    /// Bounded tail of recent bridge diagnostics (piggybacked so the diagnostics
    /// never race the play signal on the document.title channel).
    diags: Option<Vec<serde_json::Value>>,
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
        if let Some(wv) = listener_app.get_webview(JELLYFIN_LABEL) {
            let _ = wv.eval("window.__ynotvOnPlaybackEnded && window.__ynotvOnPlaybackEnded();");
        }
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
                if let Some(raw) = title.strip_prefix("ynotv-jf:diag:") {
                    if let Ok(payload) = serde_json::from_str::<serde_json::Value>(raw.trim()) {
                        let _ = wv.app_handle().emit("jellyfin:bridge-diagnostic", payload);
                    }
                } else if let Some(raw) = title.strip_prefix(CHUNK_PREFIX) {
                    // `i/total:<data>` — one piece of the play payload. The
                    // title channel truncates at ~4096 chars, so the page
                    // streams the payload here in chunks; each chunk is acked
                    // by evaling the next one out, and the last chunk triggers
                    // the normal play forwarding.
                    let (meta, data) = match raw.split_once(':') {
                        Some((m, d)) => (m, d),
                        None => (raw, ""),
                    };
                    let mut parts = meta.split('/');
                    let idx: usize = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
                    let total: usize = parts.next().and_then(|v| v.parse().ok()).unwrap_or(1);
                    let state = wv.app_handle().state::<JellyfinEmbedState>();
                    let mut acc = state
                        .chunk_parts
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    if idx == 0 {
                        acc.clear();
                    }
                    if acc.len() <= idx {
                        acc.resize(idx + 1, String::new());
                    }
                    acc[idx] = data.to_string();
                    if idx + 1 < total {
                        let _ = wv.eval(PLAY_NEXT_CHUNK_SCRIPT);
                    } else {
                        let full = acc.concat();
                        drop(acc);
                        match serde_json::from_str::<PlayPayload>(full.trim()) {
                            Ok(payload) => {
                                // Forward the captured stream URL + metadata to
                                // the frontend, which drives it through the
                                // app's normal VOD play pipeline (fullscreen
                                // player view, Now Playing bar, mpv error
                                // handling). The frontend destroys the child
                                // WebView once playback starts.
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
                                        "posterUrl": payload.poster_url,
                                        "audioTracks": payload.audio_tracks,
                                        "chapters": payload.chapters,
                                        "serverUrl": payload.server_url,
                                        "apiKey": payload.api_key,
                                        "seriesId": payload.series_id,
                                        "seriesName": payload.series_name,
                                        "episodeIndex": payload.episode_index,
                                        "episodeParentIndex": payload.episode_parent_index,
                                        "episodeName": payload.episode_name,
                                        "episodes": payload.episodes,
                                        "subtitlePrefs": payload.subtitle_prefs,
                                    }),
                                );
                                // Ride-along diagnostics: forward each buffered
                                // item so the main DevTools keeps its
                                // [Jellyfin bridge] log without diagnostics
                                // ever writing to the title.
                                if let Some(diags) = payload.diags {
                                    for item in diags {
                                        let _ = app.emit("jellyfin:bridge-diagnostic", item);
                                    }
                                }
                                log::info!("[Jellyfin] Play request forwarded to frontend");
                            }
                            Err(e) => {
                                log::error!("[Jellyfin] Failed to parse play payload: {}", e);
                            }
                        }
                    }
                } else if title.starts_with(PLAY_PREFIX) {
                    // Marker only: the page kept the full payload in window +
                    // localStorage (document.title truncates at ~4096 chars,
                    // which used to cut the JSON mid-string and stall
                    // playback). Start the chunked flush.
                    if let Ok(mut guard) = wv
                        .app_handle()
                        .state::<JellyfinEmbedState>()
                        .chunk_parts
                        .lock()
                    {
                        guard.clear();
                    }
                    let _ = wv.eval(PLAY_START_CHUNK_SCRIPT);
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

/// Notify the child WebView that playback in ynoTV has stopped or ended,
/// dismissing any pending loading spinner/overlay and returning the page to the
/// active item view.
#[tauri::command]
pub async fn jellyfin_embed_notify_playback_ended<R: Runtime>(
    app: AppHandle<R>,
) -> Result<(), String> {
    if let Some(wv) = app.get_webview(JELLYFIN_LABEL) {
        let _ = wv.eval("window.__ynotvOnPlaybackEnded && window.__ynotvOnPlaybackEnded();");
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
    var diagSeq = 0;
    var diagBuf = [];          // bounded; flushed inside the next play payload
    var DIAG_BUF_MAX = 400;
    var playbackInfo = null;   // latest PlaybackInfo response body

    // Diagnostics NEVER touch document.title — that is the *signal* channel,
    // and WebView2 coalesces rapid title changes, so any competing title write
    // (diag fires on every media event / 300ms poll / matching fetch) can
    // clobber the play payload before Rust's on_document_title_changed fires.
    // diag() logs to the page console and keeps a bounded in-page buffer that
    // is piggybacked onto the next play payload, so the native/frontend side
    // still sees the diagnostics that matter (the ones leading to a handoff).
    function diag(kind, data) {
        try {
            console.log('[ynoTV Jellyfin bridge]', kind, data || '');
            diagBuf.push({ kind: kind, at: Date.now(), data: data || null });
            if (diagBuf.length > DIAG_BUF_MAX) diagBuf.splice(0, diagBuf.length - DIAG_BUF_MAX);
        } catch (e) {}
    }

    // Compact tail of recent diagnostics for the play payload (bounded so the
    // title signal stays small; oversized entries are dropped until it fits).
    function diagTail() {
        var out = [];
        var budget = 2500;
        for (var i = Math.max(0, diagBuf.length - 14); i < diagBuf.length; i++) {
            var item = diagBuf[i];
            var copy = { kind: item.kind, at: item.at };
            var raw = item.data;
            if (raw !== null && raw !== undefined) {
                var s;
                try { s = typeof raw === 'string' ? raw : JSON.stringify(raw); } catch (e) { s = String(raw); }
                if (s && s.length > 300) s = s.slice(0, 300);
                if (s) copy.data = s;
            }
            var len = JSON.stringify(copy).length;
            if (len > budget) continue;
            budget -= len;
            out.push(copy);
        }
        return out;
    }

    try {
        console.log('[ynoTV Jellyfin bridge] injected');
        window.dispatchEvent(new CustomEvent('ynotv-jellyfin-bridge-ready'));
        diag('injected');
    } catch (e) {}
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
        try {
            console.log('[ynoTV Jellyfin bridge] candidate stream', payload);
            // document.title is truncated at ~4096 chars by the browser, which
            // used to cut large payloads (episode lists, chapters, track URLs)
            // mid-JSON and stall playback. Keep the full payload in the page
            // (window + localStorage) and write a tiny marker; Rust streams it
            // out in chunks, acking each one via eval.
            var json;
            try { json = JSON.stringify(payload); } catch (e) { return; }
            try { localStorage.setItem('ynotv_jf_pending', json); } catch (e) {}
            window.__ynotvPendingPayload = json;
            // Playback is now owned by ynoTV: stop remembering SPA routes until
            // the page is recreated fresh.
            window.__ynotvPlaybackActive = true;
            document.title = SIGNAL;
        } catch (e) {}
    }

    // Remember the SPA route (excluding player routes) so a recreated child
    // WebView — tab switches close the child, and a hidden WebView2 surface can
    // come back blank — restores the page the user was on instead of the home
    // page. The route is restored only when the fresh page is still on the app
    // root, so it never yanks the user away from a page they already navigated
    // to.
    var ROUTE_KEY = "ynotv_jf_route";
    function saveRoute() {
        try {
            var h = location.hash || "";
            if (!h) return;
            if (/videoosd/i.test(h)) return; // never remember the player screen
            // While a ynoTV handoff is active the child WebView is hidden but
            // still running — Jellyfin's blanked player frequently auto-
            // navigates back to home, which would clobber the item route saved
            // for the return-to-tab restore. The user cannot navigate the
            // hidden page themselves, so suppress ALL saves during playback.
            if (window.__ynotvPlaybackActive) return;
            localStorage.setItem(ROUTE_KEY, h);
        } catch (e) {}
    }
    // When playback started from somewhere that was never a real SPA route
    // (e.g. the home page's Continue Watching row), synthesize the item page
    // route so Back/Stop returns to the ITEM, not the home page.
    function saveItemRoute(itemOrSeriesId) {
        try {
            if (!itemOrSeriesId) return;
            var cur = localStorage.getItem(ROUTE_KEY) || '';
            if (cur && cur !== '#/home.html' && cur !== '#/' && cur !== '') return; // an explicit browse route wins
            localStorage.setItem(ROUTE_KEY, '#/itemdetails.html?id=' + encodeURIComponent(String(itemOrSeriesId)));
        } catch (e) {}
    }
    try { window.addEventListener("hashchange", saveRoute); } catch (e) {}
    try { window.addEventListener("popstate", saveRoute); } catch (e) {}
    try {
        var origPushState = history.pushState;
        if (origPushState && !origPushState.__ynotvPatched) {
            history.pushState = function () {
                var res = origPushState.apply(this, arguments);
                saveRoute();
                return res;
            };
            history.pushState.__ynotvPatched = true;
        }
        var origReplaceState = history.replaceState;
        if (origReplaceState && !origReplaceState.__ynotvPatched) {
            history.replaceState = function () {
                var res = origReplaceState.apply(this, arguments);
                saveRoute();
                return res;
            };
            history.replaceState.__ynotvPatched = true;
        }
    } catch (e) {}
    saveRoute();
    (function restoreRoute() {
        console.log('[ynoTV Jellyfin bridge] route-restore starting');
        // localStorage may be unavailable at init-script time in some engines,
        // so read it lazily (and repeatedly) until it resolves.
        var saved = null;
        var savedRead = false;
        var bootT = Date.now();
        var WINDOW_MS = 60000;
        function readSaved() {
            if (savedRead) return saved;
            try { saved = localStorage.getItem(ROUTE_KEY); savedRead = true; } catch (e) {}
            return saved;
        }
        // NEVER touch the hash before Jellyfin has BOTH its router AND a live
        // user session. Writing a deep link (`#/itemdetails.html?id=...`) into
        // a document that is still booting — worse, at document_start, while
        // the initial navigation is pending — corrupts Jellyfin's own connect
        // flow: item views fire with a null user, `Users/null/...` requests 400,
        // the login handshake stalls and the tab is stuck on the loading page.
        // The user check uses the ACTIVE API client only (never the stored
        // credentials fallback), so we wait out boot/login before ever writing.
        function readyToNavigate() {
            try {
                if (!window.Emby || !window.Emby.Page) {
                    if (!window.AppRouter) return false;
                }
                var api = pickApiClient();
                if (!api || typeof api.getCurrentUserId !== "function") return false;
                if (!api.getCurrentUserId()) return false;
                return true;
            } catch (e) { return false; }
        }
        // The view is still the Jellyfin home page (by page element class, or
        // by document.title as a fallback). Used to distinguish "router missed
        // our hash" from "the user navigated somewhere else".
        function viewNotHome() {
            try {
                var pages = document.querySelectorAll('[data-role="page"]');
                for (var i = 0; i < pages.length; i++) {
                    var p = pages[i];
                    var cls = (p.className || '');
                    if (/\bhomePage\b/.test(cls)) continue;
                    // Boot/login/loading surfaces are not real destinations.
                    if (/\b(loginPage|selectServerPage|splash|startup|wizard|error)\b/i.test(cls)) continue;
                    // Only consider VISIBLE pages (hidden ones are stale DOM).
                    try {
                        if (p.getBoundingClientRect) {
                            var r = p.getBoundingClientRect();
                            if (r && !r.width && !r.height) continue;
                        } else if (p.offsetWidth === 0 && p.offsetHeight === 0) {
                            continue;
                        }
                    } catch (e) {}
                    if (/\b(itemDetailPage|collectionPage|libraryPage|personPage|userProfilePage)\b/.test(cls)) return true;
                }
            } catch (e) {}
            try {
                var t = (document.title || '');
                if (/ - Jellyfin\s*$/i.test(t) && !/^\s*(home|start)\s*-/i.test(t)) return true;
            } catch (e) {}
            return false;
        }
        var kicks = 0;
        var KICK_MAX = 90;
        var straySince = 0;
        // A synchronous "#/" -> target pair yields a fresh hashchange the
        // (now-ready) router actually handles, even if the first attempt raced
        // its boot and the event was consumed by nobody.
        function kickTo(target) {
            kicks++;
            try {
                var cleanTarget = target.replace(/^#\/?/, '');
                if (window.AppRouter && typeof window.AppRouter.show === "function") {
                    window.AppRouter.show(cleanTarget);
                    return;
                }
                if (window.Emby && window.Emby.Page && typeof window.Emby.Page.show === "function") {
                    window.Emby.Page.show(cleanTarget);
                    return;
                }
            } catch (e) {}
            location.hash = "#/";
            location.hash = target;
        }
        var logged = {};
        function logOnce(key) {
            if (logged[key]) return;
            logged[key] = true;
            console.log('[ynoTV Jellyfin bridge] route-restore', key);
        }
        function attempt() {
            try {
                if (!readyToNavigate()) { logOnce('waiting-for-boot'); return; }
                var target = readSaved();
                if (!target) { logOnce('no-saved-route'); return; }
                var cur = location.hash || "";
                var notHome = viewNotHome();
                if (cur === target) {
                    if (notHome) { logOnce('done-view-rendered'); done = true; return; }
                    if (kicks < KICK_MAX && Date.now() - bootT < WINDOW_MS) { kickTo(target); return; }
                    logOnce('done-gave-up');
                    done = true;
                    return;
                }
                if (cur === "" || cur === "#/" || cur === "#/home.html") {
                    // Rootish — apply the saved route; later ticks re-assert it
                    // via the kick path while the view is still home.
                    logOnce('applying target=' + target);
                    kickTo(target);
                    straySince = 0;
                    return;
                }
                if (!notHome) {
                    // Stray hash but the view is still unmistakably home (a
                    // missed handler or Jellyfin's own boot nav). Re-assert only
                    // after the stray persisted briefly, so a fresh user click
                    // that hasn't rendered yet isn't yanked back.
                    if (!straySince) straySince = Date.now();
                    if (kicks < KICK_MAX && Date.now() - bootT < WINDOW_MS && Date.now() - straySince > 2000) {
                        straySince = 0;
                        logOnce('re-asserting cur=' + cur);
                        kickTo(target);
                    }
                    return;
                }
                logOnce('done-user-navigated cur=' + cur);
                done = true; // view left home on its own — user navigated or router rendered
            } catch (e) {}
        }
        var done = false;
        var iv = setInterval(function () {
            if (done) { clearInterval(iv); return; }
            if (Date.now() - bootT > WINDOW_MS) { clearInterval(iv); return; }
            attempt();
        }, 400);
        setTimeout(function () { try { clearInterval(iv); } catch (e) {} }, WINDOW_MS + 5000);
    })();

    // Remember the subtitle the user actually watched with per Jellyfin item
    // (stream index keyed by item id, persisted in this webview's own
    // localStorage) so a later play/restart of the same item starts with the
    // same subtitle even when Jellyfin's server default didn't pick it.
    var SUBPREF_KEY = 'ynotv_jf_subprefs';
    function readSubPref(itemId) {
        try {
            if (!itemId) return null;
            var raw = localStorage.getItem(SUBPREF_KEY);
            if (!raw) return null;
            var map = JSON.parse(raw);
            var v = map && map[itemId];
            return typeof v === 'number' ? v : null;
        } catch (e) { return null; }
    }
    function readAllSubPrefs() {
        try {
            var raw = localStorage.getItem(SUBPREF_KEY);
            if (!raw) return {};
            var map = JSON.parse(raw);
            return map && typeof map === 'object' ? map : {};
        } catch (e) { return {}; }
    }
    function rememberSubPref(itemId, streamIndex) {
        try {
            if (!itemId || streamIndex == null) return;
            var map = {};
            var raw = localStorage.getItem(SUBPREF_KEY);
            if (raw) { try { var parsed = JSON.parse(raw); if (parsed && typeof parsed === 'object') map = parsed; } catch (e) {} }
            map[itemId] = streamIndex;
            try { localStorage.setItem(SUBPREF_KEY, JSON.stringify(map)); } catch (e) {}
        } catch (e) {}
    }

    // Active subtitle choices made by the user in the Jellyfin web UI (dropdowns / selects)
    var activeSubChoiceByItem = {};
    var lastPlaybackInfoReq = null; // { itemId, subtitleStreamIndex, audioStreamIndex, mediaSourceId, at }

    function recordPlaybackInfoReq(url, body) {
        try {
            var u = String(url || '');
            if (!/PlaybackInfo/i.test(u)) return;
            var itemId = null;
            var m = u.match(/\/Items\/([^/?#]+)/i);
            if (m) itemId = m[1];
            var subIdx = null;
            var audioIdx = null;
            var mediaSourceId = null;

            var qm = u.match(/[?&]SubtitleStreamIndex=(-?\d+)/i);
            if (qm && qm[1] !== '') subIdx = parseInt(qm[1], 10);
            var qma = u.match(/[?&]AudioStreamIndex=(-?\d+)/i);
            if (qma && qma[1] !== '') audioIdx = parseInt(qma[1], 10);
            var qms = u.match(/[?&]MediaSourceId=([^&]+)/i);
            if (qms) mediaSourceId = decodeURIComponent(qms[1]);

            if (body) {
                var parsed = null;
                if (typeof body === 'string') {
                    try { parsed = JSON.parse(body); } catch (e) {}
                } else if (typeof body === 'object') {
                    parsed = body;
                }
                if (parsed) {
                    if (parsed.Id && !itemId) itemId = String(parsed.Id);
                    if (parsed.ItemId && !itemId) itemId = String(parsed.ItemId);
                    if (parsed.SubtitleStreamIndex !== undefined && parsed.SubtitleStreamIndex !== null) {
                        var si = parseInt(parsed.SubtitleStreamIndex, 10);
                        if (!isNaN(si)) subIdx = si;
                    }
                    if (parsed.AudioStreamIndex !== undefined && parsed.AudioStreamIndex !== null) {
                        var ai = parseInt(parsed.AudioStreamIndex, 10);
                        if (!isNaN(ai)) audioIdx = ai;
                    }
                    if (parsed.MediaSourceId) mediaSourceId = String(parsed.MediaSourceId);
                }
            }
            lastPlaybackInfoReq = {
                itemId: itemId,
                subtitleStreamIndex: subIdx,
                audioStreamIndex: audioIdx,
                mediaSourceId: mediaSourceId,
                at: Date.now()
            };
            if (itemId && subIdx !== null && subIdx !== undefined) {
                activeSubChoiceByItem[itemId] = subIdx;
                rememberSubPref(itemId, subIdx);
            }
            diag('playback-info-request', lastPlaybackInfoReq);
        } catch (e) {}
    }

    try {
        document.addEventListener('change', function (e) {
            try {
                var target = e.target;
                if (!target || target.tagName !== 'SELECT') return;
                var isSub = (target.className && /\bselectSubtitles\b/i.test(target.className)) ||
                            target.id === 'selectSubtitles' ||
                            target.getAttribute('data-track') === 'subtitle' ||
                            target.name === 'selectSubtitles' ||
                            (target.closest && target.closest('.selectSubtitles'));
                if (isSub) {
                    var val = parseInt(target.value, 10);
                    if (!isNaN(val)) {
                        var page = target.closest ? target.closest('[data-role="page"]') : null;
                        var itemId = (page && (page.getAttribute('data-itemid') || (page.dataset && page.dataset.itemid))) || null;
                        if (!itemId) {
                            var hm = (location.hash || '').match(/[?&]id=([^&]+)/i);
                            if (hm) itemId = decodeURIComponent(hm[1]);
                        }
                        if (itemId) {
                            activeSubChoiceByItem[itemId] = val;
                            rememberSubPref(itemId, val);
                        }
                        diag('in-page-sub-select-change', { itemId: itemId, val: val });
                    }
                }
            } catch (err) {}
        }, true);
    } catch (e) {}

    function getInPageSubtitleSelection(itemId) {
        try {
            if (itemId && activeSubChoiceByItem[itemId] !== undefined) {
                return activeSubChoiceByItem[itemId];
            }
            var selects = document.querySelectorAll('select.selectSubtitles, select#selectSubtitles, select[data-track="subtitle"], .selectSubtitles select');
            for (var i = 0; i < selects.length; i++) {
                var sel = selects[i];
                if (sel.offsetParent !== null || (sel.getBoundingClientRect && sel.getBoundingClientRect().width > 0)) {
                    var val = parseInt(sel.value, 10);
                    if (!isNaN(val)) return val;
                }
            }
        } catch (e) {}
        return null;
    }

    function describeMedia(elem, event) {
        try {
            return {
                event: event,
                tag: elem.tagName,
                src: elem.src || '',
                currentSrc: elem.currentSrc || '',
                attrSrc: elem.getAttribute('src') || '',
                readyState: elem.readyState,
                networkState: elem.networkState,
                currentTime: elem.currentTime
            };
        } catch (e) { return { event: event }; }
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

    function subtitleStreamInfo(elem, src) {
        try {
            var api = pickApiClient();
            diag('subtitle-metadata-scan', { hasApi: !!api, trackCount: elem && elem.textTracks ? elem.textTracks.length : 0 });
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
            // `src` is the URL captured before blankMedia() wiped the element,
            // so the item/mediaSource can always be derived from it.
            var raw = src || (elem && (elem.currentSrc || elem.src || '')) || '';
            var m = raw.match(/\/Videos\/([^/]+)/i);
            if (m) itemId = m[1];
            var sourceMatch = raw.match(/[?&]mediaSourceId=([^&]+)/i);
            if (sourceMatch) mediaSourceId = decodeURIComponent(sourceMatch[1]);
            var subtitleTracks = [];
            // Jellyfin renders external tracks as <track> elements. Preserve
            // every track so the native MPV selector can expose them later.
            var nodes = elem && elem.querySelectorAll ? elem.querySelectorAll('track') : [];
            for (var j = 0; j < nodes.length; j++) {
                var node = nodes[j];
                var kind = (node.kind || '').toLowerCase();
                if (kind && kind !== 'subtitles' && kind !== 'captions') continue;
                var delivery = node.src || '';
                if (delivery && delivery.indexOf('api_key=') === -1) {
                    var token = accessToken();
                    if (token) delivery += (delivery.indexOf('?') >= 0 ? '&' : '?') + 'api_key=' + encodeURIComponent(token);
                }
                subtitleTracks.push({
                    index: j,
                    title: node.label || '',
                    lang: node.srclang || '',
                    isExternal: true,
                    deliveryUrl: delivery,
                    selected: node.default === true,
                    default: node.default === true
                });
            }
            return { itemId: itemId, mediaSourceId: mediaSourceId, subtitleUrl: subtitleUrl, subtitleStreamId: null, subtitleTracks: subtitleTracks };
        } catch (e) { return {}; }
    }

    // Metadata derived from the captured PlaybackInfo response — the same data
    // Jellyfin's web player uses, and what jellyfin-desktop feeds into its mpv
    // player: poster URL (derived from the item), audio stream list, and the
    // authoritative subtitle track list (absolute delivery URLs + api_key).
    function playbackInfoMeta(elem, capturedSrc) {
        var meta = { posterUrl: null, audioTracks: [], subtitleTracks: [], subtitleStreamId: null };
        try {
            var src = null;
            if (playbackInfo && playbackInfo.MediaSources && playbackInfo.MediaSources.length) {
                src = playbackInfo.MediaSources[0];
            }
            var itemId = null;
            var raw = capturedSrc || (elem && (elem.currentSrc || elem.src || '')) || '';
            var m = raw.match(/\/Videos\/([^/]+)/i);
            if (m) itemId = m[1];
            if (itemId) {
                var token = accessToken();
                var base = serverOrigin();
                meta.posterUrl = base + '/Items/' + itemId + '/Images/Primary?maxWidth=400&quality=90' + (token ? '&api_key=' + encodeURIComponent(token) : '');
            }
            if (src && Array.isArray(src.MediaStreams)) {
                for (var i = 0; i < src.MediaStreams.length; i++) {
                    var st = src.MediaStreams[i];
                    if (!st || !st.Type) continue;
                    if (st.Type === 'Audio') {
                        meta.audioTracks.push({
                            index: st.Index != null ? st.Index : i,
                            title: st.DisplayTitle || st.Title || '',
                            lang: st.Language || '',
                            codec: st.Codec || '',
                            isDefault: st.IsDefault === true
                        });
                    } else if (st.Type === 'Subtitle') {
                        var isExt = st.IsExternal === true;
                        var delivery = (st.DeliveryUrl || '').trim();
                        if (delivery && delivery.indexOf('://') === -1) delivery = serverOrigin() + (delivery.charAt(0) === '/' ? '' : '/') + delivery;
                        if (delivery && delivery.indexOf('api_key=') === -1) {
                            var t2 = accessToken();
                            if (t2) delivery += (delivery.indexOf('?') >= 0 ? '&' : '?') + 'api_key=' + encodeURIComponent(t2);
                        }
                        meta.subtitleTracks.push({
                            index: st.Index != null ? st.Index : i,
                            title: st.DisplayTitle || st.Title || '',
                            lang: st.Language || '',
                            codec: st.Codec || '',
                            isExternal: isExt,
                            deliveryUrl: isExt ? delivery : '',
                            selected: false,
                            default: false
                        });
                    }
                }

                // Determine the authoritative target subtitle stream index
                var targetSubIdx = null;

                // 1. PlaybackInfo request (if recent < 15s and matches itemId)
                if (lastPlaybackInfoReq && (Date.now() - lastPlaybackInfoReq.at < 15000)) {
                    if (!itemId || !lastPlaybackInfoReq.itemId || lastPlaybackInfoReq.itemId === itemId) {
                        if (lastPlaybackInfoReq.subtitleStreamIndex !== null && lastPlaybackInfoReq.subtitleStreamIndex !== undefined) {
                            targetSubIdx = lastPlaybackInfoReq.subtitleStreamIndex;
                        }
                    }
                }

                // 2. In-page active select dropdown
                if (targetSubIdx === null && itemId) {
                    var inPageChoice = getInPageSubtitleSelection(itemId);
                    if (inPageChoice !== null && inPageChoice !== undefined) {
                        targetSubIdx = inPageChoice;
                    }
                }

                // 3. Query param on stream URL (SubtitleStreamIndex)
                if (targetSubIdx === null) {
                    var smTxt = String(capturedSrc || '');
                    var sm = smTxt.match(/[?&]SubtitleStreamIndex=(-?\d+)/i);
                    if (sm && sm[1] !== '') {
                        var smIdx = parseInt(sm[1], 10);
                        if (!isNaN(smIdx)) targetSubIdx = smIdx;
                    }
                }

                // 4. Active textTrack on element
                if (targetSubIdx === null && elem && elem.textTracks) {
                    for (var tt = 0; tt < elem.textTracks.length; tt++) {
                        if (elem.textTracks[tt].mode === 'showing') {
                            var tUrl = elem.textTracks[tt].src;
                            for (var stIdx = 0; stIdx < meta.subtitleTracks.length; stIdx++) {
                                if (meta.subtitleTracks[stIdx].isExternal && meta.subtitleTracks[stIdx].deliveryUrl && tUrl && meta.subtitleTracks[stIdx].deliveryUrl.indexOf(tUrl) >= 0) {
                                    targetSubIdx = meta.subtitleTracks[stIdx].index;
                                    break;
                                }
                            }
                            break;
                        }
                    }
                }

                // 5. Remembered user preference for this item
                if (targetSubIdx === null && itemId) {
                    var pref = readSubPref(itemId);
                    if (pref !== null && pref !== undefined) targetSubIdx = pref;
                }

                // 6. Server's DefaultSubtitleStreamIndex from PlaybackInfo response
                if (targetSubIdx === null && src.DefaultSubtitleStreamIndex != null) {
                    targetSubIdx = src.DefaultSubtitleStreamIndex;
                }

                // Apply the resolved subtitle index
                if (targetSubIdx !== null && targetSubIdx !== undefined) {
                    meta.subtitleStreamId = targetSubIdx;
                    if (targetSubIdx === -1) {
                        // Explicitly None / off
                        for (var k = 0; k < meta.subtitleTracks.length; k++) {
                            meta.subtitleTracks[k].selected = false;
                            meta.subtitleTracks[k].default = false;
                        }
                    } else {
                        for (var kk = 0; kk < meta.subtitleTracks.length; kk++) {
                            var isMatch = (meta.subtitleTracks[kk].index === targetSubIdx);
                            meta.subtitleTracks[kk].selected = isMatch;
                            meta.subtitleTracks[kk].default = isMatch;
                            if (isMatch && meta.subtitleTracks[kk].isExternal && meta.subtitleTracks[kk].deliveryUrl) {
                                meta.subtitleUrl = meta.subtitleTracks[kk].deliveryUrl;
                            }
                        }
                    }
                    if (itemId) rememberSubPref(itemId, targetSubIdx);
                }
            }
        } catch (e) {}
        return meta;
    }

    // The user may have picked a different subtitle inside Jellyfin's own
    // player before the handoff (OSD subtitle menu). Promote whichever text
    // track the web player is actually showing right now.
    function applyInPageSubtitleSelection(meta, elem, itemId) {
        try {
            if (!meta || !elem || !meta.subtitleTracks || !meta.subtitleTracks.length) return meta;
            var tracks = elem.textTracks ? elem.textTracks : [];
            var active = null;
            for (var i = 0; i < tracks.length; i++) {
                if (tracks[i].mode === 'showing') { active = tracks[i]; break; }
            }
            if (!active) return meta;

            function normUrl(u) {
                try { return (new URL(u)).pathname.replace(/\/+$/, '').toLowerCase(); } catch (e) { return (u || '').split('?')[0].replace(/\/+$/, '').toLowerCase(); }
            }
            var activePath = active.src ? normUrl(active.src) : null;
            var activeLang = (active.language || '').toLowerCase();
            var activeLabel = (active.label || '').toLowerCase();

            var matchIdx = null;
            for (var j = 0; j < meta.subtitleTracks.length; j++) {
                var t = meta.subtitleTracks[j];
                // External: same delivery URL (query strings/order may differ).
                if (activePath && t.isExternal && t.deliveryUrl && normUrl(t.deliveryUrl) === activePath) {
                    matchIdx = j;
                    break;
                }
                // Embedded: language or display title overlap.
                var tLang = (t.lang || '').toLowerCase();
                var tTitle = (t.title || '').toLowerCase();
                if (activeLang && tLang && (activeLang === tLang || activeLang.indexOf(tLang) === 0 || tLang.indexOf(activeLang) === 0)) {
                    matchIdx = j;
                    break;
                }
                if (activeLabel && tTitle && (activeLabel === tTitle || activeLabel.indexOf(tTitle) === 0 || tTitle.indexOf(activeLabel) === 0)) {
                    matchIdx = j;
                    break;
                }
            }
            if (matchIdx == null) return meta;

            for (var k = 0; k < meta.subtitleTracks.length; k++) {
                meta.subtitleTracks[k].selected = false;
                meta.subtitleTracks[k].default = false;
            }
            var picked = meta.subtitleTracks[matchIdx];
            picked.selected = true;
            picked.default = true;
            meta.subtitleStreamId = picked.index != null ? picked.index : matchIdx;
            if (picked.isExternal && picked.deliveryUrl) meta.subtitleUrl = picked.deliveryUrl;
            if (itemId) rememberSubPref(itemId, meta.subtitleStreamId);
            return meta;
        } catch (e) { return meta; }
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

    // Chapter markers live on the item DTO (the web client requests
    // Fields=Chapters when it loads playable items), not on the PlaybackInfo
    // response — so remember chapters-bearing item responses and expose a
    // bounded fallback fetch, guaranteeing the handoff payload carries
    // chapter markers for the seek bar even on a cold handoff.
    var chaptersByItem = {};
    var itemById = {};
    var episodesBySeries = {};
    function rememberItemDto(body) {
        try {
            if (!body || typeof body !== "object") return;
            if (Array.isArray(body.Chapters) && body.Id) chaptersByItem[body.Id] = body.Chapters;
            if (body.Id && (body.Name || body.SeriesId || body.IndexNumber != null || body.ParentIndexNumber != null)) {
                itemById[body.Id] = {
                    name: body.Name || "",
                    seriesId: body.SeriesId || null,
                    seriesName: body.SeriesName || null,
                    indexNumber: body.IndexNumber != null ? body.IndexNumber : null,
                    parentIndexNumber: body.ParentIndexNumber != null ? body.ParentIndexNumber : null,
                    type: body.Type || ""
                };
            }
            if (Array.isArray(body.Items)) {
                for (var i = 0; i < body.Items.length; i++) rememberItemDto(body.Items[i]);
            }
        } catch (e) {}
    }
    function chaptersFor(itemId) {
        try {
            var list = chaptersByItem[itemId];
            return Array.isArray(list) && list.length ? list : null;
        } catch (e) { return null; }
    }
    function episodesFor(seriesId) {
        try {
            var list = episodesBySeries[seriesId];
            return Array.isArray(list) && list.length ? list : null;
        } catch (e) { return null; }
    }
    // Episode lists arrive as /Shows/{seriesId}/Episodes responses when the
    // user opens a series; compact them so prev/next playback can rebuild
    // direct-play URLs for adjacent episodes.
    function rememberSeriesEpisodes(body) {
        try {
            if (!body || !Array.isArray(body.Items)) return;
            var seriesId = body.SeriesId || null;
            var list = [];
            for (var i = 0; i < body.Items.length && list.length < 150; i++) {
                var it = body.Items[i];
                if (!it || !it.Id) continue;
                if (!seriesId) seriesId = it.SeriesId || null;
                list.push({
                    id: it.Id,
                    indexNumber: it.IndexNumber != null ? it.IndexNumber : null,
                    parentIndexNumber: it.ParentIndexNumber != null ? it.ParentIndexNumber : null,
                    name: it.Name || "",
                    positionTicks: it.UserData && it.UserData.PlaybackPositionTicks ? it.UserData.PlaybackPositionTicks : 0
                });
                rememberItemDto(it);
            }
            if (seriesId && list.length) episodesBySeries[seriesId] = list;
        } catch (e) {}
    }
    function currentUserId() {
        try {
            var api = pickApiClient();
            if (api && typeof api.getCurrentUserId === "function") {
                var u = api.getCurrentUserId();
                if (u) return u;
            }
        } catch (e) {}
        try {
            var raw = localStorage.getItem("jellyfin_credentials");
            if (raw) {
                var list = JSON.parse(raw);
                if (Array.isArray(list) && list[0] && list[0].UserId) return list[0].UserId;
            }
        } catch (e) {}
        return "";
    }
    // Authoritative fallback: fetch the item DTO (Fields=Chapters) and, when it
    // is a series episode and no episode list is cached yet, the series'
    // episode list — bounded, so handoff is never blocked for long. cb receives
    // (chapters, itemInfo, episodes); any of them may be null.
    function gatherMetadata(itemId, cb, timeoutMs) {
        var uid = currentUserId();
        if (!itemId || !uid) { cb(null, null, null); return; }
        var item = itemById[itemId] || null;
        var chapters = chaptersFor(itemId);
        var episodes = item && item.seriesId ? episodesFor(item.seriesId) : null;
        if (chapters && item) { cb(chapters, item, episodes); return; }
        var token = accessToken();
        var origin = serverOrigin();
        var settled = false;
        var done = function (ch, it, eps) {
            if (!settled) { settled = true; if (typeof cb === "function") cb(ch, it, eps); }
        };
        var timer = setTimeout(function () { done(chapters, item, episodes); }, timeoutMs || 1100);
        var itemUrl = origin + "/Users/" + encodeURIComponent(uid) + "/Items/" + encodeURIComponent(itemId) + "?Fields=Chapters";
        if (token) itemUrl += "&api_key=" + encodeURIComponent(token);
        fetch(itemUrl).then(function (r) {
            if (!r.ok) { clearTimeout(timer); done(chapters, item, episodes); return; }
            return r.json();
        }).then(function (b) {
            if (b && b.Id) {
                rememberItemDto(b);
                item = itemById[b.Id] || item;
                chapters = chaptersFor(b.Id) || chapters;
            }
            if (item && item.seriesId) {
                var eps = episodesFor(item.seriesId) || episodes;
                if (!eps) {
                    var epsUrl = origin + "/Shows/" + encodeURIComponent(item.seriesId) + "/Episodes?UserId=" + encodeURIComponent(uid) + "&Fields=Chapters";
                    if (token) epsUrl += "&api_key=" + encodeURIComponent(token);
                    fetch(epsUrl).then(function (r2) {
                        if (!r2.ok) { clearTimeout(timer); done(chapters, item, episodes); return; }
                        return r2.json();
                    }).then(function (b2) {
                        clearTimeout(timer);
                        rememberSeriesEpisodes(b2);
                        done(chapters, item, episodesFor(item.seriesId));
                    }).catch(function () { clearTimeout(timer); done(chapters, item, episodes); });
                    return;
                }
                episodes = eps;
            }
            clearTimeout(timer);
            done(chapters, item, episodes);
        }).catch(function () { clearTimeout(timer); done(chapters, item, episodes); });
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
        diag('media-observed', describeMedia(elem, fromPlay ? 'play' : 'scan'));
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

        // Capture stream metadata from the element BEFORE blankMedia() wipes
        // its src/currentSrc — after blanking, itemId/mediaSourceId can no
        // longer be derived from the element, which silently dropped the
        // handoff payload's title, series, poster and chapter context.
        var subtitle = subtitleStreamInfo(elem, src);
        var meta = playbackInfoMeta(elem, src);
        // The web player's own subtitle picker may have changed the active
        // track — promote that over the server default before blanking. When
        // nothing in the current page says which track is wanted (no URL param,
        // no active <track>), fall back to the remembered per-item pick from a
        // previous play of this item.
        applyInPageSubtitleSelection(meta, elem, subtitle.itemId);
        if (meta.subtitleStreamId == null) {
            var pref = readSubPref(subtitle.itemId);
            if (pref != null) {
                meta.subtitleStreamId = pref;
                for (var p = 0; p < meta.subtitleTracks.length; p++) {
                    meta.subtitleTracks[p].selected = meta.subtitleTracks[p].default = (meta.subtitleTracks[p].index === pref);
                }
            }
        }

        blankMedia(elem);

        var key = built.url + "|" + built.position_ticks;
        var now = Date.now();
        if (key === lastSignalKey && now - lastSignalAt < 10000) {
            elem.__ynotvSignaled = true;
            return true;
        }
        lastSignalKey = key;
        lastSignalAt = now;
        elem.__ynotvSignaled = true;

        // Merge PlaybackInfo-derived metadata (poster, audio/subtitle streams,
        // default subtitle index) over the <track>-element fallback scrape, and
        // ride the last diagnostics along so native console gets them without
        // ever touching the title channel. Chapter markers come from the item
        // DTO: prefer the in-page cache (the client prefetched Fields=Chapters
        // when it loaded the item), falling back to a bounded authoritative
        // fetch so the seek bar shows chapters even on a cold handoff. The
        // element is already blanked and play() returns a pending promise, so
        // Jellyfin's own player waits while we finish gathering metadata.
        diag('metadata', {
            itemId: subtitle.itemId || null,
            uid: !!currentUserId(),
            token: !!accessToken(),
            cachedItem: !!itemById[subtitle.itemId || ''],
            cachedChapters: !!chaptersFor(subtitle.itemId || '')
        });
        function finish(chapters, itemInfo, episodes) {
            // The element may have moved on to another stream while the
            // metadata fetch was in flight (e.g. next episode) — never signal
            // a stale handoff for an abandoned element. IMPORTANT: blankMedia()
            // wipes src/currentSrc, so the live element can never be compared
            // against the captured URL; use the handled URL we recorded on the
            // element instead.
            var cur = elem.__ynotvLastSrc || "";
            if (cur !== src || !elem.isConnected) return;
            // If playback started from a route that was never a "real" SPA
            // page (Continue Watching on home), remember the ITEM page so
            // stopping playback returns somewhere useful.
            saveItemRoute((itemInfo && itemInfo.seriesId) || subtitle.itemId);
            var diags = diagTail();
            signal({
                url: built.url,
                position_ticks: built.position_ticks,
                // The item DTO (gathered via the item's own API) carries the
                // real title; document.title on the player screen is generic.
                title: (itemInfo && itemInfo.name) || itemTitle(),
                item_id: subtitle.itemId,
                media_source_id: subtitle.mediaSourceId,
                subtitle_stream_id: meta.subtitleStreamId != null ? meta.subtitleStreamId : subtitle.subtitleStreamId,
                subtitle_url: subtitle.subtitleUrl,
                subtitle_tracks: meta.subtitleTracks.length ? meta.subtitleTracks : subtitle.subtitleTracks,
                poster_url: meta.posterUrl,
                audio_tracks: meta.audioTracks,
                chapters: Array.isArray(chapters) ? chapters : [],
                // Series/episode context so the frontend can show proper
                // S/E info in the header pill and play prev/next episodes.
                server_url: serverOrigin(),
                api_key: accessToken(),
                series_id: itemInfo && itemInfo.seriesId ? itemInfo.seriesId : null,
                series_name: (itemInfo && itemInfo.seriesName) || null,
                episode_index: itemInfo ? itemInfo.indexNumber : null,
                episode_parent_index: itemInfo ? itemInfo.parentIndexNumber : null,
                episode_name: (itemInfo && itemInfo.name) || null,
                episodes: Array.isArray(episodes) ? episodes : null,
                subtitle_prefs: readAllSubPrefs(),
                diags: diags
            });
        }
        gatherMetadata(subtitle.itemId, finish);
        return true;
    }

    function scanMedia(root) {
        var list;
        try { list = root.querySelectorAll ? root.querySelectorAll("video,audio") : []; } catch (e) { return; }
        for (var i = 0; i < list.length; i++) { watchMediaElement(list[i]); captureMedia(list[i], false); }
    }

    function watchMediaElement(elem) {
        if (!elem || elem.__ynotvObserved) return;
        elem.__ynotvObserved = true;
        var report = function (event) { diag('media-state', describeMedia(elem, event)); };
        ['loadstart', 'loadedmetadata', 'durationchange', 'canplay', 'playing', 'pause', 'emptied', 'error'].forEach(function (name) {
            try { elem.addEventListener(name, function () { report(name); }, { passive: true }); } catch (e) {}
        });
        try {
            var desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
            if (desc && desc.set && !desc.set.__ynotvPatched) {
                var originalSet = desc.set;
                var wrappedSet = function (value) {
                    diag('src-setter', { value: String(value || '') });
                    return originalSet.call(this, value);
                };
                wrappedSet.__ynotvPatched = true;
                Object.defineProperty(HTMLMediaElement.prototype, 'src', { configurable: desc.configurable, enumerable: desc.enumerable, get: desc.get, set: wrappedSet });
            }
        } catch (e) {}
    }

    function installDomWatcher() {
        diag('dom-watcher-installed');
        scanMedia(document);
        var mo = null;
        try {
            mo = new MutationObserver(function (muts) {
                for (var i = 0; i < muts.length; i++) {
                    var m = muts[i];
                    if (m.type === "attributes") {
                        var t = m.target;
                        if (t && (t.tagName === "VIDEO" || t.tagName === "AUDIO")) { watchMediaElement(t); captureMedia(t, false); }
                        continue;
                    }
                    var nodes = m.addedNodes || [];
                    for (var j = 0; j < nodes.length; j++) {
                        var n = nodes[j];
                        if (!n || n.nodeType !== 1) continue;
                        if (n.tagName === "VIDEO" || n.tagName === "AUDIO") { watchMediaElement(n); captureMedia(n, false); }
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

    // Dismiss any Jellyfin Web player loading overlays, spinners, or backdrop covers
    function dismissPlaybackOverlay() {
        try {
            if (window.loading && typeof window.loading.hide === 'function') {
                try { window.loading.hide(); } catch (e) {}
            }
            if (window.Loading && typeof window.Loading.hide === 'function') {
                try { window.Loading.hide(); } catch (e) {}
            }
            if (window.playbackManager) {
                if (typeof window.playbackManager.resetPlayer === 'function') {
                    try { window.playbackManager.resetPlayer(); } catch (e) {}
                }
                if (typeof window.playbackManager.stop === 'function') {
                    try { window.playbackManager.stop(); } catch (e) {}
                }
            }
            if (window.Events && window.playbackManager) {
                try { window.Events.trigger(window.playbackManager, 'playbackstop', [{ isLocal: true }]); } catch (e) {}
            }
            var overlays = document.querySelectorAll('.docspinner, .loading-spinner, .itemLoading, .videoPlayerContainer, .videoPlayerPage, .mdl-spinner, [data-role="page"].videoPlayerPage');
            for (var i = 0; i < overlays.length; i++) {
                var el = overlays[i];
                if (el.classList.contains('videoPlayerContainer') || el.classList.contains('docspinner') || el.classList.contains('videoPlayerPage')) {
                    try { el.remove(); } catch (e) {}
                } else if (el.style) {
                    el.style.display = 'none';
                }
            }
            document.body.classList.remove('hide-scroll');
        } catch (e) {}
    }

    // The play() choke point: htmlVideoPlayer assigns src then calls play().
    // Resolve immediately so Jellyfin's own web player cleans up its loading
    // state, and dismiss any active loading spinners/overlays.
    (function patchPlay() {
        try {
            var orig = HTMLMediaElement.prototype.play;
            if (!orig || orig.__ynotvPatched) return;
            var wrapper = function () {
                diag('play-intercept', describeMedia(this, 'play-called'));
                if (captureMedia(this, true)) {
                    this.__ynotvHandled = true;
                    setTimeout(dismissPlaybackOverlay, 80);
                    setTimeout(dismissPlaybackOverlay, 350);
                    return Promise.resolve();
                }
                return orig.apply(this, arguments);
            };
            wrapper.__ynotvPatched = true;
            HTMLMediaElement.prototype.play = wrapper;
        } catch (e) {}
    })();

    // Observe network calls used by Jellyfin to obtain PlaybackInfo/MediaStreams.
    // This captures the requested subtitle/audio stream choices from PlaybackInfo requests.
    (function patchNetwork() {
        // The latest PlaybackInfo response is stored (not just logged) so the
        // handoff payload can carry the authoritative stream metadata.
        function rememberPlaybackInfo(body) {
            try {
                if (!body || !body.MediaSources) return;
                playbackInfo = body;
                diag('playback-info-response', { sources: body.MediaSources.length, session: String(body.PlaySessionId || '').slice(0, 12) });
            } catch (e) {}
        }
        try {
            var originalFetch = window.fetch;
            if (originalFetch && !originalFetch.__ynotvPatched) {
                var wrappedFetch = function () {
                    var request = arguments[0];
                    var init = arguments[1];
                    var url = typeof request === 'string' ? request : (request && request.url) || '';
                    var reqBody = (init && init.body) || (request && request.body) || null;
                    if (/PlaybackInfo/i.test(url)) recordPlaybackInfoReq(url, reqBody);
                    if (/PlaybackInfo|Sessions\/Playing|Videos\/[^/]+\/stream/i.test(url)) diag('fetch', { url: url });
                    return originalFetch.apply(this, arguments).then(function (response) {
                        if (/PlaybackInfo/i.test(url)) {
                            try { response.clone().json().then(rememberPlaybackInfo).catch(function () {}); } catch (e) {}
                        } else if (/\/Items\/[^?/]+(?:\?|$)|[?&]Ids=/i.test(url)) {
                            // Item DTO responses can carry the Chapters array
                            // (Fields=Chapters is requested for playable items)
                            // — remember them for the handoff payload.
                            try { response.clone().json().then(rememberItemDto).catch(function () {}); } catch (e) {}
                        } else if (/\/Shows\/[^?/]+\/Episodes/i.test(url)) {
                            // Series episode lists power prev/next playback.
                            try { response.clone().json().then(rememberSeriesEpisodes).catch(function () {}); } catch (e) {}
                        }
                        return response;
                    });
                };
                wrappedFetch.__ynotvPatched = true;
                window.fetch = wrappedFetch;
            }
        } catch (e) { diag('fetch-patch-error', String(e)); }
        try {
            var originalOpen = XMLHttpRequest.prototype.open;
            var originalSend = XMLHttpRequest.prototype.send;
            if (originalOpen && !originalOpen.__ynotvPatched) {
                var wrappedOpen = function (method, url) {
                    this.__ynotvUrl = String(url || '');
                    if (/PlaybackInfo|Sessions\/Playing|Videos\/[^/]+\/stream/i.test(this.__ynotvUrl)) diag('xhr-open', { method: method, url: this.__ynotvUrl });
                    var result = originalOpen.apply(this, arguments);
                    if (/PlaybackInfo/i.test(this.__ynotvUrl)) {
                        try {
                            var self = this;
                            this.addEventListener('loadend', function () {
                                try {
                                    if (self.responseText) rememberPlaybackInfo(JSON.parse(self.responseText));
                                } catch (e) {}
                            });
                        } catch (e) {}
                    } else if (/\/Items\/[^?/]+(?:\?|$)|[?&]Ids=/i.test(this.__ynotvUrl)) {
                        try {
                            var self2 = this;
                            this.addEventListener('loadend', function () {
                                try {
                                    if (self2.responseText) rememberItemDto(JSON.parse(self2.responseText));
                                } catch (e) {}
                            });
                        } catch (e) {}
                    } else if (/\/Shows\/[^?/]+\/Episodes/i.test(this.__ynotvUrl)) {
                        try {
                            var self3 = this;
                            this.addEventListener('loadend', function () {
                                try {
                                    if (self3.responseText) rememberSeriesEpisodes(JSON.parse(self3.responseText));
                                } catch (e) {}
                            });
                        } catch (e) {}
                    }
                    return result;
                };
                wrappedOpen.__ynotvPatched = true;
                XMLHttpRequest.prototype.open = wrappedOpen;
            }
            if (originalSend && !originalSend.__ynotvPatched) {
                var wrappedSend = function (body) {
                    if (this.__ynotvUrl && /PlaybackInfo/i.test(this.__ynotvUrl)) {
                        recordPlaybackInfoReq(this.__ynotvUrl, body);
                    }
                    return originalSend.apply(this, arguments);
                };
                wrappedSend.__ynotvPatched = true;
                XMLHttpRequest.prototype.send = wrappedSend;
            }
        } catch (e) { diag('xhr-patch-error', String(e)); }
    })();

    window.__ynotvJfReenable = function () {
        try {
            var els = document.querySelectorAll("video,audio");
            for (var i = 0; i < els.length; i++) releaseMedia(els[i]);
        } catch (e) {}
        warn("re-enabled Jellyfin web player after failed mpv handoff");
    };

    window.__ynotvOnPlaybackEnded = function () {
        try {
            window.__ynotvPlaybackActive = false;
            dismissPlaybackOverlay();
            var cur = location.hash || "";
            var saved = localStorage.getItem(ROUTE_KEY) || "";
            if (/videoosd/i.test(cur) || cur === "" || cur === "#/") {
                if (saved && saved !== cur && !/videoosd/i.test(saved)) {
                    var cleanTarget = saved.replace(/^#\/?/, '');
                    if (window.AppRouter && typeof window.AppRouter.show === "function") {
                        window.AppRouter.show(cleanTarget);
                    } else if (window.Emby && window.Emby.Page && typeof window.Emby.Page.show === "function") {
                        window.Emby.Page.show(cleanTarget);
                    } else {
                        location.hash = saved;
                    }
                } else if (window.AppRouter && typeof window.AppRouter.back === "function") {
                    window.AppRouter.back();
                }
            }
        } catch (e) {}
    };

})();
"##;