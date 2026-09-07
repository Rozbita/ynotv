import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { useSettingsStore } from '../../stores/settingsStore';
import {
  jellyfinClearLogFile,
  jellyfinEmbedOpenDevtools,
  jellyfinOpenLogDir,
  jellyfinOpenLogFile,
  jellyfinSetDebugLogging,
} from '../../services/jellyfin';
import './PlaybackTab.css';

/**
 * Jellyfin integration settings.
 *
 * The Jellyfin web UI lives in-app as the "Jellyfin" titlebar tab (a native
 * child WebView docked below a small URL/login toolbar). This panel just stores
 * the server URL (and optional username) that the tab pre-fills, and lets you
 * jump straight to it. Credentials for servers that require them are typed in
 * the tab itself and validated there.
 */
export function JellyfinTab() {
  useTranslation();
  const jellyfinEnabled = useSettingsStore((s) => s.jellyfinEnabled);
  const setJellyfinEnabled = useSettingsStore((s) => s.setJellyfinEnabled);
  const jellyfinTraktScrobbleEnabled = useSettingsStore((s) => s.jellyfinTraktScrobbleEnabled);
  const jellyfinSimklScrobbleEnabled = useSettingsStore((s) => s.jellyfinSimklScrobbleEnabled);
  const jellyfinDebugLoggingEnabled = useSettingsStore((s) => s.jellyfinDebugLoggingEnabled);
  const setJellyfinSettings = useSettingsStore((s) => s.setJellyfinSettings);
  const [serverUrl, setServerUrl] = useState('');
  const [saved, setSaved] = useState(false);
  const [clearStatus, setClearStatus] = useState<string | null>(null);
  const [devtoolsStatus, setDevtoolsStatus] = useState<string | null>(null);

  // Load the persisted server URL once.
  useEffect(() => {
    (async () => {
      try {
        const res = await (window as any).storage.getSettings();
        const url: string = res?.data?.jellyfinServerUrl || '';
        setServerUrl(url);
        if (url) setSaved(true);
      } catch (e) {
        console.warn('[Jellyfin] Failed to load saved server URL:', e);
      }
    })();
  }, []);

  const handleSave = async () => {
    try {
      await (window as any).storage.updateSettings({ jellyfinServerUrl: serverUrl.trim() });
      setSaved(!!serverUrl.trim());
    } catch (e) {
      console.warn('[Jellyfin] Failed to persist server URL:', e);
    }
  };

  const handleOpenTab = () => {
    window.dispatchEvent(new CustomEvent('ynotv:navigate-view', { detail: { view: 'jellyfin' } }));
  };

  const handleToggleDebugLogging = async (enabled: boolean) => {
    setJellyfinSettings({ jellyfinDebugLoggingEnabled: enabled });
    await jellyfinSetDebugLogging(enabled);
  };

  const handleOpenLogFile = async () => {
    try {
      await jellyfinOpenLogFile();
    } catch (e) {
      console.warn('[Jellyfin] Failed to open log file:', e);
    }
  };

  const handleOpenLogDir = async () => {
    try {
      await jellyfinOpenLogDir();
    } catch (e) {
      console.warn('[Jellyfin] Failed to open log directory:', e);
    }
  };

  const handleClearLog = async () => {
    try {
      setClearStatus(i18n.t('settings:jellyfin.clearing'));
      await jellyfinClearLogFile();
      setClearStatus(i18n.t('settings:jellyfin.cleared'));
      setTimeout(() => setClearStatus(null), 2500);
    } catch (e) {
      console.warn('[Jellyfin] Failed to clear log file:', e);
      setClearStatus(null);
    }
  };

  const handleOpenDevtools = async () => {
    try {
      setDevtoolsStatus(null);
      await jellyfinEmbedOpenDevtools();
    } catch (e) {
      setDevtoolsStatus(i18n.t('settings:jellyfin.devtoolsError'));
      setTimeout(() => setDevtoolsStatus(null), 3500);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--surface-border)',
    borderRadius: '6px',
    padding: '10px',
    fontSize: '0.85rem',
    color: 'var(--text-primary)',
    outline: 'none',
    boxSizing: 'border-box',
  };

  return (
    <div className="settings-tab-content">
      <div className="settings-section">
        <div className="section-header">
          <h3>{i18n.t('settings:jellyfin.title', 'Jellyfin (Beta)')}</h3>
          {saved && (
            <span
              style={{
                fontSize: '0.75rem',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                padding: '3px 8px',
                borderRadius: '4px',
                color: '#2ed573',
                background: 'rgba(46,213,115,0.1)',
              }}
            >
              Configured
            </span>
          )}
        </div>

        <div className="timeshift-toggle-row" style={{ marginBottom: '8px', marginTop: '4px' }}>
          <div className="timeshift-toggle-info">
            <span className="timeshift-toggle-label">{i18n.t('settings:jellyfin.enabled', 'Enable Jellyfin (Beta)')}</span>
            <span className="timeshift-toggle-sub">{i18n.t('settings:jellyfin.enabledHint')}</span>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={jellyfinEnabled}
              onChange={(e) => setJellyfinEnabled(e.target.checked)}
            />
            <span className="toggle-slider"></span>
          </label>
        </div>

        {!jellyfinEnabled && (
          <p className="section-description" style={{ color: 'var(--text-muted)' }}>
            {i18n.t('settings:jellyfin.disabledHint')}
          </p>
        )}
        {jellyfinEnabled && (
          <p className="section-description">
            {i18n.t('settings:jellyfin.description')}
          </p>
        )}

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            maxWidth: '560px',
            marginTop: '8px',
            opacity: jellyfinEnabled ? 1 : 0.45,
            pointerEvents: jellyfinEnabled ? 'auto' : 'none',
            filter: jellyfinEnabled ? 'none' : 'grayscale(0.6)',
          }}
        >
          <div>
            <label
              style={{
                display: 'block',
                fontSize: '0.72rem',
                color: 'var(--text-muted)',
                marginBottom: '4px',
              }}
            >
              {i18n.t('settings:jellyfin.serverUrlLabel')}
            </label>
            <input
              type="text"
              placeholder="http://192.168.1.10:8096"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              disabled={!jellyfinEnabled}
              style={inputStyle}
            />
          </div>

          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              className="sync-btn"
              onClick={handleSave}
              disabled={!jellyfinEnabled}
              style={{ padding: '8px 20px', fontSize: '0.9rem' }}
            >
              {i18n.t('common:save')}
            </button>
            <button
              className="sync-btn"
              onClick={handleOpenTab}
              disabled={!jellyfinEnabled}
              style={{ padding: '8px 20px', fontSize: '0.9rem', background: 'var(--surface-color)' }}
            >
              {i18n.t('settings:jellyfin.openBtn')}
            </button>
          </div>
        </div>

        {jellyfinEnabled && (
          <>
            <div style={{ marginTop: '20px' }}>
              <hr
                style={{
                  border: 'none',
                  borderTop: '1px solid var(--surface-border)',
                  margin: '20px 0 16px',
                }}
              />
              <h3 style={{ margin: 0 }}>{i18n.t('settings:jellyfin.scrobblingTitle')}</h3>
              <p className="section-description" style={{ marginTop: '6px' }}>
                {i18n.t('settings:jellyfin.scrobblingHint')}
              </p>

              <div className="timeshift-toggle-row" style={{ marginBottom: '8px', marginTop: '4px' }}>
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label">{i18n.t('settings:jellyfin.traktScrobble')}</span>
                  <span className="timeshift-toggle-sub">{i18n.t('settings:jellyfin.traktScrobbleHint')}</span>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={jellyfinTraktScrobbleEnabled}
                    onChange={(e) => setJellyfinSettings({ jellyfinTraktScrobbleEnabled: e.target.checked })}
                  />
                  <span className="toggle-slider"></span>
                </label>
              </div>

              <div className="timeshift-toggle-row" style={{ borderBottom: 'none' }}>
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label">{i18n.t('settings:jellyfin.simklScrobble')}</span>
                  <span className="timeshift-toggle-sub">{i18n.t('settings:jellyfin.simklScrobbleHint')}</span>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={jellyfinSimklScrobbleEnabled}
                    onChange={(e) => setJellyfinSettings({ jellyfinSimklScrobbleEnabled: e.target.checked })}
                  />
                  <span className="toggle-slider"></span>
                </label>
              </div>
            </div>

            <div>
              <hr
                style={{
                  border: 'none',
                  borderTop: '1px solid var(--surface-border)',
                  margin: '12px 0 16px',
                }}
              />
              <h3 style={{ margin: 0 }}>{i18n.t('settings:jellyfin.diagnosticsTitle')}</h3>
              <p className="section-description" style={{ marginTop: '6px' }}>
                {i18n.t('settings:jellyfin.diagnosticsHint')}
              </p>

              <div className="timeshift-toggle-row" style={{ marginBottom: '14px', marginTop: '4px' }}>
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label">{i18n.t('settings:jellyfin.debugLogging')}</span>
                  <span className="timeshift-toggle-sub">{i18n.t('settings:jellyfin.debugLoggingHint')}</span>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={jellyfinDebugLoggingEnabled}
                    onChange={(e) => void handleToggleDebugLogging(e.target.checked)}
                  />
                  <span className="toggle-slider"></span>
                </label>
              </div>

              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '8px' }}>
                <button
                  className="sync-btn"
                  onClick={handleOpenLogFile}
                  style={{ padding: '6px 14px', fontSize: '0.82rem', background: 'var(--surface-color)' }}
                  title="Open jellyfin.log"
                >
                  {i18n.t('settings:jellyfin.openLogFile')}
                </button>
                <button
                  className="sync-btn"
                  onClick={handleOpenLogDir}
                  style={{ padding: '6px 14px', fontSize: '0.82rem', background: 'var(--surface-color)' }}
                  title="Open log folder"
                >
                  {i18n.t('settings:jellyfin.openLogDir')}
                </button>
                <button
                  className="sync-btn"
                  onClick={handleClearLog}
                  style={{ padding: '6px 14px', fontSize: '0.82rem', background: 'var(--surface-color)' }}
                  title="Clear jellyfin.log"
                >
                  {clearStatus || i18n.t('settings:jellyfin.clearLogFile')}
                </button>
                <button
                  className="sync-btn"
                  onClick={handleOpenDevtools}
                  style={{ padding: '6px 14px', fontSize: '0.82rem', background: 'var(--surface-color)' }}
                  title={i18n.t('settings:jellyfin.inspectDevtoolsHint')}
                >
                  {i18n.t('settings:jellyfin.inspectDevtools')}
                </button>
              </div>

              {devtoolsStatus && (
                <p style={{ margin: '4px 0 0', fontSize: '0.78rem', color: '#ff6b6b' }}>
                  {devtoolsStatus}
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}