import { describe, expect, it } from 'vitest'
import {
  easeScrollLeft,
  FOLLOW_ANCHOR,
  FOLLOW_SETTLE_EPSILON_PX,
  followScrollTarget,
  isFollowSettled,
  maxScrollLeft
} from './pianoRollFollow'

/** 1000px of viewport over 10000px of roll: 9000px of travel. */
const VIEWPORT = { clientWidth: 1000, scrollWidth: 10000 }
const ANCHOR_PX = VIEWPORT.clientWidth * FOLLOW_ANCHOR

/** Run the ease to convergence, and report how many frames it took. */
function settle(from: number, target: number): { value: number; frames: number } {
  let value = from
  let frames = 0
  while (!isFollowSettled(value, target) && frames < 1000) {
    value = easeScrollLeft(value, target)
    frames++
  }
  return { value, frames }
}

describe('maxScrollLeft', () => {
  it('is the content overhang', () => {
    expect(maxScrollLeft(VIEWPORT)).toBe(9000)
  })

  it('is zero when the roll fits in the viewport', () => {
    expect(maxScrollLeft({ clientWidth: 1000, scrollWidth: 400 })).toBe(0)
  })
})

describe('followScrollTarget', () => {
  it('puts the playhead on the anchor line', () => {
    expect(followScrollTarget(5000, VIEWPORT)).toBe(5000 - ANCHOR_PX)
  })

  it('holds at the left edge until the playhead reaches the anchor', () => {
    // What keeps starting from a stop from jumping. The target stays clamped
    // at 0 while the playhead crosses the first 35% of the viewport.
    expect(followScrollTarget(0, VIEWPORT)).toBe(0)
    expect(followScrollTarget(ANCHOR_PX - 1, VIEWPORT)).toBe(0)
    expect(followScrollTarget(ANCHOR_PX + 100, VIEWPORT)).toBe(100)
  })

  it('holds at the right edge near the end of the roll', () => {
    expect(followScrollTarget(9_999, VIEWPORT)).toBe(9000)
  })

  it('reports "nothing to do" when the roll fits in the viewport', () => {
    expect(followScrollTarget(200, { clientWidth: 1000, scrollWidth: 400 })).toBeNull()
  })

  it('stopping drives the target back to the start', () => {
    expect(followScrollTarget(0, VIEWPORT)).toBe(0)
  })
})

describe('easeScrollLeft', () => {
  it('moves toward the target without overshooting', () => {
    const next = easeScrollLeft(0, 1000)
    expect(next).toBeGreaterThan(0)
    expect(next).toBeLessThan(1000)
  })

  it('converges exactly, so the animation terminates', () => {
    const { value, frames } = settle(0, 4650)
    expect(value).toBe(4650)
    expect(frames).toBeLessThan(100)
  })

  it('eases backwards as readily as forwards', () => {
    expect(settle(9000, 0).value).toBe(0)
  })

  it('snaps the final sub-pixel step instead of creeping', () => {
    const almost = 100 - (FOLLOW_SETTLE_EPSILON_PX / 2)
    expect(easeScrollLeft(almost, 100)).toBe(100)
  })

  it('keeps pace with playback without visible lag', () => {
    // 50 px/s at 60fps is under a pixel of new distance per frame, so a
    // settled follower stays within a couple of pixels.
    const perFrame = 50 / 60
    let scroll = 5000 - ANCHOR_PX
    let playheadX = 5000

    for (let frame = 0; frame < 300; frame++) {
      playheadX += perFrame
      scroll = easeScrollLeft(scroll, followScrollTarget(playheadX, VIEWPORT) as number)
    }

    expect(playheadX - scroll).toBeGreaterThan(ANCHOR_PX - 10)
    expect(playheadX - scroll).toBeLessThan(ANCHOR_PX + 10)
  })
})

describe('isFollowSettled', () => {
  it('tolerates sub-pixel differences', () => {
    expect(isFollowSettled(100, 100.2)).toBe(true)
    expect(isFollowSettled(100, 120)).toBe(false)
  })
})
