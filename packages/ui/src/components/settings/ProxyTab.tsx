import { useState, useEffect } from 'react';
import { relaunch } from '@tauri-apps/plugin-process';
import { useTranslation } from 'react-i18next';
import i18n, { translateNativeError } from '../../i18n';
import type { SavedProxyProfile } from '../../types/app';
import '../Modal.css';

interface ProxyTabProps {
  socks5ProxyEnabled: boolean;
  onSocks5ProxyEnabledChange: (val: boolean) => void;
  socks5ProxyServer: string;
  onSocks5ProxyServerChange: (val: string) => void;
  socks5ProxyUsername: string;
  onSocks5ProxyUsernameChange: (val: string) => void;
  socks5ProxyPassword: string;
  onSocks5ProxyPasswordChange: (val: string) => void;
  socks5ProxyProfiles?: SavedProxyProfile[];
  onSocks5ProxyProfilesChange?: (profiles: SavedProxyProfile[]) => void;
  socks5ProxyActiveProfileId?: string | null;
  onSocks5ProxyActiveProfileIdChange?: (id: string | null) => void;
}

export function ProxyTab({
  socks5ProxyEnabled,
  onSocks5ProxyEnabledChange,
  socks5ProxyServer,
  onSocks5ProxyServerChange,
  socks5ProxyUsername,
  onSocks5ProxyUsernameChange,
  socks5ProxyPassword,
  onSocks5ProxyPasswordChange,
  socks5ProxyProfiles,
  onSocks5ProxyProfilesChange,
  socks5ProxyActiveProfileId,
  onSocks5ProxyActiveProfileIdChange,
}: ProxyTabProps) {
  useTranslation();
  const [enabled, setEnabled] = useState(socks5ProxyEnabled);
  const [server, setServer] = useState(socks5ProxyServer);
  const [username, setUsername] = useState(socks5ProxyUsername);
  const [password, setPassword] = useState(socks5ProxyPassword);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [showRestartModal, setShowRestartModal] = useState(false);
  const [showDisableModal, setShowDisableModal] = useState(false);

  // Saved profiles state
  const [profiles, setProfiles] = useState<SavedProxyProfile[]>(socks5ProxyProfiles ?? []);
  const [selectedProfileId, setSelectedProfileId] = useState<string>(() => {
    if (socks5ProxyActiveProfileId && (socks5ProxyProfiles ?? []).some((p) => p.id === socks5ProxyActiveProfileId)) {
      return socks5ProxyActiveProfileId;
    }
    const match = (socks5ProxyProfiles ?? []).find(
      (p) => p.server === socks5ProxyServer && p.username === socks5ProxyUsername
    );
    return match ? match.id : '';
  });

  const [showSaveProfileModal, setShowSaveProfileModal] = useState(false);
  const [showDeleteProfileModal, setShowDeleteProfileModal] = useState(false);
  const [profileNameInput, setProfileNameInput] = useState('');
  const [profileFeedback, setProfileFeedback] = useState('');

  useEffect(() => {
    if (socks5ProxyProfiles) {
      setProfiles(socks5ProxyProfiles);
    }
  }, [socks5ProxyProfiles]);

  useEffect(() => {
    if (socks5ProxyActiveProfileId !== undefined) {
      setSelectedProfileId(socks5ProxyActiveProfileId ?? '');
    }
  }, [socks5ProxyActiveProfileId]);

  // Diagnostics state
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; ip?: string; error?: string } | null>(null);

  const selectedProfile = profiles.find((p) => p.id === selectedProfileId);
  const isModifiedFromSelectedProfile = selectedProfile
    ? server !== selectedProfile.server ||
      username !== selectedProfile.username ||
      password !== (selectedProfile.password ?? '')
    : false;

  const hasUnsavedChanges =
    enabled !== socks5ProxyEnabled ||
    server !== socks5ProxyServer ||
    username !== socks5ProxyUsername ||
    password !== socks5ProxyPassword;

  function handleProfileSelect(profileId: string) {
    setSelectedProfileId(profileId);
    onSocks5ProxyActiveProfileIdChange?.(profileId || null);
    if (!profileId) return;
    const target = profiles.find((p) => p.id === profileId);
    if (target) {
      setServer(target.server);
      setUsername(target.username);
      setPassword(target.password ?? '');
      onSocks5ProxyServerChange(target.server);
      onSocks5ProxyUsernameChange(target.username);
      onSocks5ProxyPasswordChange(target.password ?? '');
      setSaveStatus('idle');
      setProfileFeedback('');
    }
  }

  async function handleConfirmSaveProfile() {
    const trimmedName = profileNameInput.trim();
    if (!trimmedName || !server.trim()) return;

    const newProfile: SavedProxyProfile = {
      id: crypto.randomUUID(),
      name: trimmedName,
      server: server.trim(),
      username: username.trim(),
      password: password,
    };
    const updated = [...profiles, newProfile];
    setProfiles(updated);
    setSelectedProfileId(newProfile.id);
    onSocks5ProxyProfilesChange?.(updated);
    onSocks5ProxyActiveProfileIdChange?.(newProfile.id);

    if (window.storage) {
      await window.storage.updateSettings({
        socks5ProxyProfiles: updated,
        socks5ProxyActiveProfileId: newProfile.id,
      });
    }
    setShowSaveProfileModal(false);
    setProfileNameInput('');
    setProfileFeedback(i18n.t('settings:proxy.profileSaved', { defaultValue: 'Profile saved' }));
    setTimeout(() => setProfileFeedback(''), 3000);
  }

  async function handleUpdateProfile() {
    if (!selectedProfile) return;
    const updated = profiles.map((p) =>
      p.id === selectedProfile.id
        ? {
            ...p,
            server: server.trim(),
            username: username.trim(),
            password: password,
          }
        : p
    );
    setProfiles(updated);
    onSocks5ProxyProfilesChange?.(updated);
    if (window.storage) {
      await window.storage.updateSettings({
        socks5ProxyProfiles: updated,
      });
    }
    setProfileFeedback(i18n.t('settings:proxy.profileUpdated', { defaultValue: 'Profile updated' }));
    setTimeout(() => setProfileFeedback(''), 3000);
  }

  async function handleConfirmDeleteProfile() {
    if (!selectedProfile) return;
    const updated = profiles.filter((p) => p.id !== selectedProfile.id);
    setProfiles(updated);
    setSelectedProfileId('');
    onSocks5ProxyProfilesChange?.(updated);
    onSocks5ProxyActiveProfileIdChange?.(null);
    if (window.storage) {
      await window.storage.updateSettings({
        socks5ProxyProfiles: updated,
        socks5ProxyActiveProfileId: null,
      });
    }
    setShowDeleteProfileModal(false);
    setProfileFeedback(i18n.t('settings:proxy.profileDeleted', { defaultValue: 'Profile deleted' }));
    setTimeout(() => setProfileFeedback(''), 3000);
  }

  function handleSaveClick() {
    setShowRestartModal(true);
  }

  async function handleSaveAndRestart() {
    setIsSaving(true);
    setSaveStatus('idle');
    setShowRestartModal(false);
    try {
      onSocks5ProxyEnabledChange(enabled);
      onSocks5ProxyServerChange(server);
      onSocks5ProxyUsernameChange(username);
      onSocks5ProxyPasswordChange(password);

      if (window.storage) {
        await window.storage.updateSettings({
          socks5ProxyEnabled: enabled,
          socks5ProxyServer: server,
          socks5ProxyUsername: username,
          socks5ProxyPassword: password,
          socks5ProxyProfiles: profiles,
          socks5ProxyActiveProfileId: selectedProfileId || null,
        });

        // Notify backend to reload environment variables and apply changes
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('update_proxy_settings');
      }
      setSaveStatus('success');
      
      // Relaunch the application to fully apply proxy variables system-wide
      await relaunch();
    } catch (err) {
      console.error('[ProxyTab] Failed to save and restart:', err);
      setSaveStatus('error');
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDisableAndRestart() {
    setIsSaving(true);
    setShowDisableModal(false);
    try {
      setEnabled(false);
      onSocks5ProxyEnabledChange(false);
      
      if (window.storage) {
        await window.storage.updateSettings({
          socks5ProxyEnabled: false,
          socks5ProxyProfiles: profiles,
          socks5ProxyActiveProfileId: selectedProfileId || null,
        });

        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('update_proxy_settings');
      }
      setSaveStatus('success');
      
      // Relaunch the application to revert settings system-wide
      await relaunch();
    } catch (err) {
      console.error('[ProxyTab] Failed to disable and restart:', err);
      setSaveStatus('error');
      setEnabled(true); // Revert on failure
    } finally {
      setIsSaving(false);
    }
  }

  async function handleTestConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const ip = await invoke<string>('test_proxy_connection');
      setTestResult({ success: true, ip });
    } catch (err: any) {
      console.error('[ProxyTab] Proxy test failed:', err);
      setTestResult({ success: false, error: translateNativeError(err?.toString()) || i18n.t('common:unknownErrorOccurred') });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="settings-tab-content" style={{ overflowY: 'auto', maxHeight: '100%' }}>
      {/* Visual Status Indicator Card */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '1rem 1.25rem',
        borderRadius: '8px',
        backgroundColor: socks5ProxyEnabled ? 'rgba(16, 185, 129, 0.1)' : 'var(--surface-color)',
        border: socks5ProxyEnabled ? '1px solid rgba(16, 185, 129, 0.3)' : '1px solid var(--border-color)',
        marginBottom: '1.5rem',
        boxShadow: socks5ProxyEnabled ? '0 0 15px rgba(16, 185, 129, 0.1)' : 'none',
        transition: 'all 0.3s ease',
      }}>
        <div>
          <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)' }}>
            {i18n.t('settings:proxy.systemStatus')}
          </div>
          <div style={{ fontSize: '1.1rem', fontWeight: 700, color: socks5ProxyEnabled ? '#10b981' : 'var(--text-secondary)', marginTop: '0.25rem' }}>
            {socks5ProxyEnabled ? i18n.t('settings:proxy.activeStatus') : i18n.t('settings:proxy.disabledStatus')}
          </div>
          {socks5ProxyEnabled && socks5ProxyServer && (
            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.25rem', fontFamily: 'monospace', opacity: 0.8 }}>
              {i18n.t('settings:proxy.serverLabel', { server: socks5ProxyServer })}
            </div>
          )}
        </div>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          fontSize: '0.85rem',
          color: socks5ProxyEnabled ? '#10b981' : 'var(--text-secondary)',
          fontWeight: 600,
        }}>
          <div style={{
            width: '10px',
            height: '10px',
            borderRadius: '50%',
            backgroundColor: socks5ProxyEnabled ? '#10b981' : '#6b7280',
            boxShadow: socks5ProxyEnabled ? '0 0 10px #10b981' : 'none',
            transition: 'all 0.3s ease',
          }} />
          {socks5ProxyEnabled ? i18n.t('settings:proxy.active') : i18n.t('settings:proxy.inactive')}
        </div>
      </div>

      <div className="settings-section">
        <div className="section-header">
          <h3>{i18n.t('settings:proxy.title')}</h3>
        </div>

        <p className="section-description">
          {i18n.t('settings:proxy.description')}
        </p>

        <div className="tmdb-form" style={{ marginTop: '1.5rem' }}>
          {/* Toggle Button */}
          <div className="form-group" style={{ marginBottom: '1.5rem' }}>
            <label className="genre-checkbox" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer', userSelect: 'none' }}>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => {
                  const nextVal = e.target.checked;
                  if (!nextVal && socks5ProxyEnabled) {
                    setShowDisableModal(true);
                  } else {
                    setEnabled(nextVal);
                    setSaveStatus('idle');
                  }
                }}
              />
              <span className="genre-name" style={{ fontSize: '0.95rem', fontWeight: 600 }}>
                {i18n.t('settings:proxy.enableProxy')}
              </span>
            </label>
            <p className="form-hint" style={{ marginTop: '0.5rem' }}>
              {i18n.t('settings:proxy.enableProxyHint')}
            </p>
          </div>

          {/* Saved Proxies Dropdown & Actions */}
          <div className="form-group" style={{
            marginBottom: '1.5rem',
            padding: '1rem',
            borderRadius: '8px',
            backgroundColor: 'var(--surface-color, rgba(255, 255, 255, 0.04))',
            border: '1px solid var(--border-color, rgba(255, 255, 255, 0.1))',
            opacity: enabled ? 1 : 0.6,
            transition: 'opacity 0.2s',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.6rem' }}>
              <label style={{ margin: 0, fontWeight: 600, fontSize: '0.9rem', color: 'var(--text-primary)' }}>
                {i18n.t('settings:proxy.savedProxies', { defaultValue: 'Saved Proxies' })}
              </label>
              {profileFeedback && (
                <span style={{ fontSize: '0.8rem', color: '#10b981', fontWeight: 600 }}>
                  ✓ {profileFeedback}
                </span>
              )}
            </div>

            <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <select
                value={selectedProfileId}
                onChange={(e) => handleProfileSelect(e.target.value)}
                disabled={!enabled}
                style={{
                  flex: '1 1 240px',
                  minWidth: '200px',
                  height: '38px',
                }}
              >
                <option value="">
                  {profiles.length === 0
                    ? i18n.t('settings:proxy.noSavedProxies', { defaultValue: 'No saved proxies' })
                    : i18n.t('settings:proxy.customOrUnsaved', { defaultValue: 'Custom / Unsaved' })}
                </option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.server})
                  </option>
                ))}
              </select>

              <button
                type="button"
                className="modal-btn modal-btn-secondary"
                onClick={() => {
                  setProfileNameInput(selectedProfile ? `${selectedProfile.name} (Copy)` : '');
                  setShowSaveProfileModal(true);
                }}
                disabled={!enabled || !server.trim()}
                title={i18n.t('settings:proxy.saveAsNew', { defaultValue: 'Save as New' })}
                style={{ height: '38px', padding: '0 14px', fontSize: '0.82rem', whiteSpace: 'nowrap' }}
              >
                + {i18n.t('settings:proxy.saveAsNew', { defaultValue: 'Save as New' })}
              </button>

              {selectedProfile && (
                <>
                  <button
                    type="button"
                    className="modal-btn modal-btn-secondary"
                    onClick={handleUpdateProfile}
                    disabled={!enabled || !isModifiedFromSelectedProfile}
                    title={i18n.t('settings:proxy.updateProfile', { defaultValue: 'Update Profile' })}
                    style={{
                      height: '38px',
                      padding: '0 14px',
                      fontSize: '0.82rem',
                      whiteSpace: 'nowrap',
                      opacity: isModifiedFromSelectedProfile ? 1 : 0.5,
                    }}
                  >
                    {i18n.t('settings:proxy.updateProfile', { defaultValue: 'Update Profile' })}
                  </button>

                  <button
                    type="button"
                    className="modal-btn modal-btn-danger"
                    onClick={() => setShowDeleteProfileModal(true)}
                    disabled={!enabled}
                    title={i18n.t('settings:proxy.deleteProfile', { defaultValue: 'Delete' })}
                    style={{
                      height: '38px',
                      padding: '0 12px',
                      fontSize: '0.82rem',
                      background: 'rgba(239, 68, 68, 0.15)',
                      border: '1px solid rgba(239, 68, 68, 0.3)',
                      color: '#ef4444',
                    }}
                  >
                    {i18n.t('settings:proxy.deleteProfile', { defaultValue: 'Delete' })}
                  </button>
                </>
              )}
            </div>
            <p className="form-hint" style={{ marginTop: '0.5rem', marginBottom: 0 }}>
              {i18n.t('settings:proxy.savedProxiesHint', { defaultValue: 'Save and switch between multiple proxy server configurations with a single click.' })}
            </p>
          </div>

          <div className="form-group" style={{ marginBottom: '1.5rem', opacity: enabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
            <label>{i18n.t('settings:proxy.serverAddress')}</label>
            <input
              type="text"
              value={server}
              disabled={!enabled}
              onChange={(e) => {
                setServer(e.target.value);
                onSocks5ProxyServerChange(e.target.value);
                setSaveStatus('idle');
              }}
              placeholder={i18n.t('settings:proxy.serverPlaceholder')}
              style={{ width: '100%' }}
            />
            <p className="form-hint">
              {i18n.t('settings:proxy.serverHint')}
            </p>
          </div>

          <div style={{ display: 'flex', gap: '1.25rem', marginBottom: '1.5rem', opacity: enabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
            <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
              <label>{i18n.t('settings:proxy.username')}</label>
              <input
                type="text"
                value={username}
                disabled={!enabled}
                onChange={(e) => {
                  setUsername(e.target.value);
                  onSocks5ProxyUsernameChange(e.target.value);
                  setSaveStatus('idle');
                }}
                placeholder={i18n.t('settings:proxy.usernamePlaceholder')}
                style={{ width: '100%' }}
              />
            </div>
            <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
              <label>{i18n.t('settings:proxy.password')}</label>
              <input
                type="password"
                value={password}
                disabled={!enabled}
                onChange={(e) => {
                  setPassword(e.target.value);
                  onSocks5ProxyPasswordChange(e.target.value);
                  setSaveStatus('idle');
                }}
                placeholder={i18n.t('settings:proxy.passwordPlaceholder')}
                style={{ width: '100%' }}
              />
            </div>
          </div>

          <div className="form-group inline" style={{ marginTop: '2rem' }}>
            <button
              type="button"
              onClick={handleSaveClick}
              disabled={isSaving}
              className={saveStatus === 'success' ? 'success' : saveStatus === 'error' ? 'error' : 'save-btn'}
              style={{ minWidth: '180px' }}
            >
              {isSaving ? i18n.t('settings:proxy.saving') : saveStatus === 'success' ? i18n.t('settings:proxy.saved') : saveStatus === 'error' ? i18n.t('settings:proxy.failed') : i18n.t('settings:proxy.saveProxy')}
            </button>
          </div>
        </div>
      </div>

      {/* Diagnostics / Verification Section */}
      <div className="settings-section" style={{ marginTop: '2.5rem', borderTop: '1px solid var(--surface-border)', paddingTop: '1.5rem' }}>
        <div className="section-header">
          <h3>{i18n.t('settings:proxy.diagnosticsTitle')}</h3>
        </div>
        <p className="section-description">
          {i18n.t('settings:proxy.diagnosticsSub')}
        </p>

        <div style={{ marginTop: '1.25rem' }}>
          {hasUnsavedChanges && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              backgroundColor: 'rgba(245, 158, 11, 0.08)',
              border: '1px solid rgba(245, 158, 11, 0.25)',
              padding: '0.75rem 1rem',
              borderRadius: '6px',
              color: '#f59e0b',
              fontSize: '0.85rem',
              marginBottom: '1rem',
            }}>
              <span style={{ fontSize: '1.1rem' }}>⚠️</span>
              <span>
                {i18n.t('settings:proxy.unsavedWarning')}
              </span>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <button
              type="button"
              onClick={handleTestConnection}
              disabled={testing || !socks5ProxyEnabled}
              className="sync-button"
              style={{
                padding: '0.5rem 1.25rem',
                fontSize: '0.85rem',
                opacity: socks5ProxyEnabled ? 1 : 0.5,
                cursor: socks5ProxyEnabled ? 'pointer' : 'not-allowed',
              }}
            >
              {testing ? i18n.t('settings:proxy.testing') : i18n.t('settings:proxy.runTest')}
            </button>
            {!socks5ProxyEnabled && (
              <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                {i18n.t('settings:proxy.enableToTest')}
              </span>
            )}
          </div>

          {testResult && (
            <div style={{
              marginTop: '1rem',
              padding: '1rem',
              borderRadius: '6px',
              backgroundColor: testResult.success ? 'rgba(16, 185, 129, 0.08)' : 'rgba(239, 68, 68, 0.08)',
              border: testResult.success ? '1px solid rgba(16, 185, 129, 0.25)' : '1px solid rgba(239, 68, 68, 0.25)',
              color: testResult.success ? '#10b981' : '#ef4444',
              fontSize: '0.85rem',
              transition: 'all 0.3s ease',
            }}>
              <div style={{ fontWeight: 700, marginBottom: '0.25rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                {testResult.success ? (
                  <>
                    <span>✓</span> {i18n.t('settings:proxy.testSuccess')}
                  </>
                ) : (
                  <>
                    <span>✗</span> {i18n.t('settings:proxy.testFailed')}
                  </>
                )}
              </div>
              <div style={{ marginTop: '0.5rem', fontFamily: 'monospace', color: 'var(--text-primary)', wordBreak: 'break-all' }}>
                {testResult.success ? (
                  <>
                    {i18n.t('settings:proxy.egressIp')}: <strong style={{ color: '#10b981' }}>{testResult.ip}</strong>
                    <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginTop: '0.25rem', fontFamily: 'sans-serif' }}>
                      {i18n.t('settings:proxy.routingOk')}
                    </div>
                  </>
                ) : (
                  <>
                    {i18n.t('settings:proxy.errorDetail')}: {testResult.error}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Verification / FAQ Guide */}
      <div className="settings-section" style={{ marginTop: '2.5rem', borderTop: '1px solid var(--surface-border)', paddingTop: '1.5rem', paddingBottom: '1.5rem' }}>
        <div className="section-header">
          <h3>{i18n.t('settings:proxy.faqTitle')}</h3>
        </div>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1rem' }}>
          <div>
            <h4 style={{ fontSize: '0.9rem', color: 'var(--text-primary)', marginBottom: '0.25rem' }}>
              {i18n.t('settings:proxy.faqQ1')}
            </h4>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
              {i18n.t('settings:proxy.faqA1Pre')}<code>--http-proxy</code>{i18n.t('settings:proxy.faqA1Mid')}<code>socks5h://</code>{i18n.t('settings:proxy.faqA1Post')}
            </p>
          </div>

          <div>
            <h4 style={{ fontSize: '0.9rem', color: 'var(--text-primary)', marginBottom: '0.25rem' }}>
              {i18n.t('settings:proxy.faqQ2')}
            </h4>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
              {i18n.t('settings:proxy.faqA2Pre')}<strong>{i18n.t('settings:proxy.faqA2Strong')}</strong>{i18n.t('settings:proxy.faqA2Post')}
            </p>
          </div>
        </div>
      </div>

      <p className="settings-disclaimer">
        {i18n.t('settings:proxy.disclaimer')}
      </p>

      {showRestartModal && (
        <div className="modal-overlay" onClick={() => setShowRestartModal(false)}>
          <div className="modal-container" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">{i18n.t('settings:proxy.restartRequired')}</h3>
            </div>
            <div className="modal-body">
              <p className="modal-message">
                {i18n.t('settings:proxy.restartMsg')}
                <br /><br />
                {i18n.t('settings:proxy.restartQuestion')}
              </p>
            </div>
            <div className="modal-footer">
              <button className="modal-btn modal-btn-secondary" onClick={() => setShowRestartModal(false)}>
                {i18n.t('common:cancel')}
              </button>
              <button className="modal-btn modal-btn-primary" onClick={handleSaveAndRestart}>
                {i18n.t('settings:proxy.saveAndRestart')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showDisableModal && (
        <div className="modal-overlay" onClick={() => {
          setShowDisableModal(false);
          setEnabled(true);
        }}>
          <div className="modal-container" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">{i18n.t('settings:proxy.restartRequiredDisable')}</h3>
            </div>
            <div className="modal-body">
              <p className="modal-message">
                {i18n.t('settings:proxy.restartDisableMsg')}
                <br /><br />
                {i18n.t('settings:proxy.disableQuestion')}
              </p>
            </div>
            <div className="modal-footer">
              <button className="modal-btn modal-btn-secondary" onClick={() => {
                setShowDisableModal(false);
                setEnabled(true);
              }}>
                {i18n.t('common:cancel')}
              </button>
              <button className="modal-btn modal-btn-primary" onClick={handleDisableAndRestart}>
                {i18n.t('settings:proxy.disableAndRestart')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showSaveProfileModal && (
        <div className="modal-overlay" onClick={() => setShowSaveProfileModal(false)}>
          <div className="modal-container" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '440px' }}>
            <div className="modal-header">
              <h3 className="modal-title">{i18n.t('settings:proxy.newProfileModalTitle', { defaultValue: 'Save Proxy Profile' })}</h3>
            </div>
            <div className="modal-body">
              <p className="modal-message" style={{ marginBottom: '1rem' }}>
                {i18n.t('settings:proxy.profileNamePrompt', { defaultValue: 'Enter a descriptive name for this proxy configuration:' })}
              </p>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <input
                  type="text"
                  autoFocus
                  value={profileNameInput}
                  onChange={(e) => setProfileNameInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleConfirmSaveProfile();
                    if (e.key === 'Escape') setShowSaveProfileModal(false);
                  }}
                  placeholder={i18n.t('settings:proxy.profileNamePlaceholder', { defaultValue: 'e.g. Home SOCKS5 or Netherlands VPN' })}
                  style={{ width: '100%' }}
                />
              </div>
            </div>
            <div className="modal-footer">
              <button className="modal-btn modal-btn-secondary" onClick={() => setShowSaveProfileModal(false)}>
                {i18n.t('common:cancel', { defaultValue: 'Cancel' })}
              </button>
              <button
                className="modal-btn modal-btn-primary"
                onClick={handleConfirmSaveProfile}
                disabled={!profileNameInput.trim()}
              >
                {i18n.t('common:save', { defaultValue: 'Save' })}
              </button>
            </div>
          </div>
        </div>
      )}

      {showDeleteProfileModal && selectedProfile && (
        <div className="modal-overlay" onClick={() => setShowDeleteProfileModal(false)}>
          <div className="modal-container" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '440px' }}>
            <div className="modal-header">
              <h3 className="modal-title">{i18n.t('settings:proxy.deleteProfileModalTitle', { defaultValue: 'Delete Proxy Profile' })}</h3>
            </div>
            <div className="modal-body">
              <p className="modal-message">
                {i18n.t('settings:proxy.deleteProfileConfirm', {
                  name: selectedProfile.name,
                  defaultValue: `Are you sure you want to delete the "${selectedProfile.name}" proxy profile?`,
                })}
              </p>
            </div>
            <div className="modal-footer">
              <button className="modal-btn modal-btn-secondary" onClick={() => setShowDeleteProfileModal(false)}>
                {i18n.t('common:cancel', { defaultValue: 'Cancel' })}
              </button>
              <button className="modal-btn modal-btn-danger" onClick={handleConfirmDeleteProfile} style={{ background: '#ef4444', color: '#fff' }}>
                {i18n.t('common:delete', { defaultValue: 'Delete' })}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
