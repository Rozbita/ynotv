/**
 * jellyfin.ts
 *
 * Frontend client for the embedded Jellyfin integration.
 *
 * The Jellyfin web UI is rendered in a native child WebView (docked below the
 * app toolbar) instead of an <iframe>. This module exposes the small command
 * surface that drives that child WebView - opening it at a given bounds,
 * resizing it on window/toolbar changes, and closing it - plus the login
 * helper that pre-authenticates credentials against the server.
 *
 * Playback handoff: an init script injected into the Jellyfin page hooks the
 * player, writes the direct stream URL to `document.title`, and Rust forwards
 * it to this app's normal play pipeline (`jellyfin:play` event) so the
 * fullscreen player / Now Playing bar behave exactly like any other VOD.
 */

import { invoke } from '@tauri-apps/api/core';

/** Validate credentials against a Jellyfin server and obtain an API token. */
export async function jellyfinAuthenticate(
  serverUrl: string,
  username: string,
  password: string,
): Promise<{ token: string; userId: string | null; displayName: string | null } | null> {
  try {
    const base = serverUrl.replace(/\/+$/, '');
    const res = await fetch(`${base}/Users/AuthenticateByName`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Username: username, Pw: password }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      token: data?.AccessToken || '',
      userId: data?.User?.Id ?? null,
      displayName: data?.User?.Name ?? username,
    };
  } catch (e) {
    console.warn('[Jellyfin] Authenticate request failed:', e);
    return null;
  }
}

/** Open (or re-open) the embedded Jellyfin child WebView at logical bounds. */
export async function jellyfinEmbedOpen(
  url: string,
  bounds: { x: number; y: number; width: number; height: number },
): Promise<void> {
  await invoke('jellyfin_embed_open', {
    url,
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  });
}

/** Reposition / resize the embedded Jellyfin child WebView. */
export async function jellyfinEmbedResize(bounds: {
  x: number;
  y: number;
  width: number;
  height: number;
}): Promise<void> {
  await invoke('jellyfin_embed_resize', {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  });
}

/** Close the embedded Jellyfin child WebView. */
export async function jellyfinEmbedClose(): Promise<void> {
  await invoke('jellyfin_embed_close');
}

/** Hide or reveal the embedded Jellyfin child WebView without destroying it. */
export async function jellyfinEmbedSetVisible(visible: boolean): Promise<void> {
  await invoke('jellyfin_embed_set_visible', { visible });
}

/** Check whether the embedded Jellyfin child WebView is currently open. */
export async function jellyfinEmbedIsOpen(): Promise<boolean> {
  try {
    return (await invoke('jellyfin_embed_is_open')) ?? false;
  } catch (e) {
    return false;
  }
}

/**
 * Confirm that a handed-off Jellyfin stream is now playing through mpv.
 * Rust records the handoff (so its idle listener can later signal playback
 * end), starts reporting position/pause/stop to the Jellyfin API (resume
 * positions + dashboard), and re-asserts the full-window video surface.
 */
export async function jellyfinConfirmPlayback(url: string): Promise<void> {
  await invoke('jellyfin_confirm_playback', { url });
}

/**
 * Re-arm the injected page script after a failed handoff, so Jellyfin's own
 * web player can take over for the next attempt.
 */
export async function jellyfinEmbedReenable(): Promise<void> {
  await invoke('jellyfin_embed_reenable');
}

/**
 * Notify the embedded Jellyfin child WebView that video playback has stopped
 * or ended, dismissing any active loading spinners or player overlays and
 * restoring the page state.
 */
export async function jellyfinEmbedNotifyPlaybackEnded(positionTicks?: number): Promise<void> {
  try {
    await invoke('jellyfin_embed_notify_playback_ended', {
      positionTicks: positionTicks && positionTicks > 0 ? positionTicks : undefined,
    });
  } catch (e) {
    // Ignore errors if the child webview is not running
  }
}