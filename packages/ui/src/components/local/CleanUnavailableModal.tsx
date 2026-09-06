import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import type { LibraryFolder, LocalEntry } from '../../services/local-library/types';
import { removeLocalEntries } from '../../services/local-library/local-library';

interface CleanUnavailableModalProps {
  isOpen: boolean;
  onClose: () => void;
  items: LocalEntry[];
  folders: LibraryFolder[];
  activeFilter?: 'all' | 'movies' | 'series' | 'favorites' | 'unmatched';
  onCleaned: (count: number) => void;
}

export const CleanUnavailableModal: React.FC<CleanUnavailableModalProps> = ({
  isOpen,
  onClose,
  items,
  folders,
  activeFilter = 'all',
  onCleaned,
}) => {
  const { t } = useTranslation('vod');
  const [checking, setChecking] = useState(true);
  const [missingFolderPaths, setMissingFolderPaths] = useState<string[]>([]);
  const [scope, setScope] = useState<'filtered' | 'all'>('filtered');

  // Find missing folder roots on open
  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    setChecking(true);

    (async () => {
      const missing: string[] = [];
      for (const folder of folders) {
        try {
          const exists = await invoke<boolean>('check_path_exists', { path: folder.path });
          if (!exists) {
            missing.push(folder.path);
          }
        } catch {
          // Fail-open: do not assume missing if check throws
        }
      }
      if (active) {
        setMissingFolderPaths(missing);
        setChecking(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [isOpen, folders]);

  // Normalized missing folder prefixes
  const missingPrefixes = useMemo(() => {
    return missingFolderPaths.map((f) => {
      const norm = f.replace(/\\/g, '/').toLowerCase();
      return norm.endsWith('/') ? norm : `${norm}/`;
    });
  }, [missingFolderPaths]);

  const isTypeFiltered = activeFilter === 'movies' || activeFilter === 'series';

  // Unavailable items grouped by filter and connected vs offline drive
  const categorized = useMemo(() => {
    const unavail = items.filter((item) => !!item.unavailable);

    // Filter by active view if scope is 'filtered'
    const targetItems =
      scope === 'filtered' && isTypeFiltered
        ? unavail.filter((item) => (activeFilter === 'movies' ? item.type === 'movie' : item.type === 'show'))
        : unavail;

    const offlineDriveItems: LocalEntry[] = [];
    const connectedMissingItems: LocalEntry[] = [];

    for (const item of targetItems) {
      const normPath = item.path.replace(/\\/g, '/').toLowerCase();
      const isUnderOfflineFolder = missingPrefixes.some((p) => normPath.startsWith(p));
      if (isUnderOfflineFolder) {
        offlineDriveItems.push(item);
      } else {
        connectedMissingItems.push(item);
      }
    }

    const moviesCount = targetItems.filter((i) => i.type === 'movie').length;
    const showsCount = targetItems.filter((i) => i.type === 'show').length;

    return {
      allTargetItems: targetItems,
      offlineDriveItems,
      connectedMissingItems,
      moviesCount,
      showsCount,
    };
  }, [items, scope, activeFilter, missingPrefixes]);

  const handleCleanOnlyConnected = useCallback(() => {
    const ids = categorized.connectedMissingItems.map((i) => i.id);
    if (ids.length > 0) {
      removeLocalEntries(ids);
      onCleaned(ids.length);
    }
    onClose();
  }, [categorized.connectedMissingItems, onCleaned, onClose]);

  const handleCleanAll = useCallback(() => {
    const ids = categorized.allTargetItems.map((i) => i.id);
    if (ids.length > 0) {
      removeLocalEntries(ids);
      onCleaned(ids.length);
    }
    onClose();
  }, [categorized.allTargetItems, onCleaned, onClose]);

  if (!isOpen) return null;

  const hasOffline = categorized.offlineDriveItems.length > 0;
  const hasConnected = categorized.connectedMissingItems.length > 0;
  const totalCount = categorized.allTargetItems.length;

  return (
    <div className="local-modal-overlay" onClick={onClose}>
      <div
        className="local-modal-content"
        style={{ maxWidth: '560px' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="local-modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: '34px',
                height: '34px',
                borderRadius: '8px',
                background: 'rgba(239, 68, 68, 0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#ef4444',
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                <line x1="10" y1="11" x2="10" y2="17" />
                <line x1="14" y1="11" x2="14" y2="17" />
              </svg>
            </div>
            <div>
              <h2 className="local-modal-title" style={{ margin: 0, fontSize: '18px' }}>
                {t('cleanUnavailableModalTitle', 'Clean Up Unavailable Media')}
              </h2>
              <p style={{ margin: '2px 0 0', fontSize: '12px', color: 'var(--text-secondary, #9ca3af)' }}>
                {t('cleanUnavailableModalSub', 'Remove missing files and deleted media from your library')}
              </p>
            </div>
          </div>
          <button type="button" className="local-modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="local-modal-body" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {checking ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '20px 0', justifyContent: 'center', color: '#9ca3af' }}>
              <span className="spinner-small" />
              <span>{t('checking', 'Checking folders...')}</span>
            </div>
          ) : (
            <>
              {/* Scope toggle when filtered */}
              {isTypeFiltered && (
                <div style={{ display: 'flex', gap: '8px', background: 'rgba(255,255,255,0.04)', padding: '4px', borderRadius: '8px' }}>
                  <button
                    type="button"
                    style={{
                      flex: 1,
                      padding: '6px 12px',
                      borderRadius: '6px',
                      border: 'none',
                      fontSize: '12px',
                      fontWeight: 500,
                      cursor: 'pointer',
                      background: scope === 'filtered' ? 'var(--accent-color, #3b82f6)' : 'transparent',
                      color: scope === 'filtered' ? '#fff' : '#9ca3af',
                    }}
                    onClick={() => setScope('filtered')}
                  >
                    {activeFilter === 'movies'
                      ? t('cleanScopeMovies', 'Only Movies view ({{count}})', { count: categorized.moviesCount })
                      : t('cleanScopeSeries', 'Only Series view ({{count}})', { count: categorized.showsCount })}
                  </button>
                  <button
                    type="button"
                    style={{
                      flex: 1,
                      padding: '6px 12px',
                      borderRadius: '6px',
                      border: 'none',
                      fontSize: '12px',
                      fontWeight: 500,
                      cursor: 'pointer',
                      background: scope === 'all' ? 'var(--accent-color, #3b82f6)' : 'transparent',
                      color: scope === 'all' ? '#fff' : '#9ca3af',
                    }}
                    onClick={() => setScope('all')}
                  >
                    {t('cleanScopeAll', 'Entire Library')}
                  </button>
                </div>
              )}

              {/* Summary Stats */}
              <div
                style={{
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: '10px',
                  padding: '14px 16px',
                  fontSize: '13px',
                  lineHeight: '1.5',
                }}
              >
                <div>
                  {t('cleanSummaryText', 'Found {{count}} unavailable items ready for cleanup:', { count: totalCount })}
                </div>
                <div style={{ display: 'flex', gap: '16px', marginTop: '8px', fontSize: '12px', color: '#9ca3af' }}>
                  {categorized.moviesCount > 0 && <span>🎬 {categorized.moviesCount} movies</span>}
                  {categorized.showsCount > 0 && <span>📺 {categorized.showsCount} episodes</span>}
                  {hasOffline && (
                    <span style={{ color: '#eab308' }}>
                      ⚠️ {categorized.offlineDriveItems.length} on disconnected storage
                    </span>
                  )}
                </div>
              </div>

              {/* Disconnected Drives Warning */}
              {hasOffline && (
                <div
                  style={{
                    background: 'rgba(234, 179, 8, 0.1)',
                    border: '1px solid rgba(234, 179, 8, 0.3)',
                    borderRadius: '10px',
                    padding: '14px 16px',
                    display: 'flex',
                    gap: '12px',
                    alignItems: 'flex-start',
                  }}
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#eab308"
                    strokeWidth="2"
                    style={{ flexShrink: 0, marginTop: '2px' }}
                  >
                    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                  <div style={{ fontSize: '12px', lineHeight: '1.5', color: '#fef08a' }}>
                    <strong style={{ display: 'block', marginBottom: '2px', color: '#facc15' }}>
                      {t('disconnectedDrivesWarningTitle', 'Disconnected Drives Detected')}
                    </strong>
                    {t(
                      'disconnectedDrivesWarningDesc',
                      '{{count}} items are in offline folders ({{folders}}). If an external USB or network drive is unplugged, plug it back in to restore your items with their watch history and artwork intact.',
                      {
                        count: categorized.offlineDriveItems.length,
                        folders: missingFolderPaths.join(', '),
                      },
                    )}
                  </div>
                </div>
              )}

              {totalCount === 0 && (
                <div style={{ textAlign: 'center', padding: '16px', color: '#9ca3af', fontSize: '13px' }}>
                  {t('cleanNoItems', 'No unavailable items found.')}
                </div>
              )}
            </>
          )}
        </div>

        <div
          className="local-modal-footer"
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '10px',
            padding: '16px 20px',
            borderTop: '1px solid rgba(255, 255, 255, 0.08)',
          }}
        >
          <button
            type="button"
            className="local-btn local-btn--secondary"
            onClick={onClose}
          >
            {t('cleanCancelBtn', 'Cancel')}
          </button>

          {/* If there are items on connected folders and also offline drives, offer Safe Cleanup first */}
          {hasOffline && hasConnected && (
            <button
              type="button"
              className="local-btn local-btn--secondary"
              style={{ borderColor: 'rgba(59, 130, 246, 0.5)', color: '#60a5fa' }}
              onClick={handleCleanOnlyConnected}
            >
              {t('cleanSafeConnectedOnlyBtn', 'Clean Only Missing Files ({{count}})', {
                count: categorized.connectedMissingItems.length,
              })}
            </button>
          )}

          {totalCount > 0 && (
            <button
              type="button"
              className="local-btn"
              style={{
                background: '#ef4444',
                color: '#fff',
                border: 'none',
              }}
              onClick={handleCleanAll}
            >
              {hasOffline
                ? t('cleanAllIncludingOfflineBtn', 'Clean All ({{count}})', { count: totalCount })
                : t('cleanAllUnavailableBtn', 'Remove {{count}} Missing Items', { count: totalCount })}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
