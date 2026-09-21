import { existsSync, statSync } from 'node:fs';
import * as AnnotationModel from '@models/Annotation';
import { loadModel } from '../../ml/songSegmentation';

/**
 * Read-only model-staleness signal for the `Rebuild Model` button badge.
 *
 * Pending changes are detected two ways against the saved model file:
 *   - annotations created or edited after the model's `createdAt` (their
 *     `updated_at` is newer).
 *   - song names present in the DB that the model's label set does not
 *     include.
 *
 * It never trains, and it must clear after a rebuild: a fresh model's
 * `createdAt` is newer than every prior annotation edit, and its labels
 * contain every annotated song (when the MIDI files exist). Both signals
 * drop to zero.
 */

export interface RebuildStatus {
  modelExists: boolean;
  modelCreatedAt: string | null;
  modelAnnotationsUsed: number | null;
  pendingAnnotationCount: number;
  missingLabels: string[];
  hasPendingChanges: boolean;
}

/** Labels present in `currentLabels` but absent from the model's `modelLabels`. */
export function findMissingLabels(currentLabels: string[], modelLabels: string[]): string[] {
  return currentLabels.filter((label) => !modelLabels.includes(label));
}

/**
 * The three fields the badge reads, cached against the model file's identity.
 *
 * `loadModel` reads and parses the whole model -- eight megabytes and ~30ms of
 * blocked event loop for the current one -- and every annotation edit asks for
 * this status, so an uncached read stalls every other request behind it. Only the
 * summary is kept: holding the parsed model would pin its heap for the life of
 * the process. A rebuild rewrites the file, which changes mtime and size and
 * so misses the cache, which is what keeps the badge's "clears after a
 * rebuild" contract intact.
 */
interface ModelSummary {
  createdAt: string;
  labels: string[];
  annotationsUsed: number | null;
}

let cachedSummary: {
  path: string;
  mtimeMs: number;
  size: number;
  summary: ModelSummary;
} | null = null;

function readModelSummary(modelPath: string): ModelSummary | null {
  let stats;
  try {
    stats = statSync(modelPath);
  } catch {
    return null;
  }

  if (
    cachedSummary
    && cachedSummary.path === modelPath
    && cachedSummary.mtimeMs === stats.mtimeMs
    && cachedSummary.size === stats.size
  ) {
    return cachedSummary.summary;
  }

  let summary: ModelSummary;
  try {
    const model = loadModel(modelPath);
    summary = {
      createdAt: model.createdAt,
      labels: model.labels,
      annotationsUsed: model.trainingSummary?.annotationsUsed ?? null
    };
  } catch {
    return null;
  }

  cachedSummary = { path: modelPath, mtimeMs: stats.mtimeMs, size: stats.size, summary };
  return summary;
}

/** Drop the cached model summary. Exported for tests. */
export function clearModelSummaryCache(): void {
  cachedSummary = null;
}

function noModelStatus(): RebuildStatus {
  return {
    modelExists: false,
    modelCreatedAt: null,
    modelAnnotationsUsed: null,
    pendingAnnotationCount: 0,
    missingLabels: [],
    hasPendingChanges: false
  };
}

export function getRebuildStatus(modelPath: string): RebuildStatus {
  if (!existsSync(modelPath)) {
    return noModelStatus();
  }

  const model = readModelSummary(modelPath);
  if (!model) {
    return noModelStatus();
  }

  const modelCreatedAtUnix = Math.floor(Date.parse(model.createdAt) / 1000);
  if (!Number.isFinite(modelCreatedAtUnix)) {
    return noModelStatus();
  }

  const pendingAnnotationCount = AnnotationModel.countChangedSince(modelCreatedAtUnix);
  const missingLabels = findMissingLabels(
    AnnotationModel.getUniqueSongNames(),
    model.labels
  );

  return {
    modelExists: true,
    modelCreatedAt: model.createdAt,
    modelAnnotationsUsed: model.annotationsUsed,
    pendingAnnotationCount,
    missingLabels,
    hasPendingChanges: pendingAnnotationCount > 0 || missingLabels.length > 0
  };
}