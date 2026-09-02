import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { StoredChannel, StoredProgram } from '../db';
import { db } from '../db';
import { decompressEpgDescription } from '../utils/compression';
import { formatTime, formatDate } from '../utils/dateTime';
import { useEpgClockFormat } from '../stores/uiStore';
import i18n from '../i18n';
import { ProgramContextMenu } from './ProgramContextMenu';
import './Modal.css';
import './ViewAllProgramsModal.css';

interface ViewAllProgramsModalProps {
  isOpen: boolean;
  channel: StoredChannel | null;
  onClose: () => void;
  onPlayCatchup?: (
    channel: StoredChannel,
    programTitle: string,
    startTimeMs: number,
    durationMinutes: number,
    programDesc?: string
  ) => void;
}

interface DayGroup {
  key: string;
  /** Local date of the day's start (label derived from it). */
  date: Date;
  programs: StoredProgram[];
}

const MAX_PROGRAMS = 2000;
// SQL string comparison of EPG timestamps is unreliable (mixed "Z" and
// offset formats, see utils/epgTime.ts), so the query only uses the WHERE
// window to bound the fetch and the real ordering happens in JS below.
// 45 days back covers realistic catch-up retention; 14 days forward exceeds
// any real EPG horizon. The generous forward margin mirrors the offset
// distortion guard used everywhere else in the app.
const VIEW_ALL_BACK_MS = 45 * 24 * 60 * 60 * 1000;
const VIEW_ALL_FWD_MS = 14 * 24 * 60 * 60 * 1000;
// SQL safety cap: within the window a single channel realistically holds
// far fewer rows, so this only guards against pathological feeds.
const VIEW_ALL_SQL_LIMIT = 4000;

const toMs = (value: Date | string | undefined): number => {
  if (!value) return NaN;
  return new Date(value).getTime();
};

const dayKeyOf = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

const startOfDay = (date: Date): number =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/**
 * "View All Programs" modal for the 3-column EPG view. Shows every program the
 * DB has for the selected channel, organized into per-day tabs. Opening it
 * lands on the day that contains the currently-airing program (and scrolls the
 * running show into view). Past programs can be played as catch-up; any
 * program can be right-clicked for the full ProgramContextMenu (schedule a
 * recording, watchlist, catch-up download, ...).
 */
export function ViewAllProgramsModal({
  isOpen,
  channel,
  onClose,
  onPlayCatchup,
}: ViewAllProgramsModalProps) {
  useTranslation();
  const epgClockFormat = useEpgClockFormat();
  const [programs, setPrograms] = useState<StoredProgram[] | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ program: StoredProgram; x: number; y: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const channelId = channel?.stream_id ?? null;
  const catchupAvailable = Boolean(channel?.tv_archive) || channel?.tv_archive === 1;

  // Reset transient state every time the modal opens (or the channel changes).
  useEffect(() => {
    if (!isOpen) return;
    setActiveKey(null);
    setMenu(null);
    setNowMs(Date.now());
  }, [isOpen, channelId]);

  // Load ALL programs for the channel straight from the DB (bypasses the
  // lazy-loaded EPG window so past + future days are all visible).
  useEffect(() => {
    if (!isOpen || !channelId) {
      setPrograms(null);
      return;
    }
    let cancelled = false;
    setPrograms(null);
    (async () => {
      try {
        const dbInstance = await (db as any).dbPromise;
        const now = Date.now();
        const rows = (await dbInstance.select(
          `SELECT * FROM programs_effective
           WHERE stream_id = ?
             AND start < ?
             AND end > ?
           LIMIT ${VIEW_ALL_SQL_LIMIT}`,
          [
            channelId,
            new Date(now + VIEW_ALL_FWD_MS).toISOString(),
            new Date(now - VIEW_ALL_BACK_MS).toISOString(),
          ]
        )) as StoredProgram[];
        if (cancelled) return;
        // Order by parsed timestamp in JS — never by SQL string comparison.
        const ordered = rows
          .map((p) => ({
            ...p,
            description: decompressEpgDescription(p.description) ?? p.description,
          }))
          .sort((a, b) => toMs(a.start) - toMs(b.start))
          .slice(0, MAX_PROGRAMS);
        setPrograms(ordered);
      } catch (err) {
        console.error('[ViewAllPrograms] Failed to load programs:', err);
        if (!cancelled) setPrograms([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, channelId]);

  // Keep running/past state fresh while the modal stays open.
  useEffect(() => {
    if (!isOpen) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, [isOpen]);

  // Escape closes the modal — but only when no context menu is open.
  // ProgramContextMenu owns Escape while mounted (and guards its own nested
  // watchlist/DVR/TVMaze/download modals), so pressing Escape inside a nested
  // action must not unmount this whole modal. With a menu open the first
  // Escape closes the menu, the second closes this modal.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !menu) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose, menu]);

  // Group programs into ascending per-day buckets.
  const dayGroups = useMemo<DayGroup[]>(() => {
    if (!programs) return [];
    const groups: DayGroup[] = [];
    let last: DayGroup | null = null;
    for (const p of programs) {
      const startMs = toMs(p.start);
      if (!Number.isFinite(startMs)) continue;
      const key = dayKeyOf(startMs);
      if (!last || last.key !== key) {
        last = { key, date: new Date(startMs), programs: [] };
        groups.push(last);
      }
      last.programs.push(p);
    }
    return groups;
  }, [programs]);

  const formatDayLabel = (dayStart: Date): string => {
    const diffDays = Math.round((startOfDay(new Date(nowMs)) - startOfDay(dayStart)) / 86400000);
    if (diffDays === 0) return i18n.t('time:today', { defaultValue: 'Today' });
    if (diffDays === -1) return i18n.t('time:tomorrow', { defaultValue: 'Tomorrow' });
    if (diffDays === 1) return i18n.t('time:yesterday', { defaultValue: 'Yesterday' });
    const opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };
    if (dayStart.getFullYear() !== new Date(nowMs).getFullYear()) opts.year = 'numeric';
    return formatDate(dayStart, opts);
  };

  // Pick the initial day: the one containing the running program if any,
  // otherwise the day of "now", otherwise the earliest available day.
  useEffect(() => {
    if (!isOpen || activeKey !== null || dayGroups.length === 0) return;
    const now = nowMs;
    const runningDay = dayGroups.find((g) =>
      g.programs.some((p) => {
        const s = toMs(p.start);
        const e = toMs(p.end);
        return s <= now && e > now;
      })
    );
    setActiveKey((runningDay ?? dayGroups.find((g) => g.key === dayKeyOf(now)) ?? dayGroups[0]).key);
  }, [isOpen, activeKey, dayGroups, nowMs]);

  // Scroll the running program into view when the modal opens or the tab
  // changes. Not keyed on nowMs — the 60s tick must not yank the scroll.
  useEffect(() => {
    if (!isOpen || !listRef.current || activeKey === null) return;
    const list = listRef.current;
    const raf = requestAnimationFrame(() => {
      const activeGroup = dayGroups.find((g) => g.key === activeKey);
      if (!activeGroup) return;
      const running = activeGroup.programs.find((p) => {
        const s = toMs(p.start);
        const e = toMs(p.end);
        return s <= nowMs && e > nowMs;
      });
      if (running) {
        const els = list.querySelectorAll<HTMLElement>('[data-pid]');
        for (const el of els) {
          if (el.dataset.pid === String(running.id)) {
            el.scrollIntoView({ block: 'center' });
            return;
          }
        }
      }
      list.scrollTop = 0;
    });
    return () => cancelAnimationFrame(raf);
  }, [isOpen, activeKey, dayGroups]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isOpen || !channel) return null;

  const activePrograms = activeKey
    ? (dayGroups.find((g) => g.key === activeKey)?.programs ?? [])
    : [];

  const timeStr = (ms: number) =>
    formatTime(new Date(ms), { hour: '2-digit', minute: '2-digit', hour12: epgClockFormat !== '24h' });

  return createPortal(
    <>
      <div className="modal-overlay view-all-programs-overlay" onClick={onClose}>
        <div
          className="modal-container view-all-programs-modal"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="modal-header">
            <h3 className="modal-title" title={channel.name}>
              {channel.name}
            </h3>
            <button
              className="modal-close-btn"
              onClick={onClose}
              aria-label={i18n.t('common:close', { defaultValue: 'Close' })}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="view-all-programs-subtitle">
            {i18n.t('live:viewAllPrograms', { defaultValue: 'View All Programs' })}
            {programs !== null && programs.length > 0 && (
              <span className="view-all-programs-count">
                {i18n.t('common:daysCount', { count: dayGroups.length })} ·{' '}
                {i18n.t('common:programsCount', { count: programs.length })}
              </span>
            )}
          </div>
          {programs === null ? (
            <div className="view-all-list view-all-empty">
              {i18n.t('common:loading', { defaultValue: 'Loading…' })}
            </div>
          ) : dayGroups.length === 0 ? (
            <div className="view-all-list view-all-empty">
              {i18n.t('common:noProgramInfo', { defaultValue: 'No Program Information' })}
            </div>
          ) : (
            <>
              <div className="view-all-day-tabs">
                {dayGroups.map((g) => (
                  <button
                    key={g.key}
                    className={`view-all-day-tab ${g.key === activeKey ? 'active' : ''}`}
                    onClick={() => setActiveKey(g.key)}
                  >
                    {formatDayLabel(g.date)}
                  </button>
                ))}
              </div>
              <div className="view-all-list" ref={listRef}>
                {activePrograms.map((p) => {
                  const startMs = toMs(p.start);
                  const endMs = toMs(p.end);
                  const isCurrent = startMs <= nowMs && endMs > nowMs;
                  const isPast = endMs <= nowMs;
                  const clickable = isPast && catchupAvailable && !!onPlayCatchup;
                  const tooltip = `${p.title}${p.subtitle ? `\n${p.subtitle}` : ''}\n${timeStr(startMs)} - ${timeStr(endMs)}${p.description ? `\n\n${p.description}` : ''}${clickable ? `\n\n${i18n.t('epg:clickPlayCatchup', { defaultValue: 'Click to play catch-up' })}` : `\n\n${i18n.t('live:viewAllTip', { defaultValue: 'Right-click for recording / catch-up options' })}`}`;
                  return (
                    <button
                      key={p.id}
                      data-pid={p.id}
                      className={`view-all-row ${isCurrent ? 'is-current' : ''} ${isPast ? 'is-past' : ''} ${clickable ? 'clickable' : ''}`}
                      title={tooltip}
                      onClick={() => {
                        if (!clickable) return;
                        const rawStartMs = p.raw_start ? new Date(p.raw_start).getTime() : startMs;
                        const durationMins = Math.max(1, Math.round((endMs - startMs) / 60000));
                        onPlayCatchup!(channel, p.title, rawStartMs, durationMins, p.description);
                        onClose();
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setMenu({ program: p, x: e.clientX, y: e.clientY });
                      }}
                    >
                      <span className="view-all-row-time">
                        {timeStr(startMs)} – {timeStr(endMs)}
                      </span>
                      <span className="view-all-row-main">
                        <span className="view-all-row-title">
                          {p.title}
                          {isCurrent && (
                            <span className="view-all-row-running">
                              {i18n.t('common:running', { defaultValue: 'Running' })}
                            </span>
                          )}
                        </span>
                        {p.description && (
                          <span className="view-all-row-desc">{p.description}</span>
                        )}
                      </span>
                      {(isPast || isCurrent) && catchupAvailable && (
                        <span className="view-all-row-chip">
                          {i18n.t('live:viewAllCatchup', { defaultValue: 'Catch-up' })}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <div className="view-all-tip">
                {i18n.t('live:viewAllTip', {
                  defaultValue: 'Right-click any program for recording, catch-up or watchlist options.',
                })}
              </div>
            </>
          )}
        </div>
      </div>
      {menu && (
        <ProgramContextMenu
          program={menu.program}
          sourceId={channel.source_id}
          channelId={channel.stream_id}
          channelName={channel.name}
          position={{ x: menu.x, y: menu.y }}
          onClose={() => setMenu(null)}
          isCatchupAvailable={catchupAvailable}
        />
      )}
    </>,
    document.body
  );
}
