import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface JamcodaConfig {
  jamcorderUrl: string;
}

const DEFAULT_CONFIG: JamcodaConfig = {
  jamcorderUrl: 'http://jamcorder.local'
};

const CONFIG_FILENAME = 'jamcoda-config.json';

/**
 * The device's base URL in the form the server concatenates paths onto
 * (`${url}/api/...`): http or https, no path, no trailing slash. A bare host
 * such as `jamcorder.local` or `192.168.1.20` gets `http://`. Returns null for
 * anything else.
 */
export function normalizeJamcorderUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/') return null;
  return url.origin;
}

export function readConfig(userDataDir: string): JamcodaConfig {
  const configPath = path.join(userDataDir, CONFIG_FILENAME);
  if (!existsSync(configPath)) {
    return DEFAULT_CONFIG;
  }

  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    const jamcorderUrl = typeof raw.jamcorderUrl === 'string' ? normalizeJamcorderUrl(raw.jamcorderUrl) : null;
    return { jamcorderUrl: jamcorderUrl ?? DEFAULT_CONFIG.jamcorderUrl };
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** Written to a temporary file and renamed over, so a crash never leaves half a file. */
export function writeConfig(userDataDir: string, config: JamcodaConfig): void {
  mkdirSync(userDataDir, { recursive: true });
  const configPath = path.join(userDataDir, CONFIG_FILENAME);
  const tempPath = `${configPath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(config, null, 2));
  renameSync(tempPath, configPath);
}
