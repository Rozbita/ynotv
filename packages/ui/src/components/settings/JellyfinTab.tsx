import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { useSettingsStore } from '../../stores/settingsStore';
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
  const [serverUrl, setServerUrl] = useState('');
  const [saved, setSaved] = useState(false);

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
          <h3>Jellyfin</h3>
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
            <span className="timeshift-toggle-label">{i18n.t('settings:jellyfin.enabled')}</span>
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
            maxWidth: '520px',
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
      </div>
    </div>
  );
}