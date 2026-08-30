import { inflate } from 'pako';
import { execSync } from 'child_process';
import got from 'got';
import type { JamcorderFileEntry } from '../types/index.js';

const JAMCORDER_URL = process.env.JAMCORDER_URL || 'http://jamcorder.local';
const REQUEST_TIMEOUT = 30000; // 30 seconds

interface JamcorderListResponse {
  files: string[];
  dir: string;
}

// Create got instance for listing (which doesn't have the Transfer-Encoding issue)
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

export async function listFiles(path: string): Promise<JamcorderListResponse> {
  try {
    const response = await client.post(`${JAMCORDER_URL}/api/files/list/overview`, {
      json: { filepath: path }
    });

    // got returns a Uint8Array, whose toString() would yield comma-separated
    // byte values rather than decoded text. Wrap it so the fallback below can
    // decode the body correctly.
    const buffer = Buffer.from(response.body);

    // Try to decompress
    try {
      const decompressed = inflate(buffer, { to: 'string' });
      return JSON.parse(decompressed);
    } catch (e) {
      // If decompression fails, try parsing as plain JSON
      return JSON.parse(buffer.toString());
    }
  } catch (error: any) {
    throw new Error(`Failed to list files from ${path}: ${error.message || 'Unknown error'}`);
  }
}

export async function downloadFile(filepath: string): Promise<Buffer> {
  try {
    // Use curl as a workaround for Jamcorder firmware bug that sends both
    // Content-Length and Transfer-Encoding headers (violates HTTP/1.1 spec)
    // curl is more lenient and will accept this invalid response
    const postData = JSON.stringify({ filepath });

    const curlCommand = `curl -s -X POST -H "Content-Type: application/json" -d '${postData.replace(/'/g, "'\\''")}' ${JAMCORDER_URL}/api/files/download/simple`;

    const buffer = execSync(curlCommand, {
      encoding: 'buffer',
      maxBuffer: 50 * 1024 * 1024, // 50MB max
      timeout: REQUEST_TIMEOUT
    });

    // Try to decompress
    try {
      const decompressed = inflate(buffer);
      return Buffer.from(decompressed);
    } catch (e) {
      // If decompression fails, return as-is
      return buffer;
    }
  } catch (error: any) {
    console.error(`Download error for ${filepath}:`, error.message);
    throw new Error(`Download failed: ${error.message || 'Unknown error'}`);
  }
}

export async function getFileMetadata(filepath: string): Promise<{ size: number; modified: number } | null> {
  // The jamcorder API doesn't provide detailed metadata in a separate endpoint
  // We rely on the directory listing which only provides filenames
  // Return null for now, will populate from actual file after download
  return null;
}
