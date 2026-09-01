import { PlaybackHeader } from './PlaybackHeader';

interface BackButtonOverlayProps {
  visible: boolean;
  sourceView: 'movies' | 'series' | 'dvr' | 'stremio' | 'nuvio' | 'jellyfin' | null;
  onBack: () => void;
  title?: string | null;
  subtitle?: string | null;
  quality?: string | null;
  sourceName?: string | null;
  onOpenDetails?: () => void;
}

export function BackButtonOverlay(props: BackButtonOverlayProps) {
  return <PlaybackHeader {...props} />;
}
