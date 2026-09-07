import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deserialize, serialize } from 'node:v8';
import { DECODE_ONLY_CONFIG_KEYS, type AnnotatedMidiFile, type TrainConfig } from './songSegmentation.js';

export function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Content identity, independent of DB timestamps/paths and model build dates. */
export function datasetIdentity(files: AnnotatedMidiFile[]) {
  const manifest = files.map((file) => ({
    fileId: file.fileId,
    filename: file.filename,
    isComplete: file.isComplete,
    annotations: file.annotations,
    midiSha256: digest(readFileSync(file.midiPath))
  }));
  return { sha256: digest(JSON.stringify(manifest)), manifest };
}

/** Unknown future config fields invalidate the cache unless explicitly decoding-only. */
export function scoringConfig(config: TrainConfig): Record<string, unknown> {
  const decodeOnly = new Set<string>(DECODE_ONLY_CONFIG_KEYS);
  return Object.fromEntries(Object.entries(config)
    .filter(([key]) => !decodeOnly.has(key))
    .sort(([a], [b]) => a.localeCompare(b)));
}

/** Conservative invalidation when any feature/training/scoring implementation changes. */
export function scoringSourceIdentity(): string {
  return digest(JSON.stringify([
    './songSegmentation.ts', './prototypeScorer.ts', './evalCache.ts',
    '../core/midi/noteSequence.ts', '../core/midi/tempoMap.ts', '../core/cli/args.ts'
  ].map((relative) => digest(readFileSync(fileURLToPath(new URL(relative, import.meta.url)))))));
}

export interface CachedScores {
  labels: string[];
  scores: number[][];
}

export class EvalScoreCache {
  private directory: string;

  constructor(root: string, identity: unknown) {
    this.directory = path.join(root, digest(JSON.stringify(identity)));
  }

  read(fileId: number, windowCount: number): CachedScores | undefined {
    try {
      const value = deserialize(readFileSync(path.join(this.directory, `${fileId}.bin`))) as CachedScores;
      if (!Array.isArray(value.labels) || value.labels.length === 0
        || !value.labels.every((label) => typeof label === 'string')
        || !Array.isArray(value.scores) || value.scores.length !== windowCount
        || !value.scores.every((row) => Array.isArray(row) && row.length === value.labels.length
          && row.every((score) => typeof score === 'number' && (Number.isFinite(score) || score === -Infinity)))) {
        return undefined;
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EACCES') throw error;
      // Interrupted, stale-format, or missing entries are cheap to regenerate.
      return undefined;
    }
  }

  write(fileId: number, value: CachedScores): void {
    mkdirSync(this.directory, { recursive: true });
    const destination = path.join(this.directory, `${fileId}.bin`);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    // v8 preserves -Infinity (JSON would silently turn it into null).
    writeFileSync(temporary, serialize(value));
    renameSync(temporary, destination);
  }
}
