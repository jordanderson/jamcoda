import path from 'node:path';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { libraryDir, libraryModelPath } from '@config/library';
import { errorMessage } from '@core/errors';
import { loadModel } from '../../ml/songSegmentation';
import { PredictionImportError } from './predictionImport';

/**
 * The model files in the library's `ml/` folder, for choosing which model a
 * Prediction Lab preview runs.
 *
 * A model is named by its file name, never by a path: `resolveLibraryModel`
 * accepts only a file directly inside that folder, so a request cannot point
 * the server at an arbitrary file on disk.
 */

export interface LibraryModelSummary {
  /** File name inside the library's `ml/` folder. */
  name: string;
  /** True for `ml/model.json`, the model the app predicts and rebuilds with. */
  isLibraryModel: boolean;
  modelVersion: string | null;
  createdAt: string | null;
  featureCount: number | null;
  chordIoiFeatures: boolean;
  labelCount: number | null;
  /** Why the model cannot be loaded by this build, or null when it can. */
  error: string | null;
}

/**
 * Parsed summaries keyed by path and checked against mtime and size. Parsing
 * a model reads the whole file (tens of megabytes), and eval reports share the
 * folder, so each file is read once per change rather than once per listing.
 * `null` marks a JSON file that is not a model.
 */
const summaryCache = new Map<string, { mtimeMs: number; size: number; summary: LibraryModelSummary | null }>();

function libraryModelDir(): string {
  return path.dirname(libraryModelPath());
}

function summarize(filePath: string, name: string): LibraryModelSummary | null {
  let parsed: { modelType?: unknown };
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
  if (parsed?.modelType !== 'knn-song-segmenter') return null;

  const isLibraryModel = path.resolve(filePath) === path.resolve(libraryModelPath());
  try {
    const model = loadModel(filePath);
    return {
      name,
      isLibraryModel,
      modelVersion: model.modelVersion ?? null,
      createdAt: model.createdAt ?? null,
      featureCount: model.featureNames.length,
      chordIoiFeatures: Boolean(model.config.chordIoiFeatures),
      labelCount: model.labels.length,
      error: null
    };
  } catch (error) {
    return {
      name,
      isLibraryModel,
      modelVersion: null,
      createdAt: null,
      featureCount: null,
      chordIoiFeatures: false,
      labelCount: null,
      error: errorMessage(error, 'Model could not be loaded')
    };
  }
}

/** Every model in the library's `ml/` folder, the library model first, then newest first. */
export function listLibraryModels(): LibraryModelSummary[] {
  const dir = libraryModelDir();
  if (!existsSync(dir)) return [];

  const summaries: LibraryModelSummary[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(dir, entry.name);
    const stats = statSync(filePath);
    const cached = summaryCache.get(filePath);
    let summary: LibraryModelSummary | null;
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      summary = cached.summary;
    } else {
      summary = summarize(filePath, entry.name);
      summaryCache.set(filePath, { mtimeMs: stats.mtimeMs, size: stats.size, summary });
    }
    if (summary) summaries.push(summary);
  }

  return summaries.sort((a, b) => {
    if (a.isLibraryModel !== b.isLibraryModel) return a.isLibraryModel ? -1 : 1;
    return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
  });
}

/** The path of a model named by its file name in the library's `ml/` folder. */
export function resolveLibraryModel(name: string): string {
  if (name !== path.basename(name) || !name.endsWith('.json') || name.startsWith('.')) {
    throw new PredictionImportError(`Not a model file name: ${name}`, 'invalid');
  }
  const modelPath = path.join(libraryModelDir(), name);
  if (!existsSync(modelPath)) {
    throw new PredictionImportError(`No model named ${name} in ${path.relative(libraryDir(), libraryModelDir())}/`, 'not_found');
  }
  return modelPath;
}
