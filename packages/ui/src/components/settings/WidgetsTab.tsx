import './PlaybackTab.css';
import './WidgetsTab.css';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';

interface WidgetsTabProps {
  widgetScale: number;
  onWidgetScaleChange: (scale: number) => void;
  widgetBgOpacity: number;
  onWidgetBgOpacityChange: (opacity: number) => void;
  sportsScale: number;
  onSportsScaleChange: (scale: number) => void;
  sportsBgOpacity: number;
  onSportsBgOpacityChange: (opacity: number) => void;
}

function SliderRow({
  label,
  hint,
  min,
  max,
  step,
  value,
  display,
  onChange,
}: {
  label: string;
  hint?: string;
  min: number;
  max: number;
  step: number;
  value: number;
  display: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="form-group" style={{ marginBottom: '18px' }}>
      <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-primary)' }}>
        {label}
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(parseFloat(event.target.value))}
          style={{ flex: 1 }}
        />
        <span style={{
          minWidth: '52px',
          textAlign: 'center',
          color: 'var(--text-primary)',
          fontWeight: 600,
          fontSize: '0.92rem',
          background: 'var(--surface-color)',
          borderRadius: '6px',
          padding: '3px 8px',
        }}>
          {display}
        </span>
      </div>
      {hint ? <p className="form-hint" style={{ marginTop: '0.4rem' }}>{hint}</p> : null}
    </div>
  );
}

export function WidgetsTab({
  widgetScale,
  onWidgetScaleChange,
  widgetBgOpacity,
  onWidgetBgOpacityChange,
  sportsScale,
  onSportsScaleChange,
  sportsBgOpacity,
  onSportsBgOpacityChange,
}: WidgetsTabProps) {
  useTranslation();

  const scalePercent = Math.round(widgetScale * 100);
  const opacityPercent = Math.round(widgetBgOpacity * 100);
  const sportsScalePercent = Math.round(sportsScale * 100);
  const sportsOpacityPercent = Math.round(sportsBgOpacity * 100);

  return (
    <div className="settings-tab-content playback-tab-content">
      <div className="settings-section">
        <div className="section-header">
          <h3>{i18n.t('settings:livetv.widgets.overlayWidgets')}</h3>
        </div>
        <p className="section-description">
          {i18n.t('settings:livetv.widgets.overlayWidgetsSub')}
        </p>

        <div className="timeshift-settings">
          <SliderRow
            label={i18n.t('settings:livetv.widgets.widgetScale')}
            hint={i18n.t('settings:livetv.widgets.widgetScaleHint')}
            min={50}
            max={400}
            step={5}
            value={scalePercent}
            display={`${scalePercent}%`}
            onChange={(value) => onWidgetScaleChange(value / 100)}
          />

          <div className="timeshift-presets-label">
            {i18n.t('settings:livetv.widgets.scalePresets')}
          </div>
          <div className="timeshift-presets" style={{ marginBottom: '18px' }}>
            {[75, 100, 125, 150].map((percent) => (
              <button
                key={percent}
                className={`timeshift-preset-btn${scalePercent === percent ? ' active' : ''}`}
                onClick={() => onWidgetScaleChange(percent / 100)}
              >
                {percent}%
              </button>
            ))}
          </div>

          <SliderRow
            label={i18n.t('settings:livetv.widgets.bgOpacity')}
            hint={i18n.t('settings:livetv.widgets.bgOpacityHint')}
            min={5}
            max={95}
            step={5}
            value={opacityPercent}
            display={`${opacityPercent}%`}
            onChange={(value) => onWidgetBgOpacityChange(value / 100)}
          />

          <button
            className="sync-btn"
            onClick={() => {
              onWidgetScaleChange(1);
              onWidgetBgOpacityChange(0.55);
            }}
            style={{ maxWidth: '200px' }}
          >
            {i18n.t('common:resetToDefaults')}
          </button>
        </div>
      </div>

      <div className="settings-section">
        <div className="section-header">
          <h3>{i18n.t('common:preview')}</h3>
        </div>
        <p className="section-description">
          {i18n.t('settings:livetv.widgets.previewSub')}
        </p>
        <div className="widget-preview-area">
          <div
            className="widget-preview-scaled"
            style={{
              transform: `scale(${widgetScale})`,
              transformOrigin: 'top left',
            }}
          >
            <div className="widget-preview-box">
              <div
                className="widget-preview-header"
                style={{ background: `rgba(0,0,0,${widgetBgOpacity})` }}
              >
                {i18n.t('settings:livetv.widgets.recent5')}
              </div>
              <div
                className="widget-preview-list"
                style={{ background: `rgba(0,0,0,${widgetBgOpacity})` }}
              >
                <div className="widget-preview-item">
                  <span className="widget-preview-name">Animal Planet</span>
                  <span className="widget-preview-sep"> - </span>
                  <span className="widget-preview-prog">I Was Prey</span>
                </div>
                <div className="widget-preview-item">
                  <span className="widget-preview-name">BET</span>
                  <span className="widget-preview-sep"> - </span>
                  <span className="widget-preview-prog">Martin</span>
                </div>
              </div>
            </div>
          </div>
          <div
            aria-hidden="true"
            style={{
              height: `${Math.round(208 * widgetScale) + 8}px`,
              width: `${Math.round(700 * widgetScale)}px`,
              pointerEvents: 'none',
            }}
          />
        </div>
      </div>

      <div className="settings-section">
        <div className="section-header">
          <h3>{i18n.t('settings:livetv.widgets.sportsOverlay')}</h3>
        </div>
        <p className="section-description">
          {i18n.t('settings:livetv.widgets.sportsOverlaySub')}
        </p>

        <div className="timeshift-settings">
          <SliderRow
            label={i18n.t('settings:livetv.widgets.overlayScale')}
            hint={i18n.t('settings:livetv.widgets.overlayScaleHint')}
            min={50}
            max={400}
            step={5}
            value={sportsScalePercent}
            display={`${sportsScalePercent}%`}
            onChange={(value) => onSportsScaleChange(value / 100)}
          />

          <div className="timeshift-presets-label">
            {i18n.t('settings:livetv.widgets.scalePresets')}
          </div>
          <div className="timeshift-presets" style={{ marginBottom: '18px' }}>
            {[75, 100, 125, 150].map((percent) => (
              <button
                key={percent}
                className={`timeshift-preset-btn${sportsScalePercent === percent ? ' active' : ''}`}
                onClick={() => onSportsScaleChange(percent / 100)}
              >
                {percent}%
              </button>
            ))}
          </div>

          <SliderRow
            label={i18n.t('settings:livetv.widgets.bgOpacity')}
            hint={i18n.t('settings:livetv.widgets.sportsBgOpacityHint')}
            min={5}
            max={95}
            step={5}
            value={sportsOpacityPercent}
            display={`${sportsOpacityPercent}%`}
            onChange={(value) => onSportsBgOpacityChange(value / 100)}
          />

          <button
            className="sync-btn"
            onClick={() => {
              onSportsScaleChange(1);
              onSportsBgOpacityChange(0.7);
            }}
            style={{ maxWidth: '200px' }}
          >
            {i18n.t('common:resetToDefaults')}
          </button>
        </div>

        <div style={{ marginTop: '16px' }}>
          <div
            style={{
              background: `linear-gradient(to bottom, rgba(0,0,0,${sportsBgOpacity}) 0%, rgba(0,0,0,${(sportsBgOpacity * 0.5).toFixed(2)}) 60%, transparent 100%)`,
              padding: '8px 12px 20px',
              borderRadius: '8px',
              transform: `scaleY(${sportsScale})`,
              transformOrigin: 'top center',
              overflow: 'hidden',
            }}
          >
            <div style={{ display: 'flex', gap: '12px', overflowX: 'hidden' }}>
              <div className="widget-preview-item">
                <span className="widget-preview-name">NFL</span>
                <span className="widget-preview-sep"> KC 17 vs SF 14 </span>
                <span className="widget-preview-prog">Q3 8:42</span>
              </div>
              <div className="widget-preview-item">
                <span className="widget-preview-name">NBA</span>
                <span className="widget-preview-sep"> LAL 89 vs BOS 92 </span>
                <span className="widget-preview-prog">Q4 2:15</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
