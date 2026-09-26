import type { PredictedSegment, PredictionDecoderOverrides } from '@/api/localTypes'
import type { OverviewSpan } from './FileOverview'

/** Post-decode filters the server merges into `PredictConfig`. */
export interface SegmentParams {
  minSegmentSec?: number
  mergeGapSec?: number
  minWindowConfidence?: number
  smoothingWindows?: number
  minSegmentConfidence?: number
}

/**
 * A previewed prediction run, held in the detail page's state.
 *
 * It lives there rather than inside the Prediction Lab so the overview beside
 * the piano roll can draw the same candidates: the lab is where a run is made,
 * but comparing it against the notes is what the run is for. Nothing here is
 * persisted — candidates are gone when the page is left.
 */
export interface CandidateRun {
  id: number
  /** What was changed, e.g. `link=bridge`. */
  label: string
  /** The request that produced it, so "Apply" can repeat it for real. */
  request: {
    segment: SegmentParams
    decoder: PredictionDecoderOverrides
    /** A model other than the library's, by file name. */
    modelName?: string
    /** Predicted by a model retrained without this file. */
    holdOut?: boolean
  }
  /** What would be written: the model's output minus already-annotated time. */
  segments: PredictedSegment[]
  /** What the model said before that subtraction. */
  rawSegments: PredictedSegment[]
}

/**
 * Predictions never cover already-annotated time, so on a completed file the
 * written shape is nearly empty and says nothing about the model. There is
 * nothing to write there anyway, so show what the model actually produced.
 *
 * Defaulted because an older server, or a candidate captured before a reload,
 * may not carry both lists, and this must never be what takes the page down.
 */
/**
 * Only a run of the library model, trained as saved, can be written to the
 * review queue: that is the model every other prediction in the app comes
 * from. Another model or a held-out refit is for comparing, not for keeping.
 */
export function canApplyCandidate(run: CandidateRun): boolean {
  return !run.request.modelName && !run.request.holdOut
}

export function candidateSegments(run: CandidateRun, isFileComplete: boolean): PredictedSegment[] {
  return (isFileComplete ? run.rawSegments : run.segments) ?? []
}

export function candidateSpans(run: CandidateRun, isFileComplete: boolean): OverviewSpan[] {
  return candidateSegments(run, isFileComplete).map((segment, index) => ({
    key: `candidate-${run.id}-${index}`,
    label: segment.songName,
    start: segment.startTime,
    end: segment.endTime,
    ...(segment.parts && segment.parts.length > 0 ? { parts: segment.parts } : {})
  }))
}

export function candidateCountLabel(run: CandidateRun, isFileComplete: boolean): string {
  const count = candidateSegments(run, isFileComplete).length
  return `${count} segments${isFileComplete ? ', before labeled time is subtracted' : ''}`
}
