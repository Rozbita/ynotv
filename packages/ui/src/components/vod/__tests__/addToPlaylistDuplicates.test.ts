import { describe, it, expect } from 'vitest';
import { isSameItemOrFile, normalizePathOrId } from '../AddToPlaylistModal';
import type { PlaylistItem } from '../../../stores/vodPlaylistStore';

describe('AddToPlaylist duplicate detection', () => {
  it('normalizes Windows backslashes and casing', () => {
    expect(normalizePathOrId('C:\\Media\\Folder\\Movie.mkv')).toBe('c:/media/folder/movie.mkv');
    expect(normalizePathOrId('c:/media/folder/movie.mkv')).toBe('c:/media/folder/movie.mkv');
    expect(normalizePathOrId(null)).toBe('');
    expect(normalizePathOrId(undefined)).toBe('');
  });

  it('detects duplicate local file by directUrl regardless of slash type and case', () => {
    const existing: PlaylistItem = {
      id: 'item_1',
      playlistId: 'pl_1',
      itemType: 'movie',
      mediaId: 'local_1',
      title: 'Inception',
      directUrl: 'C:\\Videos\\Movies\\Inception (2010).mkv',
      sourceId: 'local',
      addedAt: Date.now(),
    };

    const duplicateCandidate = {
      directUrl: 'c:/videos/movies/inception (2010).mkv',
      mediaId: 'local_2',
      sourceId: 'local',
    };

    expect(isSameItemOrFile(existing, duplicateCandidate)).toBe(true);
  });

  it('detects duplicate local file by mediaId with slash normalization', () => {
    const existing: PlaylistItem = {
      id: 'item_1',
      playlistId: 'pl_1',
      itemType: 'episode',
      mediaId: 'local_D:\\TV\\Show\\S01E01.mp4',
      title: 'Show S1E1',
      sourceId: 'local',
      addedAt: Date.now(),
    };

    const duplicateCandidate = {
      mediaId: 'local_d:/tv/show/s01e01.mp4',
      sourceId: 'local',
    };

    expect(isSameItemOrFile(existing, duplicateCandidate)).toBe(true);
  });

  it('does not falsely match different files in the same directory', () => {
    const existing: PlaylistItem = {
      id: 'item_1',
      playlistId: 'pl_1',
      itemType: 'episode',
      mediaId: 'local_ep1',
      title: 'Show S1E1',
      directUrl: 'C:/TV/Show/S01E01.mp4',
      sourceId: 'local',
      addedAt: Date.now(),
    };

    const differentEpisode = {
      directUrl: 'C:/TV/Show/S01E02.mp4',
      mediaId: 'local_ep2',
      sourceId: 'local',
    };

    expect(isSameItemOrFile(existing, differentEpisode)).toBe(false);
  });

  it('matches provider VOD items by mediaId and sourceId', () => {
    const existing: PlaylistItem = {
      id: 'item_1',
      playlistId: 'pl_1',
      itemType: 'movie',
      mediaId: 'vod_99482',
      title: 'Avatar',
      sourceId: 'src_xtream',
      addedAt: Date.now(),
    };

    const sameProviderItem = {
      mediaId: 'vod_99482',
      sourceId: 'src_xtream',
    };

    const differentProviderItem = {
      mediaId: 'vod_99482',
      sourceId: 'src_other',
    };

    expect(isSameItemOrFile(existing, sameProviderItem)).toBe(true);
    expect(isSameItemOrFile(existing, differentProviderItem)).toBe(false);
  });
});
