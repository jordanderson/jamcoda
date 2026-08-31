import { v4 as uuidv4 } from 'uuid';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import * as jamcorderService from './jamcorder.service';
import { jamcorderUuidFromPath } from './jamcorder.service';
import * as FileModel from '../models/File';
import { parseJmxMetadata, jmxTimeToDate } from '../utils/jmxParser';
import type { SyncProgress, JamcorderFileEntry } from '../types/index';
import { getMidiDuration } from '../utils/midiUtils';
import { sleep } from '@core/cli/args';

const MIDI_DIR = process.env.JAMCODA_MIDI_DIR || 'data/midi';
// Pause between individual file downloads to keep low-power firmware happy.
const DOWNLOAD_PACE_MS = Number(process.env.JAMCODA_SYNC_DOWNLOAD_PACE_MS || 300);
/**
 * Device assets at or below this size hold no music and are not imported.
 *
 * The firmware sometimes opens an asset and closes it without recording a note
 * — occasionally hundreds in a burst (118 in 42s on 2026-02-19). Those land as
 * valid but empty MIDI files: header + JMX trailer + end-of-track. On the
 * observed device every one is 256 bytes (truncated leftovers are 22), while
 * the smallest real recording seen is 2397 bytes, so the threshold sits in a
 * wide gap. Tunable in case another firmware writes fatter stubs.
 */
const EMPTY_ASSET_MAX_BYTES = Number(process.env.JAMCODA_SYNC_EMPTY_ASSET_MAX_BYTES || 1024);

const syncJobs = new Map<string, SyncProgress>();

export async function startSync(full = false): Promise<string> {
  const syncId = uuidv4();
  const progress: SyncProgress = {
    syncId,
    status: 'in_progress',
    filesFound: 0,
    filesDownloaded: 0,
    currentFile: null,
    errors: [],
    warnings: [],
    emptySkipped: 0
  };

  syncJobs.set(syncId, progress);

  // Run sync in background
  performSync(progress, full).catch(err => {
    console.error('Sync error:', err);
    progress.status = 'error';
    progress.errors.push({ file: 'sync', error: err.message });
  });

  return syncId;
}

export function getSyncProgress(syncId: string): SyncProgress | null {
  return syncJobs.get(syncId) || null;
}

async function performSync(progress: SyncProgress, full = false) {
  try {
    console.log(`Starting sync${full ? ' (full re-sync)' : ''}...`);

    // 1. Discover remote recordings (library API first, filesystem walk fallback).
    //    On steady-state syncs, a high-water mark from the last clean sync lets
    //    discovery stop at the newest already-synced asset instead of walking
    //    the entire library.
    const remoteFiles = await discoverFiles(full);
    console.log(`Found ${remoteFiles.length} MIDI files on device to consider`);

    // 2. Compare against what we already have; download only new or changed files.
    //    Unchanged files are skipped entirely, which is the big win over the old
    //    walk-and-download-everything approach.
    const existingByPath = new Map(FileModel.findAll().map(file => [file.jamcorder_path, file]));
    const toDownload: Array<{ entry: JamcorderFileEntry; existing?: ReturnType<typeof FileModel.findAll>[number] }> = [];
    let skipped = 0;
    let emptySkipped = 0;
    let maxSyncedAssetIdx = -1;
    let hadErrors = false;

    for (const entry of remoteFiles) {
      const existing = existingByPath.get(entry.path);
      if (!existing) {
        // Never import an empty asset. Skipping before the download keeps them
        // out of the database and off disk entirely, rather than filtering them
        // back out of every view later. There is nothing to lose by skipping:
        // if the device ever appends to one it grows past the threshold and the
        // next sync picks it up as a normal new file.
        if (entry.size <= EMPTY_ASSET_MAX_BYTES) {
          emptySkipped++;
          if (entry.assetIdx != null && entry.assetIdx > maxSyncedAssetIdx) {
            maxSyncedAssetIdx = entry.assetIdx;
          }
          continue;
        }
        toDownload.push({ entry });
      } else if (entry.size > existing.file_size) {
        // File grew (e.g. the day's asset was reopened after a device restart,
        // or is still being recorded). Re-sync it.
        toDownload.push({ entry, existing });
      } else if (entry.size < existing.file_size) {
        // The device copy is smaller than what we already synced. On the
        // observed device this happens when an old file was truncated or left
        // as a header-only stub. Overwriting good local data with a smaller
        // device copy risks data loss, so skip it and warn.
        const warning = 'Device file is smaller than the synced copy (possibly truncated on device); skipped to avoid overwriting local data';
        console.warn(`${entry.name}: ${warning}`);
        progress.warnings.push({ file: entry.name, warning });
        skipped++;
        // Intentionally kept local copy counts as handled for the water mark.
        if (entry.assetIdx != null && entry.assetIdx > maxSyncedAssetIdx) {
          maxSyncedAssetIdx = entry.assetIdx;
        }
      } else {
        skipped++;
        if (entry.assetIdx != null && entry.assetIdx > maxSyncedAssetIdx) {
          maxSyncedAssetIdx = entry.assetIdx;
        }
      }
    }

    progress.filesFound = toDownload.length;
    progress.emptySkipped = emptySkipped;
    console.log(
      `${toDownload.length} files to sync (${skipped} unchanged or kept, skipped`
      + `${emptySkipped > 0 ? `; ${emptySkipped} empty asset${emptySkipped !== 1 ? 's' : ''} ignored` : ''})`
    );

    // 3. Download each file
    const importedIds: number[] = [];
    for (const { entry, existing } of toDownload) {
      try {
        progress.currentFile = entry.name;
        console.log(`Syncing: ${entry.name}`);

        const fileId = existing
          ? await resyncFile(entry, existing)
          : await syncNewFile(entry);

        if (fileId != null) {
          importedIds.push(fileId);
          progress.filesDownloaded++;
          console.log(`Synced ${progress.filesDownloaded}/${toDownload.length}: ${entry.name}`);
        } else {
          emptySkipped++;
          progress.emptySkipped = emptySkipped;
        }
        if (entry.assetIdx != null && entry.assetIdx > maxSyncedAssetIdx) {
          maxSyncedAssetIdx = entry.assetIdx;
        }
        await sleep(DOWNLOAD_PACE_MS);
      } catch (error) {
        hadErrors = true;
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error(`Error syncing ${entry.name}:`, errorMsg);
        progress.errors.push({ file: entry.name, error: errorMsg });
      }
    }

    // 3.5. Newly imported files that carry Jamcorder passage bookmarks get
    //      predictions auto-run right after the sync, so the device's own
    //      passage boundaries become reviewable segments without a manual
    //      "Run Predictions" step. Only files with bookmarks are touched and
    //      any failure is logged, never fatal to the sync.
    await runPredictionsForBookmarkedFiles(importedIds);

    // 4. Record a high-water mark only after a completely clean pass. If any
    //    download failed, the errored asset(s) are above any water mark we could
    //    safely record, so leave the old mark in place and re-check next time.
    if (!hadErrors && remoteFiles.length > 0) {
      const newestUuid = remoteFiles[0].path ? jamcorderUuidFromPath(remoteFiles[0].path) : null;
      if (maxSyncedAssetIdx >= 0 && newestUuid) {
        FileModel.updateSyncHighWater(maxSyncedAssetIdx, newestUuid);
        console.log(`High-water mark updated to asset ${maxSyncedAssetIdx} (${newestUuid})`);
      }
    }

    // Update sync metadata
    FileModel.updateSyncMetadata(progress.filesDownloaded);

    progress.status = 'completed';
    progress.currentFile = null;
    console.log('Sync completed successfully');
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('Sync failed:', errorMsg);
    progress.status = 'error';
    progress.errors.push({ file: 'sync', error: errorMsg });
  }
}

/**
 * Discover remote recordings. Primary source is a recursive walk over the
 * detailed file listing: it is only a handful of cheap directory reads (the
 * device tree is shallow) and returns real file sizes, which is what enables
 * skip-unchanged syncs. It is far gentler on this device's firmware than the
 * library API, which has proven crash-prone on low-power hardware.
 *
 * The library API is kept as a fallback (and honors the high-water mark for
 * steady-state syncs when it is reachable).
 */
async function discoverFiles(full: boolean): Promise<JamcorderFileEntry[]> {
  try {
    const walked = await discoverFilesDetailed('/JAMC/');
    if (walked.length > 0) {
      console.log(`Discovered ${walked.length} files via filesystem walk`);
      return walked;
    }
  } catch (error) {
    console.error('Filesystem walk failed:', error);
  }

  try {
    let options: { newerThanAssetIdx?: number; jamcorderUuid?: string } | undefined;
    if (!full) {
      const metadata = FileModel.getSyncMetadata();
      if (metadata.high_water_asset_idx != null && metadata.high_water_jamcorder_uuid) {
        options = {
          newerThanAssetIdx: metadata.high_water_asset_idx,
          jamcorderUuid: metadata.high_water_jamcorder_uuid
        };
      }
    }

    const assets = await jamcorderService.listLibraryAssets(options);
    if (assets.length > 0) {
      console.log(`Discovered ${assets.length} assets via library API`);
      return assets.map(asset => ({
        path: asset.midiPath,
        name: basename(asset.midiPath),
        size: asset.filesize ?? 0,
        modified: 0, // library API does not expose mtime; size drives change detection
        type: 'file' as const,
        totalMillis: asset.jmxEof?.totalMillis ?? null,
        isCurrentAsset: asset.isCurrentAsset ?? false,
        assetIdx: asset.assetIdx
      }));
    }
  } catch (error) {
    console.error('Library API unavailable:', error);
  }

  return [];
}

async function discoverFilesDetailed(basePath: string): Promise<JamcorderFileEntry[]> {
  const allFiles: JamcorderFileEntry[] = [];

  async function traverse(dirPath: string) {
    let response;
    try {
      response = await jamcorderService.listFilesDetailed(dirPath);
    } catch (error) {
      // Propagate when the very first listing fails (device unreachable);
      // otherwise skip the directory and continue with siblings.
      if (allFiles.length === 0 && dirPath === basePath) {
        throw error;
      }
      console.error(`Error traversing ${dirPath}:`, error);
      return; // Continue with other directories
    }

    for (const file of response.files) {
      const fullPath = response.dir + file.filename;
      if (file.isDirectory) {
        await traverse(fullPath);
      } else if (/\.midi?$/i.test(file.filename)) {
        allFiles.push({
          name: file.filename,
          path: fullPath,
          size: file.sizeBytes,
          modified: file.modifiedLocalTime,
          type: 'file',
          assetIdx: assetIdxFromFilename(file.filename)
        });
      }
    }
  }

  await traverse(basePath);
  return allFiles;
}

/** Parse the device-local asset index from `Jmx-A00042-...` style filenames. */
function assetIdxFromFilename(filename: string): number | undefined {
  const match = filename.match(/^Jmx-A(\d+)-/);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

/**
 * Download a brand-new file, parse its JMX metadata, and persist it.
 * Returns the new file id, or null when the asset turned out to be empty and
 * was not imported.
 */
async function syncNewFile(entry: JamcorderFileEntry): Promise<number | null> {
  const data = await jamcorderService.downloadFile(entry.path);
  if (data.length === 0) {
    throw new Error('Downloaded empty file (device may be mid-recording); will retry next sync');
  }
  const jmx = parseJmxMetadata(data);

  // Backstop for an empty asset that slipped past the size check (a fatter stub
  // than the ones we have measured). This trusts the device's own EOF trailer
  // rather than a local parse: a MIDI parse failure also yields "0 duration",
  // and discarding a file on that basis would lose real data. No metadata, or
  // any note at all, means keep it.
  if (jmx.totalNotes === 0 && jmx.totalMillis === 0) {
    console.log(`  Empty recording (0 notes); not imported`);
    return null;
  }

  const date = jmxTimeToDate(jmx.time ?? '') ?? extractDate(entry.path);
  const localPath = resolveLocalPath(date, entry.name);

  const dir = dirname(localPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(localPath, data);
  const midiDuration = getMidiDuration(localPath);

  return FileModel.create({
    jamcorderPath: entry.path,
    localPath,
    filename: entry.name,
    fileSize: data.length,
    jamcorderModified: entry.modified || 0,
    dateRecorded: date,
    midiDuration,
    assetUuid: jmx.assetUuid,
    jmxEofOffset: jmx.eofFileOffset,
    bookmarksJson: serializeJmxList(jmx.bookmarks),
    skipsJson: serializeJmxList(jmx.skips)
  });
}

function serializeJmxList<T>(items: T[] | undefined): string | null {
  return items && items.length > 0 ? JSON.stringify(items) : null;
}

/**
 * Re-sync a file that changed on the device. For files we know the JMX trailer
 * offset of, fetch only the bytes appended since the last sync via
 * `download/offset` and splice them in (the trailer region is rewritten, so we
 * re-fetch from the stored offset to EOF). This keeps re-sync of a live,
 * growing recording incremental instead of re-downloading the whole file. Any
 * doubt (missing metadata, truncated local file, unparseable result) falls back
 * to a full re-download.
 */
async function resyncFile(entry: JamcorderFileEntry, existing: ReturnType<typeof FileModel.findAll>[number]): Promise<number> {
  const localPath = existing.local_path;
  const eofOffset = existing.jmx_eof_offset;
  const newSize = entry.size;
  const localSize = existsSync(localPath) ? statSync(localPath).size : 0;

  if (eofOffset && eofOffset > 0 && newSize > eofOffset && localSize >= eofOffset) {
    try {
      const tail = await jamcorderService.downloadFileRange(entry.path, eofOffset, -1);
      const head = readFileSync(localPath).subarray(0, eofOffset);
      const spliced = Buffer.concat([head, tail]);
      writeFileSync(localPath, spliced);

      const midiDuration = getMidiDuration(localPath);
      if (midiDuration > 0) {
        // Parse the spliced file (not the tail alone, which has no SMF header)
        // to learn the NEW renewable-trailer offset for the next sync.
        const jmx = parseJmxMetadata(spliced);
        FileModel.updateSyncedFile(existing.id, {
          fileSize: newSize,
          jamcorderModified: entry.modified || existing.jamcorder_modified,
          jmxEofOffset: jmx.eofFileOffset ?? eofOffset,
          midiDuration,
          bookmarksJson: serializeJmxList(jmx.bookmarks),
          skipsJson: serializeJmxList(jmx.skips)
        });
        console.log(`  Incremental tail sync (${tail.length} bytes appended)`);
        return existing.id;
      }
      console.error('  Incremental tail sync produced an unparseable file; re-downloading whole');
    } catch (error) {
      console.error('  Incremental tail sync failed; re-downloading whole:', error);
    }
  }

  const data = await jamcorderService.downloadFile(entry.path);
  if (data.length === 0) {
    throw new Error('Downloaded empty file (device may be mid-recording); will retry next sync');
  }
  writeFileSync(localPath, data);
  const jmx = parseJmxMetadata(data);
  const midiDuration = getMidiDuration(localPath);
  FileModel.updateSyncedFile(existing.id, {
    fileSize: data.length,
    jamcorderModified: entry.modified || existing.jamcorder_modified,
    assetUuid: jmx.assetUuid ?? existing.asset_uuid,
    jmxEofOffset: jmx.eofFileOffset,
    midiDuration,
    bookmarksJson: serializeJmxList(jmx.bookmarks),
    skipsJson: serializeJmxList(jmx.skips)
  });
  return existing.id;
}

/**
 * Run the prediction pipeline over files that carried Jamcorder passage
 * bookmarks in this sync. Bookmarks have no names, so we never auto-create
 * annotations here; the model names each passage and the results land in the
 * review queue as `prediction_reviews`, split at the device's own boundaries.
 *
 * Conservative by design: only files with stored bookmarks are touched, only
 * if a model file exists, and every failure is logged rather than thrown so a
 * bad file can never break the sync.
 */
async function runPredictionsForBookmarkedFiles(importedIds: number[]): Promise<void> {
  if (importedIds.length === 0) return;

  const modelPath = resolve(process.env.JAMCODA_ML_MODEL_PATH || 'data/ml/model.json');
  if (!existsSync(modelPath)) {
    console.log('No model file found; skipping auto-predictions for bookmarked files');
    return;
  }

  const { runPredictionImport } = await import('./predictionImport');
  const config = {
    minWindowConfidence: 0.45,
    smoothingWindows: 5,
    minSegmentSec: 8,
    minSegmentConfidence: 0.3,
    mergeGapSec: 3
  };

  let predicted = 0;
  for (const fileId of importedIds) {
    try {
      const file = FileModel.findById(fileId);
      if (!file || !file.bookmarks_json || file.is_complete === 1) continue;

      const result = runPredictionImport({
        fileId,
        modelPath,
        config,
        clearUnpromoted: true,
        rootDir: process.cwd()
      });
      predicted++;
      console.log(
        `  Auto-predicted ${result.segments.length} segment(s) for ${file.filename} `
        + `(bookmarks=${result.bookmarks.length}, splits=${result.bookmarkSplitCount})`
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Auto-predict failed for file ${fileId}: ${errorMsg}`);
    }
  }
  if (predicted > 0) {
    console.log(`Auto-predicted segments for ${predicted} bookmarked file(s).`);
  }
}

function basename(filepath: string): string {
  return filepath.split('/').pop() || filepath;
}

function extractDate(path: string): string {
  // Extract filename from path
  const filename = basename(path);

  // Try to extract date from Jamcorder filename format: Jmx-A#####-Month-Day-Year.mid
  // Example: Jmx-A00001-Oct-14-2025.mid -> 2025-10-14
  const filenameMatch = filename.match(/([A-Z][a-z]{2})-(\d{1,2})-(\d{4})/);
  if (filenameMatch) {
    const monthStr = filenameMatch[1]; // e.g., "Oct"
    const day = filenameMatch[2].padStart(2, '0');
    const year = filenameMatch[3];

    // Convert month name to number
    const months: Record<string, string> = {
      'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04',
      'May': '05', 'Jun': '06', 'Jul': '07', 'Aug': '08',
      'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
    };

    const month = months[monthStr];
    if (month) {
      return `${year}-${month}-${day}`;
    }
  }

  // Try to extract YYYY-MM-DD or YYYY/MM/DD from path
  // Example: /JAMC/2025/01/15/file.mid -> 2025-01-15
  const match = path.match(/\/(\d{4})\/(\d{1,2})\/(\d{1,2})\//);
  if (match) {
    const year = match[1];
    const month = match[2].padStart(2, '0');
    const day = match[3].padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  // Try YYYY-MM-DD format
  const match2 = path.match(/\/(\d{4})-(\d{2})-(\d{2})\//);
  if (match2) {
    return `${match2[1]}-${match2[2]}-${match2[3]}`;
  }

  // Try YYYY/MM format (day unknown, use 01)
  const match3 = path.match(/\/(\d{4})\/(\d{1,2})\//);
  if (match3) {
    const year = match3[1];
    const month = match3[2].padStart(2, '0');
    return `${year}-${month}-01`;
  }

  // Fallback to current date
  const now = new Date();
  return now.toISOString().split('T')[0];
}

function resolveLocalPath(date: string, filename: string): string {
  let localPath = join(MIDI_DIR, date, filename);
  let counter = 1;

  while (existsSync(localPath)) {
    const lastDotIndex = filename.lastIndexOf('.');
    if (lastDotIndex === -1) {
      localPath = join(MIDI_DIR, date, `${filename}_${counter}`);
    } else {
      const ext = filename.substring(lastDotIndex);
      const base = filename.substring(0, lastDotIndex);
      localPath = join(MIDI_DIR, date, `${base}_${counter}${ext}`);
    }
    counter++;
  }

  return localPath;
}