import { existsSync } from 'node:fs';
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

  let model;
  try {
    model = loadModel(modelPath);
  } catch {
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
    modelAnnotationsUsed: model.trainingSummary?.annotationsUsed ?? null,
    pendingAnnotationCount,
    missingLabels,
    hasPendingChanges: pendingAnnotationCount > 0 || missingLabels.length > 0
  };
}