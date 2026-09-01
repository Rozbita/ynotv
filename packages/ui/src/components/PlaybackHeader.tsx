import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import './PlaybackHeader.css';

export interface PlaybackHeaderProps {
  visible: boolean;
  sourceView: 'movies' | 'series' | 'dvr' | 'stremio' | 'nuvio' | 'jellyfin' | null;
  title?: string | null;
  subtitle?: string | null;
  quality?: string | null;
  sourceName?: string | null;
  onBack: () => void;
  onOpenDetails?: () => void;
}

export function PlaybackHeader({
  visible,
  sourceView,
  title,
  subtitle,
  quality = '1080P',
  sourceName,
  onBack,
  onOpenDetails,
}: PlaybackHeaderProps) {
  const { t } = useTranslation('player');
  const [hiding, setHiding] = useState(false);

  useEffect(() => {
    if (!visible) {
      setHiding(true);
      const timer = setTimeout(() => setHiding(false), 300);
      return () => clearTimeout(timer);
    } else {
      setHiding(false);
    }
  }, [visible]);

  if (!sourceView) return null;
  if (!visible && !hiding) return null;

  const displayTitle = title || t('nowPlaying');
  const displaySubtitle = subtitle || '';
  const displayQuality = quality;

  return (
    <div className={`playback-header-container${hiding ? ' hiding' : ''}`}>
      {/* Standalone Back Button (<) */}
      <button
        type="button"
        className="playback-header__back-btn"
        onClick={onBack}
        title={t('back')}
        aria-label={t('back')}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </button>

      {/* Info Pill Container */}
      {onOpenDetails && (
        <button
          type="button"
          className="playback-header__info-pill"
          onClick={onOpenDetails}
          title={t('aboutThisTitle')}
        >
          <div className="playback-header__info-content">
            <div className="playback-header__top-row">
              <span className="playback-header__title">{displayTitle}</span>
              {sourceName && (
                <span className="playback-header__source-badge">
                  {sourceName}
                </span>
              )}
              {displayQuality && (
                <span className="playback-header__quality-badge">
                  {displayQuality}
                </span>
              )}
            </div>
            {displaySubtitle && (
              <div className="playback-header__subtitle-row">
                {displaySubtitle}
              </div>
            )}
          </div>
          <div className="playback-header__info-icon">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
          </div>
        </button>
      )}
    </div>
  );
}
