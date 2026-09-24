import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, test, vi } from 'vitest';

// Synced recordings are written into the library beside this database.
const libraryDir = mkdtempSync(path.join(tmpdir(), 'jamcoda-sync-cancel-'));
process.env.JAMCODA_DB_PATH = path.join(libraryDir, 'jamcoda.db');
process.env.JAMCODA_SYNC_DOWNLOAD_PACE_MS = '0';

const jamcorder = vi.hoisted(() => ({
  listFilesDetailed: vi.fn(),
  downloadFile: vi.fn(),
  downloadFileRange: vi.fn(),
  listLibraryAssets: vi.fn(),
  jamcorderUuidFromPath: vi.fn(() => 'uuid')
}));
const files = vi.hoisted(() => ({
  findAll: vi.fn(() => []),
  findById: vi.fn(),
  create: vi.fn(),
  updateSyncedFile: vi.fn(),
  getSyncMetadata: vi.fn(() => ({})),
  updateSyncHighWater: vi.fn(),
  updateSyncMetadata: vi.fn()
}));
vi.mock('./jamcorder.service', () => jamcorder);
vi.mock('../models/File', () => files);

const DEVICE_FILES = ['Jmx-A00001-a.mid', 'Jmx-A00002-b.mid', 'Jmx-A00003-c.mid'];

/** A format 0 file with one empty track: valid, with no JMX trailer. */
const MIDI = Buffer.from([
  0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x03, 0xe8,
  0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 4, 0x00, 0xff, 0x2f, 0x00
]);

const listing = (entries: Array<{ filename: string; isDirectory?: boolean }>) => ({
  dir: '/JAMC/',
  files: entries.map(({ filename, isDirectory = false }) => ({ filename, isDirectory, sizeBytes: 5000, modifiedLocalTime: 0 }))
});

beforeEach(() => {
  vi.clearAllMocks();
  jamcorder.listFilesDetailed.mockResolvedValue(listing(DEVICE_FILES.map((filename) => ({ filename }))));
  jamcorder.downloadFile.mockResolvedValue(MIDI);
  let nextId = 1;
  files.create.mockImplementation(() => nextId++);
});

afterAll(() => {
  rmSync(libraryDir, { recursive: true, force: true });
});

async function waitForEnd(getStatus: () => string | undefined): Promise<void> {
  for (let i = 0; i < 200 && getStatus() === 'in_progress'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('cancel stops after the file in progress and keeps the high-water mark', async () => {
  const sync = await import('./sync.service');
  let syncId = '';
  jamcorder.downloadFile.mockImplementation(async () => {
    assert.equal(sync.cancelSync(syncId), true);
    return MIDI;
  });

  syncId = await sync.startSync();
  await waitForEnd(() => sync.getSyncProgress(syncId)?.status);

  const progress = sync.getSyncProgress(syncId)!;
  assert.equal(progress.status, 'canceled');
  assert.equal(progress.filesFound, 3);
  assert.equal(progress.filesDownloaded, 1);
  assert.equal(progress.filesProcessed, 1);
  assert.equal(jamcorder.downloadFile.mock.calls.length, 1);
  assert.equal(files.updateSyncHighWater.mock.calls.length, 0);
  assert.equal(sync.cancelSync(syncId), false);
  assert.equal(sync.isSyncRunning(), false);
});

test('cancel during discovery stops before the next directory is listed', async () => {
  const sync = await import('./sync.service');
  let syncId = '';
  jamcorder.listFilesDetailed.mockImplementation(async () => {
    // Let startSync return the id before canceling with it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    sync.cancelSync(syncId);
    return listing([{ filename: '2025', isDirectory: true }]);
  });

  syncId = await sync.startSync();
  await waitForEnd(() => sync.getSyncProgress(syncId)?.status);

  const progress = sync.getSyncProgress(syncId)!;
  assert.equal(progress.status, 'canceled');
  assert.deepEqual(progress.errors, []);
  assert.equal(jamcorder.listFilesDetailed.mock.calls.length, 1);
  assert.equal(jamcorder.listLibraryAssets.mock.calls.length, 0);
  assert.equal(jamcorder.downloadFile.mock.calls.length, 0);
});

test('a cancel that arrives with the last file completes the sync', async () => {
  const sync = await import('./sync.service');
  let syncId = '';
  jamcorder.downloadFile.mockImplementation(async () => {
    if (jamcorder.downloadFile.mock.calls.length === DEVICE_FILES.length) sync.cancelSync(syncId);
    return MIDI;
  });

  syncId = await sync.startSync();
  await waitForEnd(() => sync.getSyncProgress(syncId)?.status);

  const progress = sync.getSyncProgress(syncId)!;
  assert.equal(progress.status, 'completed');
  assert.equal(progress.filesDownloaded, 3);
  assert.equal(files.updateSyncHighWater.mock.calls.length, 1);
});

test('an uncanceled sync writes every file into the library and records the high-water mark', async () => {
  const sync = await import('./sync.service');

  const syncId = await sync.startSync();
  await waitForEnd(() => sync.getSyncProgress(syncId)?.status);

  const progress = sync.getSyncProgress(syncId)!;
  assert.equal(progress.status, 'completed');
  assert.equal(progress.filesProcessed, 3);
  assert.equal(typeof progress.downloadStartedAt, 'number');
  assert.deepEqual(files.updateSyncHighWater.mock.calls[0], [3, 'uuid']);
  const stored = files.create.mock.calls.map(([data]) => (data as { localPath: string }).localPath);
  assert.equal(stored.length, 3);
  for (const localPath of stored) {
    assert.match(localPath, /^midi\//);
    assert.ok(existsSync(path.join(libraryDir, localPath)));
  }
});
