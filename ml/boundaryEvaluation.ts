import type { AnnotationInterval, SongSegment } from './songSegmentation';

export interface BoundaryMatch {
  fileId: number;
  songName: string;
  annotationIndex: number;
  segmentIndex: number;
  iou: number;
  /** Positive means the prediction is late; negative means early. */
  startErrorSec: number;
  endErrorSec: number;
}

/**
 * Mutual best-overlap same-song matches avoid pairing a take with its neighbour
 * or counting a fragment/merged prediction more than once. IoU >= 0.5 limits
 * boundary diagnostics to recognized takes; always report unmatched counts too.
 */
export function matchBoundaries(
  fileId: number,
  annotations: AnnotationInterval[],
  segments: SongSegment[]
): BoundaryMatch[] {
  const bestForAnnotation = new Map<number, { segmentIndex: number; iou: number }>();
  const bestForSegment = new Map<number, { annotationIndex: number; iou: number }>();
  annotations.forEach((annotation, annotationIndex) => {
    segments.forEach((segment, segmentIndex) => {
      if (annotation.songName !== segment.songName) return;
      const overlap = Math.max(0, Math.min(annotation.endTime, segment.endTime)
        - Math.max(annotation.startTime, segment.startTime));
      const union = Math.max(annotation.endTime, segment.endTime)
        - Math.min(annotation.startTime, segment.startTime);
      const iou = union > 0 ? overlap / union : 0;
      if (iou < 0.5) return;
      if (iou > (bestForAnnotation.get(annotationIndex)?.iou ?? -1)) {
        bestForAnnotation.set(annotationIndex, { segmentIndex, iou });
      }
      if (iou > (bestForSegment.get(segmentIndex)?.iou ?? -1)) {
        bestForSegment.set(segmentIndex, { annotationIndex, iou });
      }
    });
  });
  const matches: BoundaryMatch[] = [];
  for (const [annotationIndex, { segmentIndex, iou }] of bestForAnnotation) {
    if (bestForSegment.get(segmentIndex)?.annotationIndex !== annotationIndex) continue;
    const annotation = annotations[annotationIndex];
    const segment = segments[segmentIndex];
    matches.push({
      fileId, songName: annotation.songName, annotationIndex, segmentIndex, iou,
      startErrorSec: segment.startTime - annotation.startTime,
      endErrorSec: segment.endTime - annotation.endTime
    });
  }
  return matches;
}

function errorSummary(errors: number[]) {
  if (errors.length === 0) return null;
  const sorted = [...errors].sort((a, b) => a - b);
  const absolute = errors.map(Math.abs).sort((a, b) => a - b);
  const median = (values: number[]) => (values[Math.floor((values.length - 1) / 2)]
    + values[Math.floor(values.length / 2)]) / 2;
  return {
    meanSignedSec: errors.reduce((sum, value) => sum + value, 0) / errors.length,
    medianSignedSec: median(sorted),
    meanAbsoluteSec: absolute.reduce((sum, value) => sum + value, 0) / errors.length,
    medianAbsoluteSec: median(absolute),
    p90AbsoluteSec: absolute[Math.ceil(absolute.length * 0.9) - 1],
    within2Sec: absolute.filter((value) => value <= 2).length / errors.length,
    lateOver2Sec: errors.filter((value) => value > 2).length / errors.length,
    earlyOver2Sec: errors.filter((value) => value < -2).length / errors.length
  };
}

export function summarizeBoundaries(matches: BoundaryMatch[], annotations: number, predictions: number) {
  return {
    matched: matches.length,
    annotations,
    predictions,
    unmatchedAnnotations: annotations - matches.length,
    unmatchedPredictions: predictions - matches.length,
    start: errorSummary(matches.map((match) => match.startErrorSec)),
    end: errorSummary(matches.map((match) => match.endErrorSec))
  };
}
