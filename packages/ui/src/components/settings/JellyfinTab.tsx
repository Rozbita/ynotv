import { useEffect, useState } from 'react';
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

        <p className="section-description">
          The Jellyfin web UI runs inside ynoTV as the &quot;Jellyfin&quot; tab in the titlebar.
          Enter your server URL here so it is remembered, then open the tab to browse your
          libraries and log in (add a username and password when the server requires them).
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '520px' }}>
          <div>
            <label
              style={{
                display: 'block',
                fontSize: '0.72rem',
                color: 'var(--text-muted)',
                marginBottom: '4px',
              }}
            >
              Server URL
            </label>
            <input
              type="text"
              placeholder="http://192.168.1.10:8096"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              style={inputStyle}
            />
          </div>

          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="sync-btn" onClick={handleSave} style={{ padding: '8px 20px', fontSize: '0.9rem' }}>
              Save
            </button>
            <button
              className="sync-btn"
              onClick={handleOpenTab}
              style={{ padding: '8px 20px', fontSize: '0.9rem', background: 'var(--surface-color)' }}
            >
              Open Jellyfin tab
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}