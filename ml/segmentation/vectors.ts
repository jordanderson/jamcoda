/** Feature-vector maths shared by training and decoding. */

export function evenlySample<T>(items: T[], targetCount: number): T[] {
  if (targetCount >= items.length) return items;
  if (targetCount <= 0) return [];

  const stride = items.length / targetCount;
  const sampled: T[] = [];
  for (let i = 0; i < targetCount; i++) {
    const idx = Math.floor(i * stride);
    sampled.push(items[idx]);
  }
  return sampled;
}

/**
 * Compute per-feature normalization constants. The vectors are `number[][]`
 * of raw features; `mode` decides what `means`/`stds` hold:
 *   'zscore'  means = mean,    stds = population std
 *   'minmax'  means = min,     stds = max - min
 *   'none'    means = 0,       stds = 1
 * In every mode `normalizeVector` computes `(x - means) / stds`, so a single
 * code path works for all three.
 */
export function standardize(
  vectors: number[][],
  mode: 'zscore' | 'minmax' | 'none' = 'zscore'
): { means: number[]; stds: number[] } {
  const featureCount = vectors[0]?.length || 0;
  const means = new Array(featureCount).fill(0);
  const stds = new Array(featureCount).fill(1);

  if (mode === 'none') {
    return { means, stds };
  }

  if (mode === 'minmax') {
    const mins = new Array(featureCount).fill(Infinity);
    const maxs = new Array(featureCount).fill(-Infinity);
    for (const vector of vectors) {
      for (let i = 0; i < featureCount; i++) {
        if (vector[i] < mins[i]) mins[i] = vector[i];
        if (vector[i] > maxs[i]) maxs[i] = vector[i];
      }
    }
    for (let i = 0; i < featureCount; i++) {
      const range = maxs[i] - mins[i];
      means[i] = mins[i];
      stds[i] = Number.isFinite(range) && range > 1e-9 ? range : 1;
    }
    return { means, stds };
  }

  for (const vector of vectors) {
    for (let i = 0; i < featureCount; i++) {
      means[i] += vector[i];
    }
  }
  for (let i = 0; i < featureCount; i++) {
    means[i] /= Math.max(1, vectors.length);
  }

  for (const vector of vectors) {
    for (let i = 0; i < featureCount; i++) {
      const diff = vector[i] - means[i];
      stds[i] += diff * diff;
    }
  }
  for (let i = 0; i < featureCount; i++) {
    stds[i] = Math.sqrt(stds[i] / Math.max(1, vectors.length));
    if (!Number.isFinite(stds[i]) || stds[i] < 1e-6) {
      stds[i] = 1;
    }
  }

  return { means, stds };
}

export function normalizeVector(vector: number[], means: number[], stds: number[]): number[] {
  return vector.map((value, idx) => (value - means[idx]) / stds[idx]);
}

export function squaredDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return sum;
}

/**
 * Allocate a prototype count per label. Budgets scale with sqrt(support),
 * then normalize to `prototypeBudget`. The `__none__` class has a hard cap
 * because its window set is large and varied.
 *
 * Counts are unequal on purpose. A song with 4000 annotated windows covers
 * more material than a song with 50. Equal budgets discard that coverage:
 * segment F1 fell from 48.5% to 37.4%.
 *
 * Unequal counts also cause a bias. A nearest-prototype distance decreases
 * as a label gains prototypes, so a well-annotated song beats its rivals in
 * comparisons it should lose. The bias is real and unfixed. Read the v2.3
 * entry in ml/CHANGELOG.md before you try to correct it. Three corrections
 * failed.
 */
