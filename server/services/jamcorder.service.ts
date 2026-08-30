import { inflate } from 'pako';
import { execFile } from 'child_process';
import { promisify } from 'util';
import got from 'got';
import type {
  JamcorderAsset,
  JamcorderDetailedFile
} from '../types/index';

const execFileAsync = promisify(execFile);

const JAMCORDER_URL = process.env.JAMCORDER_URL || 'http://jamcorder.local';
const REQUEST_TIMEOUT = 30000; // 30 seconds
// The firmware runs on low-power hardware (e.g. Raspberry Pi 3) and can be
// overwhelmed or crash under load. Keep pages very small, pause generously
// between them, and back off slowly when a request drops.
const LIBRARY_PAGE_SIZE = Number(process.env.JAMCORDER_LIBRARY_PAGE_SIZE || 5);
const LIBRARY_PAGE_DELAY_MS = Number(process.env.JAMCORDER_LIBRARY_PAGE_DELAY_MS || 1000);
const DOWNLOAD_RETRIES = Number(process.env.JAMCORDER_DOWNLOAD_RETRIES || 2);
const DOWNLOAD_RETRY_DELAY_MS = Number(process.env.JAMCORDER_DOWNLOAD_RETRY_DELAY_MS || 1500);

interface JamcorderListResponse {
  files: string[];
  dir: string;
}

interface JamcorderDetailedResponse {
  dir: string;
  files: JamcorderDetailedFile[];
}

interface LibraryListResponse {
  midiPathContinue?: string;
  assets?: JamcorderAsset[];
}

export interface LibraryListOptions {
  /**
   * Stop paginating as soon as we reach an asset with `assetIdx <= this`
   * (assets are returned newest-first). Combined with a high-water mark this
   * keeps steady-state syncs to a single page instead of walking the whole
   * library. Only applied when `jamcorderUuid` matches the device that wrote
   * the water mark, so a new device/SD card still gets a full pass.
   */
  newerThanAssetIdx?: number;
  jamcorderUuid?: string;
}

// got instance for JSON endpoints (listing/library). These don't exhibit the
// download endpoint's invalid-header quirk, so a standards-compliant client is
// safe here.
const client = got.extend({
  timeout: {
    request: REQUEST_TIMEOUT
  },
  headers: {
    'Content-Type': 'application/json'
  },
  responseType: 'buffer',
  retry: {
    limit: 0
  }
});

export async function getCapabilities(): Promise<Record<string, unknown>> {
  try {
    const response = await client.get(`${JAMCORDER_URL}/api/meta/capabilities`);
    return parseJsonBody(response.body) as Record<string, unknown>;
  } catch (error: any) {
    throw new Error(`Failed to read device capabilities: ${error.message || 'Unknown error'}`);
  }
}

export async function listFiles(path: string): Promise<JamcorderListResponse> {
  try {
    const response = await client.post(`${JAMCORDER_URL}/api/files/list/overview`, {
      json: { filepath: path }
    });
    return parseJsonBody(response.body) as JamcorderListResponse;
  } catch (error: any) {
    throw new Error(`Failed to list files from ${path}: ${error.message || 'Unknown error'}`);
  }
}

export async function listFilesDetailed(path: string): Promise<JamcorderDetailedResponse> {
  try {
    const response = await client.post(`${JAMCORDER_URL}/api/files/list/detailed`, {
      json: { filepath: path }
    });
    return parseJsonBody(response.body) as JamcorderDetailedResponse;
  } catch (error: any) {
    throw new Error(`Failed to list files from ${path}: ${error.message || 'Unknown error'}`);
  }
}

/**
 * List all recording assets via the library API, paging with `midiPathContinue`.
 * The library API is the authoritative recordings catalog and returns sizes
 * without a full filesystem traversal. Pages are kept small (with a delay
 * between them) because the firmware is resource-constrained. `getJmxEof` is
 * intentionally left off: parsing EOF summaries for every asset is heavy on
 * low-power devices, and the duration is parsed locally from each downloaded
 * file anyway.
 */
export async function listLibraryAssets(options?: LibraryListOptions): Promise<JamcorderAsset[]> {
  const assets: JamcorderAsset[] = [];
  let continueFrom: string | undefined;
  let reachedWatermark = false;

  for (let page = 0; page < 500; page++) {
    const body: Record<string, unknown> = {
      getJmxEof: false,
      getFilesize: true,
      getAllDevices: true,
      preferredCount: LIBRARY_PAGE_SIZE
    };
    if (continueFrom) {
      body.midiPathContinue = continueFrom;
    }

    let pageAssets: JamcorderAsset[] = [];
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await client.post(`${JAMCORDER_URL}/api/library/list/assets`, {
          json: body
        });
        const parsed = parseJsonBody(response.body) as LibraryListResponse | JamcorderAsset[];

        if (Array.isArray(parsed)) {
          pageAssets = parsed;
        } else if (parsed && Array.isArray(parsed.assets)) {
          pageAssets = parsed.assets;
        } else {
          throw new Error('Unexpected library list response shape');
        }
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        // The device is resource-constrained and occasionally drops a page;
        // back off generously and retry before giving up.
        await sleep(1000 * (attempt + 1) + LIBRARY_PAGE_DELAY_MS);
      }
    }
    if (lastError) {
      throw lastError instanceof Error ? lastError : new Error('Library list failed');
    }

    if (pageAssets.length === 0) {
      break;
    }

    // If the caller supplied a water mark for a specific device, honor it only
    // when the device that owns the newest asset matches. Otherwise ignore it.
    const applyWatermark =
      options?.newerThanAssetIdx != null
      && options?.jamcorderUuid != null
      && page === 0
      && jamcorderUuidFromPath(pageAssets[0].midiPath) === options.jamcorderUuid;

    if (applyWatermark) {
      const cut = pageAssets.findIndex((asset) => (asset.assetIdx ?? 0) <= options.newerThanAssetIdx!);
      if (cut >= 0) {
        pageAssets = pageAssets.slice(0, cut);
        reachedWatermark = true;
      }
    }

    assets.push(...pageAssets);

    if (reachedWatermark || pageAssets.length < LIBRARY_PAGE_SIZE) {
      break;
    }
    const last = pageAssets[pageAssets.length - 1];
    if (!last.midiPath || last.midiPath === continueFrom) {
      break;
    }
    continueFrom = last.midiPath;

    await sleep(LIBRARY_PAGE_DELAY_MS);
  }

  return assets;
}

/** Extract the jamcorder UUID from a `/JAMC/<year>/<uuid>/...` midiPath. */
export function jamcorderUuidFromPath(midiPath: string): string | null {
  const parts = midiPath.split('/').filter(Boolean);
  return parts.length >= 3 ? parts[2] : null;
}

/**
 * Download a whole file. Shells out to curl because the firmware violates
 * HTTP/1.1 by sending both Content-Length and Transfer-Encoding on download
 * responses; curl tolerates this while strict clients (got) reject it.
 */
export async function downloadFile(filepath: string): Promise<Buffer> {
  return curlPost('/api/files/download/simple', { filepath });
}

/**
 * Download a byte range of a file via `/api/files/download/offset`.
 * Negative `offset` is relative to EOF; `length <= 0` means through EOF.
 * Used for incremental re-sync (fetch only bytes appended since the last
 * sync) and for resuming interrupted downloads.
 */
export async function downloadFileRange(filepath: string, offset: number, length = -1): Promise<Buffer> {
  return curlPost('/api/files/download/offset', { filepath, offset, length });
}

/**
 * Download one JMX stone (~45 KiB chunk of a recording). `stoneIdx` is
 * 1-based; negative indices count backward from the newest stone.
 *
 * NOTE: on the currently observed firmware, this endpoint fails for the
 * actively-growing asset ("expected size != actual size") because it validates
 * the file size against the cached stone offsets at open time. It is reliable
 * for completed assets. The incremental sync path therefore uses
 * `downloadFileRange` for the live asset and keeps this for completed-file use.
 */
export async function downloadStone(midiPath: string, stoneIdx: number): Promise<Buffer> {
  return curlPost('/api/midi-stones/download/stone', { midiPath, stoneIdx });
}

function curlPost(path: string, body: Record<string, unknown>): Promise<Buffer> {
  const args = [
    '-s',
    '--max-time', String(REQUEST_TIMEOUT),
    '-X', 'POST',
    '-H', 'Content-Type: application/json',
    '-d', JSON.stringify(body),
    `${JAMCORDER_URL}${path}`
  ];
  return runWithRetry(
    () => execFileAsync('curl', args, {
      encoding: 'buffer',
      maxBuffer: 50 * 1024 * 1024, // 50MB max
      timeout: REQUEST_TIMEOUT
    }).then(({ stdout }) => decompressMaybe(stdout)),
    DOWNLOAD_RETRIES,
    DOWNLOAD_RETRY_DELAY_MS
  ).catch((error: any) => {
    console.error(`Download error for ${JSON.stringify(body)}:`, error.message);
    throw new Error(`Download failed: ${error.message || 'Unknown error'}`);
  });
}

async function runWithRetry<T>(fn: () => Promise<T>, retries: number, delayMs: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep(delayMs * (attempt + 1));
      }
    }
  }
  throw lastError;
}

function parseJsonBody(body: Buffer): unknown {
  const buffer = Buffer.from(body);
  try {
    return JSON.parse(inflate(buffer, { toText: true }));
  } catch {
    return JSON.parse(buffer.toString());
  }
}

function decompressMaybe(buffer: Buffer): Buffer {
  try {
    return Buffer.from(inflate(buffer));
  } catch {
    return buffer;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}