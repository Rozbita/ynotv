import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { LibraryFolder, LocalEntry, ScannedFile } from './types';
import {
  readScannedFolders,
  readLocalLibrary,
  addLocalEntries,
  removeLocalEntries,
  ensureLocalLibraryLoaded,
  parseFilename,
  updateLocalEntryPath,
  markEntriesAvailability,
} from './local-library';
import { buildTmdbEntryForFolder } from './scan';

const LAST_SYNC_KEY = 'ynotv.local.last_sync_time';
const SYNC_THROTTLE_MS = 3 * 60 * 1000; // 3 minutes throttle between automatic background scans
const AUTO_SYNC_INTERVAL_MS = 15 * 60 * 1000; // auto sync every 15 minutes while app is open

let isSyncing = false;

export async function syncLocalFolders(
  tmdbToken?: string | null,
  force = false,
): Promise<{ added: number; removed: number; unavailable: number; restored: number }> {
  if (isSyncing) return { added: 0, removed: 0, unavailable: 0, restored: 0 };

  const lastSync = Number(localStorage.getItem(LAST_SYNC_KEY) || 0);
  if (!force && Date.now() - lastSync < SYNC_THROTTLE_MS) {
    return { added: 0, removed: 0, unavailable: 0, restored: 0 };
  }

  // Ensure the authoritative library/folders are loaded from SQLite before
  // diffing against them, so a boot-time scan never races the migration.
  await ensureLocalLibraryLoaded();

  const folders = readScannedFolders();
  if (folders.length === 0) return { added: 0, removed: 0, unavailable: 0, restored: 0 };

  isSyncing = true;
  localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));

  try {
    const currentLibrary = readLocalLibrary();
    const existingPathMap = new Map(currentLibrary.map((e) => [e.path.toLowerCase(), e]));

    // Check which folder roots exist on disk (distinguishing unplugged drives vs active folders)
    const missingFolderRoots: string[] = [];
    const activeFolders: LibraryFolder[] = [];

function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/[\W_]+/g, ' ')
    .trim();
}

    for (const folder of folders) {
      try {
        const exists = await invoke<boolean>('check_path_exists', { path: folder.path });
        if (exists) {
          activeFolders.push(folder);
        } else {
          missingFolderRoots.push(folder.path.replace(/\\/g, '/').toLowerCase());
        }
      } catch (err) {
        console.warn(`[AutoSync] Could not check folder root ${folder.path}:`, err);
        // Fail-open: do NOT assume folder is missing on IPC failure; treat as active to prevent false unavailables
        activeFolders.push(folder);
      }
    }

    // Track which scan root each file came from so series folders can derive
    // the series title from the folder path (one cached TMDB lookup per series).
    const allScanned: Array<{ file: ScannedFile; folder: LibraryFolder }> = [];
    const successfullyScannedFolders = new Set<string>();

    for (const folder of activeFolders) {
      try {
        const files = await invoke<ScannedFile[]>('scan_local_folder', { folder: folder.path });
        if (Array.isArray(files)) {
          for (const file of files) allScanned.push({ file, folder });
          successfullyScannedFolders.add(folder.path.replace(/\\/g, '/').toLowerCase());
        }
      } catch (err) {
        console.warn(`[AutoSync] Could not scan folder ${folder.path}:`, err);
      }
    }

    const scannedPathSet = new Set(
      allScanned.map(({ file }) => file.path.replace(/\\/g, '/').toLowerCase()),
    );

    // 1. Identify entries whose parent folders are missing (offline drive / moved folder)
    const folderMissingEntryIds: string[] = [];
    for (const entry of currentLibrary) {
      const normEntryPath = entry.path.replace(/\\/g, '/').toLowerCase();
      const isUnderMissingFolder = missingFolderRoots.some((f) =>
        normEntryPath.startsWith(f.endsWith('/') ? f : `${f}/`) || normEntryPath === f,
      );
      if (isUnderMissingFolder) {
        folderMissingEntryIds.push(entry.id);
      }
    }

    // 2. Identify missing files under active scanned folders
    const missingFromScannedFolder: LocalEntry[] = [];
    for (const entry of currentLibrary) {
      const normEntryPath = entry.path.replace(/\\/g, '/').toLowerCase();
      const isUnderScannedFolder = Array.from(successfullyScannedFolders).some((f) =>
        normEntryPath.startsWith(f.endsWith('/') ? f : `${f}/`),
      );
      if (isUnderScannedFolder && !scannedPathSet.has(normEntryPath)) {
        missingFromScannedFolder.push(entry);
      }
    }

    // 3. Newly scanned files
    let unassignedScannedFiles = allScanned.filter(
      ({ file }) => !existingPathMap.has(file.path.toLowerCase()),
    );

    // 4. Renamed file detection:
    // If a missing entry and a newly scanned file share the same folder and matching characteristics
    // (e.g. matching parsed season/episode, or title), update the path rather than discarding overrides.
    const relinkedIds = new Set<string>();
    const relinkedFilePaths = new Set<string>();

    for (const missingEntry of missingFromScannedFolder) {
      const missingDir = missingEntry.path.replace(/\\/g, '/').replace(/\/[^\/]+$/, '').toLowerCase();
      const candidate = unassignedScannedFiles.find(({ file }) => {
        if (relinkedFilePaths.has(file.path.toLowerCase())) return false;
        const fileDir = file.path.replace(/\\/g, '/').replace(/\/[^\/]+$/, '').toLowerCase();
        if (fileDir !== missingDir) return false;

        const parsed = parseFilename(file.filename);
        if (missingEntry.type === 'show' && missingEntry.season != null && missingEntry.episode != null) {
          return parsed.season === missingEntry.season && parsed.episode === missingEntry.episode;
        }
        if (missingEntry.type === 'movie' && parsed.title) {
          const candNorm = normalizeTitle(parsed.title);
          const entryNorm = missingEntry.title ? normalizeTitle(missingEntry.title) : '';
          const origFilenameNorm = missingEntry.filename ? normalizeTitle(parseFilename(missingEntry.filename).title) : '';
          const titleMatches = candNorm === entryNorm || candNorm === origFilenameNorm;
          if (titleMatches) {
            if (parsed.year && missingEntry.year) {
              return parsed.year === missingEntry.year;
            }
            return true;
          }
        }
        return false;
      });

      if (candidate) {
        updateLocalEntryPath(missingEntry.id, candidate.file.path, candidate.file.filename);
        relinkedIds.add(missingEntry.id);
        relinkedFilePaths.add(candidate.file.path.toLowerCase());
      }
    }

    if (relinkedFilePaths.size > 0) {
      unassignedScannedFiles = unassignedScannedFiles.filter(
        ({ file }) => !relinkedFilePaths.has(file.path.toLowerCase()),
      );
    }

    // 5. Add newly added files
    const addedEntries: LocalEntry[] = [];
    for (const { file, folder } of unassignedScannedFiles) {
      const info = parseFilename(file.filename);
      try {
        const entry = await buildTmdbEntryForFolder(
          file,
          folder.type,
          folder.path,
          tmdbToken ?? null,
        );
        addedEntries.push(entry);
      } catch {
        addedEntries.push({
          id: file.path,
          path: file.path,
          filename: file.filename,
          title: info.title,
          year: info.year,
          type: info.type,
          resolution: info.resolution,
          addedAt: Date.now(),
          needsReview: true,
        });
      }
    }

    if (addedEntries.length > 0) {
      addLocalEntries(addedEntries);
    }

    // 6. Update availability:
    // Mark files missing from disk or missing folder roots as unavailable.
    // Mark files previously unavailable that are now present as available.
    const trulyMissingIds = [
      ...folderMissingEntryIds,
      ...missingFromScannedFolder
        .filter((e) => !relinkedIds.has(e.id))
        .map((e) => e.id),
    ];

    const restoredIds: string[] = [];
    for (const entry of currentLibrary) {
      const normEntryPath = entry.path.replace(/\\/g, '/').toLowerCase();
      if (entry.unavailable && scannedPathSet.has(normEntryPath)) {
        restoredIds.push(entry.id);
      }
    }

    if (trulyMissingIds.length > 0 || restoredIds.length > 0) {
      markEntriesAvailability(trulyMissingIds, restoredIds);
    }

    return {
      added: addedEntries.length,
      removed: 0,
      unavailable: trulyMissingIds.length,
      restored: restoredIds.length,
    };
  } finally {
    isSyncing = false;
  }
}

/**
 * Hook to automatically sync local folders when LocalTab mounts and periodically in the background.
 */
export function useAutoLocalSync(
  tmdbToken?: string | null,
  onSyncResult?: (result: { added: number; removed: number; unavailable?: number; restored?: number }) => void,
) {
  const onSyncResultRef = useRef(onSyncResult);
  onSyncResultRef.current = onSyncResult;

  useEffect(() => {
    let alive = true;

    // Run initial sync on mount (throttled)
    syncLocalFolders(tmdbToken).then((res) => {
      if (alive && (res.added > 0 || res.removed > 0 || res.unavailable > 0 || res.restored > 0)) {
        onSyncResultRef.current?.(res);
      }
    });

    // Periodic sync interval
    const timer = setInterval(() => {
      syncLocalFolders(tmdbToken).then((res) => {
        if (alive && (res.added > 0 || res.removed > 0 || res.unavailable > 0 || res.restored > 0)) {
          onSyncResultRef.current?.(res);
        }
      });
    }, AUTO_SYNC_INTERVAL_MS);

    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [tmdbToken]);
}
