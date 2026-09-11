import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { StoredChannel } from '../db';
import { useLiveQuery } from '../hooks/useSqliteLiveQuery';
import { useCurrentProgram, applyHomeCategoryFilterWords } from '../hooks/useChannels';
import { useSettingsStore } from '../stores/settingsStore';
import { db } from '../db';
import './FavoritesWidget.css';

const ACTIVE_FAVORITE_STORAGE_KEY = 'ynotv-active-favorite-stream-id';
const FAVORITES_VISIBLE_COUNT = 7;
const FAVORITES_SELECTED_OFFSET = 3;

interface FavoriteChannelItemProps {
  channel: StoredChannel;
  onChannelClick: (channel: StoredChannel) => void;
  isActive: boolean;
  itemRef?: (element: HTMLDivElement | null) => void;
}

function FavoriteChannelItem({ channel, onChannelClick, isActive, itemRef }: FavoriteChannelItemProps) {
  const currentProgram = useCurrentProgram(channel.stream_id);

  const handleClick = useCallback(() => {
    onChannelClick(channel);
  }, [channel, onChannelClick]);

  return (
    <div
      ref={itemRef}
      className={`favorite-channel-item${isActive ? ' active' : ''}`}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick();
        }
      }}
      title={`${channel.name}${currentProgram ? ` - ${currentProgram.title}` : ''}`}
    >
      <div className="favorite-channel-name">{channel.alias || channel.name}</div>
      {currentProgram && (
        <div className="favorite-channel-program">{currentProgram.title}</div>
      )}
    </div>
  );
}

interface FavoritesWidgetProps {
  showControls: boolean;
  activeView: string;
  onChannelClick: (channel: StoredChannel) => void;
  isVod: boolean;
  onMoveLeft?: () => void;
  onMoveRight?: () => void;
}

export function FavoritesWidget({
  showControls,
  activeView,
  onChannelClick,
  isVod,
  onMoveLeft,
  onMoveRight,
}: FavoritesWidgetProps) {
  const { t } = useTranslation('widgets');
  const alwaysSortFavoritesAlphabetically = useSettingsStore((s) => s.alwaysSortFavoritesAlphabetically);
  const [activeStreamId, setActiveStreamId] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(ACTIVE_FAVORITE_STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const activeItemRef = useRef<HTMLDivElement | null>(null);
  const favoritesListRef = useRef<HTMLDivElement | null>(null);

  const favoriteChannels = useLiveQuery(
    async () => {
      const results = await db.channels.whereRaw('(is_favorite = 1 OR is_favorite = true)').toArray();
      // Same home-category filter-word name cleaning as the LiveTV Favorites
      // list so the A-Z order matches the app exactly.
      const cleaned = await applyHomeCategoryFilterWords(results);
      // Sort by fav_order (nulls last, then by name). When 'always sort
      // favorites alphabetically' is enabled, keep A-Z order instead — matching
      // the LiveTV Favorites list.
      if (alwaysSortFavoritesAlphabetically) {
        cleaned.sort((a, b) => (a.alias || a.name).localeCompare(b.alias || b.name));
      } else {
        cleaned.sort((a, b) => {
          if (a.fav_order != null && b.fav_order != null) return a.fav_order - b.fav_order;
          if (a.fav_order != null) return -1;
          if (b.fav_order != null) return 1;
          return (a.alias || a.name).localeCompare(b.alias || b.name);
        });
      }
      return cleaned;
    },
    [alwaysSortFavoritesAlphabetically],
    [],
    0,
    ['channels', 'favorites', 'categories']
  );

  // Only visible on main screen when controls are shown
  const isMainScreen = activeView === 'none';
  const isVisible = isMainScreen && showControls && (favoriteChannels?.length ?? 0) > 0 && !isVod;

  // The widget unmounts while the fullscreen controls are hidden. Restore the
  // selected favorite and position it in the seven-channel window whenever the
  // widget reappears. The window is clamped to the real list boundaries so it
  // never creates empty slots.
  useEffect(() => {
    if (!isVisible || !activeStreamId || !favoriteChannels?.length) return;

    const selectedIndex = favoriteChannels.findIndex((channel) => channel.stream_id === activeStreamId);
    if (selectedIndex < 0) return;

    const frame = requestAnimationFrame(() => {
      const list = favoritesListRef.current;
      if (!list) return;

      const visibleCount = Math.min(FAVORITES_VISIBLE_COUNT, favoriteChannels.length);
      const maxStartIndex = Math.max(0, favoriteChannels.length - visibleCount);
      const startIndex = Math.min(
        Math.max(0, selectedIndex - FAVORITES_SELECTED_OFFSET),
        maxStartIndex,
      );
      const firstVisibleItem = list.children[startIndex] as HTMLElement | undefined;

      if (firstVisibleItem) {
        list.scrollTop = firstVisibleItem.offsetTop - list.offsetTop;
      } else {
        list.scrollTop = 0;
      }
    });

    return () => cancelAnimationFrame(frame);
  }, [isVisible, activeStreamId, favoriteChannels]);

  const handleFavoriteClick = useCallback((channel: StoredChannel) => {
    setActiveStreamId(channel.stream_id);
    try {
      sessionStorage.setItem(ACTIVE_FAVORITE_STORAGE_KEY, channel.stream_id);
    } catch {
      // Ignore storage failures; the in-memory highlight still works.
    }
    onChannelClick(channel);
  }, [onChannelClick]);

  if (!isVisible) {
    return null;
  }

  return (
    <div className="favorites-widget">
      <div className="favorites-header" style={{ display: 'flex', alignItems: 'center' }}>
        <span>{t('favorites')}</span>
        {(onMoveLeft || onMoveRight) && (
          <div className="widget-move-controls">
            <button className="widget-move-btn" onClick={onMoveLeft} disabled={!onMoveLeft} title={t('moveLeft')}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
            </button>
            <button className="widget-move-btn" onClick={onMoveRight} disabled={!onMoveRight} title={t('moveRight')}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
            </button>
          </div>
        )}
      </div>
      <div ref={favoritesListRef} className="favorites-list">
        {favoriteChannels?.map((channel) => (
          <FavoriteChannelItem
            key={channel.stream_id}
            channel={channel}
            onChannelClick={handleFavoriteClick}
            isActive={channel.stream_id === activeStreamId}
            itemRef={channel.stream_id === activeStreamId ? (element) => { activeItemRef.current = element; } : undefined}
          />
        ))}
      </div>
    </div>
  );
}
