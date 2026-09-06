import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import type { LocalEntry } from '../../services/local-library/types';
import {
  updateLocalEntryPath,
  removeLocalEntry,
} from '../../services/local-library/local-library';

interface FileNotFoundModalProps {
  isOpen: boolean;
  entry: LocalEntry | null;
  onClose: () => void;
  onRelocated?: (entry: LocalEntry, newPath: string) => void;
  onRemoved?: (id: string) => void;
}

export const FileNotFoundModal: React.FC<FileNotFoundModalProps> = ({
  isOpen,
  entry,
  onClose,
  onRelocated,
  onRemoved,
}) => {
  const { t } = useTranslation('vod');
  const [checking, setChecking] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleLocateFile = useCallback(async () => {
    if (!entry) return;
    setErrorMessage(null);
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        multiple: false,
        title: t('locateFileTitle', 'Locate Media File'),
      });
      if (!selected || typeof selected !== 'string') return;

      const pathStr = selected.replace(/\\/g, '/');
      const filename = pathStr.split('/').pop() || entry.filename;
      updateLocalEntryPath(entry.id, selected, filename);
      onRelocated?.(entry, selected);
      onClose();
    } catch (err: any) {
      console.error('[FileNotFoundModal] Failed to locate file:', err);
      setErrorMessage(err?.message || t('locateFileFailed', 'Failed to update file path.'));
    }
  }, [entry, onClose, onRelocated, t]);

  const handleRefreshCheck = useCallback(async () => {
    if (!entry) return;
    setChecking(true);
    setErrorMessage(null);
    try {
      const exists = await invoke<boolean>('check_path_exists', { path: entry.path });
      if (exists) {
        updateLocalEntryPath(entry.id, entry.path);
        onClose();
      } else {
        setErrorMessage(
          t('fileStillNotFound', 'File is still not found at the specified path. Check if the drive is connected.'),
        );
      }
    } catch (err: any) {
      console.error('[FileNotFoundModal] Check failed:', err);
      setErrorMessage(err?.message || t('checkFailed', 'Could not verify path.'));
    } finally {
      setChecking(false);
    }
  }, [entry, onClose, t]);

  const handleRemove = useCallback(() => {
    if (!entry) return;
    removeLocalEntry(entry.id);
    onRemoved?.(entry.id);
    onClose();
  }, [entry, onClose, onRemoved]);

  if (!isOpen || !entry) return null;

  return (
    <div className="local-modal-overlay" onClick={onClose}>
      <div
        className="local-modal-content"
        style={{ maxWidth: '540px' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="local-modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: '36px',
                height: '36px',
                borderRadius: '50%',
                background: 'rgba(239, 68, 68, 0.15)',
                color: '#ef4444',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>
            <div>
              <h3 className="local-modal-title">
                {t('fileNotFoundTitle', 'File or Folder Not Found')}
              </h3>
              <p className="local-modal-subtitle">
                {entry.title || entry.filename}
              </p>
            </div>
          </div>
          <button type="button" className="local-modal-close" onClick={onClose}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="local-modal-body" style={{ gap: '16px' }}>
          <p style={{ margin: 0, fontSize: '13.5px', color: 'var(--text-secondary)', lineHeight: '1.5' }}>
            {t(
              'fileNotFoundDesc',
              'The underlying media file cannot be found on your system. It may have been renamed, moved to another folder, or the external storage drive might be disconnected.',
            )}
          </p>

          <div
            style={{
              padding: '10px 14px',
              borderRadius: '10px',
              background: 'rgba(0, 0, 0, 0.25)',
              border: '1px solid var(--surface-border, rgba(255, 255, 255, 0.08))',
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
            }}
          >
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 600 }}>
              {t('expectedPath', 'Expected File Location')}
            </span>
            <span
              style={{
                fontSize: '12px',
                fontFamily: 'monospace',
                color: 'var(--text-primary)',
                wordBreak: 'break-all',
                userSelect: 'text',
              }}
            >
              {entry.path}
            </span>
          </div>

          {errorMessage && (
            <div
              style={{
                padding: '10px 12px',
                borderRadius: '8px',
                background: 'rgba(239, 68, 68, 0.12)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                color: '#f87171',
                fontSize: '12.5px',
              }}
            >
              {errorMessage}
            </div>
          )}

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              marginTop: '4px',
            }}
          >
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                type="button"
                className="local-btn local-btn--primary"
                style={{ flex: 1, justifyContent: 'center' }}
                onClick={handleLocateFile}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                {t('locateFileBtn', 'Locate File...')}
              </button>

              <button
                type="button"
                className="local-btn local-btn--secondary"
                style={{ justifyContent: 'center' }}
                onClick={handleRefreshCheck}
                disabled={checking}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className={checking ? 'local-spin' : ''}
                >
                  <path d="M23 4v6h-6M1 20v-6h6" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
                {checking ? t('checking', 'Checking...') : t('refreshCheck', 'Check Again')}
              </button>
            </div>

            <button
              type="button"
              className="local-btn"
              style={{
                justifyContent: 'center',
                background: 'rgba(239, 68, 68, 0.1)',
                color: '#ef4444',
                borderColor: 'rgba(239, 68, 68, 0.25)',
              }}
              onClick={handleRemove}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
              {t('removeFromLibrary', 'Remove from Library')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
