/**
 * Tests that a subtitle selection is only remembered as the user's own choice
 * when a user-facing control asked for it.
 *
 * The settling poll defers to that flag, so an internal call site that passed it
 * by mistake would silently switch subtitle auto-selection off for the stream —
 * the failure would look like "subtitles never come on by themselves", with no
 * hint as to why. The second half of this file scans the player hook to keep the
 * internal calls internal.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const mockInvoke = vi.fn(
  async (_command: string, _args?: Record<string, unknown>): Promise<unknown> => [],
);

/**
 * Arguments of every `invoke` of one command. Tauri passes a third `options`
 * argument, so assertions match on the command and its args rather than arity.
 */
function invokeArgs(command: string): (Record<string, unknown> | undefined)[] {
  return mockInvoke.mock.calls
    .filter((call) => call[0] === command)
    .map((call) => call[1]);
}

Object.defineProperty(globalThis, 'window', {
  value: {
    localStorage: (globalThis as any).localStorage,
    __TAURI_INTERNALS__: {
      invoke: mockInvoke,
      transformCallback: () => 0,
    },
  },
  configurable: true,
  writable: true,
});

type BridgeModule = typeof import('../../services/tauri-bridge');
type IntentModule = typeof import('../../utils/subtitleIntent');

let Bridge: BridgeModule['Bridge'];
let intent: IntentModule;

beforeEach(async () => {
  mockInvoke.mockClear();
  vi.resetModules();
  ({ Bridge } = await import('../../services/tauri-bridge'));
  intent = await import('../../utils/subtitleIntent');
});

describe('user-initiated subtitle selection', () => {
  it('records a track the user picked', async () => {
    await Bridge.setSubtitleTrack(4, { userInitiated: true });

    expect(intent.getSubtitleIntent()).toEqual({ id: 4 });
    expect(invokeArgs('mpv_set_subtitle')).toContainEqual({ id: 4 });
  });

  it('records choosing Off', async () => {
    await Bridge.setSubtitleTrack(0, { userInitiated: true });

    expect(intent.getSubtitleIntent()).toEqual({ id: 0 });
    expect(invokeArgs('mpv_set_subtitle')).toContainEqual({ id: 0 });
    expect(intent.restorableSubtitleTrackId(intent.getSubtitleIntent())).toBeNull();
  });

  it('records the cycle control as a choice, with no id to restore', async () => {
    await Bridge.cycleSubtitle();

    expect(intent.getSubtitleIntent()).toEqual({ id: null });
  });

  it('leaves auto-selection untouched when the player selects a track itself', async () => {
    await Bridge.setSubtitleTrack(7);

    expect(intent.getSubtitleIntent()).toBeNull();
    expect(invokeArgs('mpv_set_subtitle')).toContainEqual({ id: 7 });
  });

  it('keeps the choice when the command fails', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('mpv is not running'));

    await expect(Bridge.setSubtitleTrack(4, { userInitiated: true })).rejects.toThrow();

    // mpv refusing the track is not a request to fall back to the configured
    // default, so the poll must still keep its hands off subtitles.
    expect(intent.getSubtitleIntent()).toEqual({ id: 4 });
  });
});

describe('the player hook only makes internal subtitle selections', () => {
  it('never passes userInitiated from usePlayback.ts', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../hooks/usePlayback.ts', import.meta.url)),
      'utf8',
    );

    const calls = source.match(/Bridge\.setSubtitleTrack\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((call) => call.includes('userInitiated'))).toEqual([]);
  });
});
