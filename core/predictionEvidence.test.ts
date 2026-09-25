import { describe, expect, it } from 'vitest'
import {
  cutPieces,
  evidenceStrength,
  listenStretches,
  parseEvidenceParts,
  partsForReview,
  type EvidencePart
} from './predictionEvidence'
import type { PredictionReview } from './types'

const part = (startTime: number, endTime: number, basis: string, meanRank?: number): EvidencePart =>
  ({ startTime, endTime, basis, ...(meanRank !== undefined ? { meanRank } : {}) })

describe('listenStretches', () => {
  it('flags a filled-in stretch where the song ranks well down, and nothing the model heard outright', () => {
    const parts = [part(0, 60, 'anchor', 0), part(60, 70, 'bridge', 4), part(70, 120, 'anchor', 0)]
    expect(listenStretches(parts)).toEqual([{ startTime: 60, endTime: 70, meanRank: 4 }])
  })

  it('leaves a filled-in stretch alone when the model still ranked the song near the top', () => {
    expect(listenStretches([part(0, 60, 'anchor', 0), part(60, 90, 'bridge', 0.5)])).toEqual([])
  })

  it('joins neighboring weak parts, weighting the rank by duration, before judging their length', () => {
    const parts = [part(0, 30, 'anchor', 0), part(30, 32, 'bridge', 2), part(32, 34, 'tail', 6), part(34, 60, 'anchor', 0)]
    expect(listenStretches(parts)).toEqual([{ startTime: 30, endTime: 34, meanRank: 4 }])
  })

  it('ignores a weak flicker shorter than three seconds, and a merge-gap join', () => {
    const parts = [part(0, 30, 'anchor', 0), part(30, 32, 'bridge', 9), part(32, 35, 'joined'), part(35, 60, 'anchor', 0)]
    expect(listenStretches(parts)).toEqual([])
  })
})

describe('evidenceStrength', () => {
  it('is full for an anchor, falls with rank, and is weakest for a joined gap', () => {
    const anchor = evidenceStrength(part(0, 1, 'anchor', 0))
    const nearTop = evidenceStrength(part(0, 1, 'bridge', 0))
    const farDown = evidenceStrength(part(0, 1, 'bridge', 5))
    const joined = evidenceStrength(part(0, 1, 'joined'))
    expect(anchor).toBe(1)
    expect(nearTop).toBeLessThan(anchor)
    expect(farDown).toBeLessThan(nearTop)
    expect(joined).toBeLessThan(farDown + 0.1)
  })
})

describe('parseEvidenceParts', () => {
  it('reads stored parts and treats anything unreadable as none', () => {
    const stored = JSON.stringify([part(0, 5, 'anchor', 0), { startTime: 'x' }, part(5, 8, 'joined')])
    expect(parseEvidenceParts(stored)).toEqual([part(0, 5, 'anchor', 0), part(5, 8, 'joined')])
    expect(parseEvidenceParts(null)).toEqual([])
    expect(parseEvidenceParts('{not json')).toEqual([])
    expect(parseEvidenceParts('{"a":1}')).toEqual([])
  })
})

describe('partsForReview', () => {
  const stored = JSON.stringify([part(10, 60, 'anchor', 0), part(60, 100, 'bridge', 3)])
  const review = (overrides: Partial<PredictionReview>): PredictionReview => ({
    id: 1, file_id: 1, predicted_song_name: 'A', predicted_start_time: 10, predicted_end_time: 100,
    predicted_confidence: 0.5, status: 'unsure', reviewed_song_name: null, reviewed_start_time: null,
    reviewed_end_time: null, review_notes: null, model_version: null, promoted_annotation_id: null,
    created_at: 0, updated_at: 0, reviewed_at: null, promoted_at: null,
    predicted_parts_json: stored, split_from_review_id: null, ...overrides
  })

  it('gives a pending review its parts, and a reviewed or promoted one none', () => {
    expect(partsForReview(review({}))).toHaveLength(2)
    expect(partsForReview(review({ status: 'confirmed' }))).toEqual([])
    expect(partsForReview(review({ promoted_annotation_id: 9 }))).toEqual([])
  })

  it('fits the parts to the bounds the review resolves to', () => {
    const edited = review({ status: 'unsure', reviewed_start_time: 20, reviewed_end_time: 80 })
    // Reviewed bounds apply only once the status is `edited`; until then the predicted ones do.
    expect(partsForReview(edited)[0].startTime).toBe(10)
  })
})

describe('cutPieces', () => {
  it('keeps both sides of a cut, one side when it reaches an end, and drops slivers', () => {
    expect(cutPieces(10, 100, 40, 50)).toEqual([{ startTime: 10, endTime: 40 }, { startTime: 50, endTime: 100 }])
    expect(cutPieces(10, 100, 90, 120)).toEqual([{ startTime: 10, endTime: 90 }])
    expect(cutPieces(10, 100, 10.5, 99.5)).toEqual([])
  })
})
