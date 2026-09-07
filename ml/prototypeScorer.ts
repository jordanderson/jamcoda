/** Prepare contiguous, label-grouped doubles once per scoring batch. */
export function createNearestPrototypeScorer(
  prototypes: Array<{ features: number[]; labelIndex: number }>,
  labelCount: number
): (vector: number[]) => number[] {
  const dimensions = prototypes[0].features.length;
  const counts = new Int32Array(labelCount);
  for (const prototype of prototypes) counts[prototype.labelIndex]++;
  const offsets = new Int32Array(labelCount + 1);
  for (let label = 0; label < labelCount; label++) {
    offsets[label + 1] = offsets[label] + counts[label] * dimensions;
  }
  const values = new Float64Array(offsets[labelCount]);
  const cursors = offsets.slice();
  for (const prototype of prototypes) {
    values.set(prototype.features, cursors[prototype.labelIndex]);
    cursors[prototype.labelIndex] += dimensions;
  }

  return (vector) => {
    const scores = new Array<number>(labelCount);
    for (let label = 0; label < labelCount; label++) {
      let best = Infinity;
      for (let offset = offsets[label]; offset < offsets[label + 1]; offset += dimensions) {
        let distance = 0;
        for (let feature = 0; feature < dimensions; feature++) {
          const diff = vector[feature] - values[offset + feature];
          distance += diff * diff;
        }
        if (distance < best) best = distance;
      }
      scores[label] = -Math.sqrt(best);
    }
    return scores;
  };
}
