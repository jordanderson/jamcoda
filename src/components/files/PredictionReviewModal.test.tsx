import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PredictionReviewModal } from './PredictionReviewModal'
import type { PredictionReview } from '@/api/localTypes'

const flaggedParts = JSON.stringify([
  { startTime: 60, endTime: 190, basis: 'anchor', meanRank: 0 },
  { startTime: 190, endTime: 208, basis: 'bridge', meanRank: 4.2 },
  { startTime: 208, endTime: 340, basis: 'anchor', meanRank: 0 }
])

const review = (overrides: Partial<PredictionReview> = {}): PredictionReview => ({
  id: 3, file_id: 1, predicted_song_name: 'Moonlight Sonata', predicted_start_time: 60, predicted_end_time: 340,
  predicted_confidence: 0.6, status: 'unsure', reviewed_song_name: null, reviewed_start_time: null,
  reviewed_end_time: null, review_notes: null, model_version: null, promoted_annotation_id: null,
  created_at: 0, updated_at: 0, reviewed_at: null, promoted_at: null,
  predicted_parts_json: flaggedParts, split_from_review_id: null,
  ...overrides
})

const renderPropsFor = (target: PredictionReview) => ({
  review: target,
  isPending: false,
  onClose: vi.fn(),
  onSeek: vi.fn(),
  onConfirmAndPromote: vi.fn(),
  onEditAndPromote: vi.fn(),
  onMarkInvalid: vi.fn(),
  onConfirmWithout: vi.fn(),
  isPlaying: false,
  onListen: vi.fn(),
  onPause: vi.fn()
})

const renderModal = (overrides: Partial<Parameters<typeof PredictionReviewModal>[0]> = {}) => {
  const props = {
    review: review(),
    isPending: false,
    onClose: vi.fn(),
    onSeek: vi.fn(),
    onConfirmAndPromote: vi.fn(),
    onEditAndPromote: vi.fn(),
    onMarkInvalid: vi.fn(),
    onConfirmWithout: vi.fn(),
    isPlaying: false,
    onListen: vi.fn(),
    onPause: vi.fn(),
    ...overrides
  }
  render(<PredictionReviewModal {...props} />)
  return props
}

describe('PredictionReviewModal, worth a listen', () => {
  it('names each flagged stretch, how far down the song ranked there, and what cutting it keeps', () => {
    renderModal()
    expect(screen.getByRole('heading', { name: /Worth a listen before confirming/ })).toBeInTheDocument()
    expect(screen.getByText('3:10–3:28')).toBeInTheDocument()
    expect(screen.getByText(/ranked 5th here/)).toBeInTheDocument()
    expect(screen.getByText('Confirming without it keeps 1:00–3:10 and 3:28–5:40.')).toBeInTheDocument()
  })

  it('plays the stretch with a lead-in and lead-out, and cuts exactly the stretch', async () => {
    const props = renderModal()
    await userEvent.click(screen.getByRole('button', { name: /Listen/ }))
    expect(props.onListen).toHaveBeenCalledWith({ startTime: 187, endTime: 210 })

    await userEvent.click(screen.getByRole('button', { name: /Confirm without it/ }))
    expect(props.onConfirmWithout).toHaveBeenCalledWith(
      props.review,
      expect.objectContaining({ startTime: 190, endTime: 208 })
    )
  })

  it('asks whether it is the song at all when the whole prediction is weak', () => {
    renderModal({
      review: review({
        predicted_start_time: 498, predicted_end_time: 508,
        predicted_parts_json: JSON.stringify([{ startTime: 498, endTime: 508, basis: 'rescued', meanRank: 6.6 }])
      })
    })
    expect(screen.getByText('This is the whole prediction. If it is not Moonlight Sonata, mark it invalid.'))
      .toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Confirm without it/ })).not.toBeInTheDocument()
  })

  it('offers a pause while something is playing', async () => {
    const props = renderModal({ isPlaying: true })
    await userEvent.click(screen.getByRole('button', { name: /Pause/ }))
    expect(props.onPause).toHaveBeenCalled()
  })

  it('says so when the model heard the song clearly throughout', () => {
    renderModal({
      review: review({
        predicted_parts_json: JSON.stringify([{ startTime: 60, endTime: 340, basis: 'anchor', meanRank: 0 }])
      })
    })
    expect(screen.getByText(/heard Moonlight Sonata clearly across this whole prediction/)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /Worth a listen/ })).not.toBeInTheDocument()
  })

  it('stays silent for a prediction stored without evidence, and for one already reviewed', () => {
    const { unmount } = render(
      <PredictionReviewModal {...renderPropsFor(review({ predicted_parts_json: null }))} />
    )
    expect(screen.queryByText(/Worth a listen|heard .* clearly/)).not.toBeInTheDocument()
    unmount()

    render(<PredictionReviewModal {...renderPropsFor(review({ status: 'edited' }))} />)
    expect(screen.queryByText(/Worth a listen|heard .* clearly/)).not.toBeInTheDocument()
  })
})
