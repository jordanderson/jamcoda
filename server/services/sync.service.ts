import { v4 as uuidv4 } from 'uuid';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import * as jamcorderService from './jamcorder.service.js';
import * as FileModel from '../models/File.js';
import type { SyncProgress, JamcorderFileEntry } from '../types/index.js';
import { getMidiDuration } from '../utils/midiUtils.js';

const MIDI_DIR = process.env.JAMCODA_MIDI_DIR || 'data/midi';

const syncJobs = new Map<string, SyncProgress>();

export async function startSync(): Promise<string> {
  const syncId = uuidv4();
  const progress: SyncProgress = {
    syncId,
    status: 'in_progress',
    filesFound: 0,
    filesDownloaded: 0,
    currentFile: null,
    errors: []
  };

  syncJobs.set(syncId, progress);

  // Run sync in background
  performSync(syncId, progress).catch(err => {
    console.error('Sync error:', err);
    progress.status = 'error';
    progress.errors.push({ file: 'sync', error: err.message });
  });

  return syncId;
}

export function getSyncProgress(syncId: string): SyncProgress | null {
  return syncJobs.get(syncId) || null;
}

async function performSync(syncId: string, progress: SyncProgress) {
  try {
    console.log('Starting sync...');

    // 1. Discover all files recursively
    const allFiles = await discoverFiles('/JAMC/');
    console.log(`Found ${allFiles.length} total MIDI files`);

    // 2. Filter out already-synced files
    const newFiles = allFiles.filter(file => !FileModel.existsByPath(file.path));
    progress.filesFound = newFiles.length; // Set to NEW files count, not all files
    console.log(`${newFiles.length} new files to sync`);

    // 3. Download each file
    for (const file of newFiles) {
      try {
        progress.currentFile = file.name;
        console.log(`Downloading: ${file.name}`);

        const data = await jamcorderService.downloadFile(file.path);
        const date = extractDate(file.path);
        const localPath = resolveLocalPath(date, file.name);

        // Save file
        const dir = dirname(localPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(localPath, data);
        const midiDuration = getMidiDuration(localPath);

        // Save to DB
        FileModel.create({
          jamcorderPath: file.path,
          localPath,
          filename: file.name,
          fileSize: data.length,
          jamcorderModified: 0, // We don't have modified timestamp from API
          dateRecorded: date,
          midiDuration
        });

        progress.filesDownloaded++;
        console.log(`Downloaded ${progress.filesDownloaded}/${newFiles.length}: ${file.name}`);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error(`Error downloading ${file.name}:`, errorMsg);
        progress.errors.push({ file: file.name, error: errorMsg });
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

async function discoverFiles(basePath: string): Promise<JamcorderFileEntry[]> {
  const allFiles: JamcorderFileEntry[] = [];

  async function traverse(dirPath: string) {
    try {
      const response = await jamcorderService.listFiles(dirPath);

      for (const filename of response.files) {
        const isDirectory = filename.endsWith('/');
        const fullPath = response.dir + filename;

        if (isDirectory) {
          // Recursively traverse subdirectory
          await traverse(fullPath);
        } else {
          // Check if it's a MIDI file
          const nameLower = filename.toLowerCase();
          if (nameLower.endsWith('.mid') || nameLower.endsWith('.midi')) {
            allFiles.push({
              name: filename,
              path: fullPath,
              size: 0, // Unknown from API
              modified: 0, // Unknown from API
              type: 'file'
            });
          }
        }
      }
    } catch (error) {
      console.error(`Error traversing ${dirPath}:`, error);
      // Continue with other directories
    }
  }

  await traverse(basePath);
  return allFiles;
}

function extractDate(path: string): string {
  // Extract filename from path
  const filename = path.split('/').pop() || '';

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
