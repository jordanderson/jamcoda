import { clamp } from '@core/math'

/**
 * Scroll math for "follow playback" on the piano roll.
 *
 * One rule: ease the viewport so the playhead sits at `FOLLOW_ANCHOR` of the
 * visible width, clamped to the scrollable range. Every playback state falls
 * out of that target -- stopping drives the playhead to 0 so the target clamps
 * to 0; starting from 0 holds the view still until the playhead reaches the
 * anchor; a seek just moves the target. No timers, no per-state branches.
 */

/** Where the playhead sits in the viewport while following: 35% from the left. */
export const FOLLOW_ANCHOR = 0.35

/**
 * Fraction of the remaining distance covered per frame: a full-viewport
 * catch-up settles in about a third of a second, and steady playback tracks
 * within a few pixels.
 */
export const FOLLOW_EASE = 0.18

/** Below this the viewport is treated as having reached the target. */
export const FOLLOW_SETTLE_EPSILON_PX = 0.5

export interface FollowViewport {
  /** Visible width of the scroll container. */
  clientWidth: number
  /** Full width of the scrollable content. */
  scrollWidth: number
}

/** Largest scroll offset the container can actually reach. */
export function maxScrollLeft(viewport: FollowViewport): number {
  return Math.max(0, viewport.scrollWidth - viewport.clientWidth)
}

/**
 * The scroll offset that puts `playheadX` on the anchor line, or `null` when
 * the content fits in the viewport and there is nothing to follow. That is
 * distinct from a target of 0, where the viewport may still need to ease back.
 */
export function followScrollTarget(
  playheadX: number,
  viewport: FollowViewport
): number | null {
  const limit = maxScrollLeft(viewport)
  if (limit <= 0) return null
  return clamp(playheadX - viewport.clientWidth * FOLLOW_ANCHOR, 0, limit)
}

/**
 * One frame of easing toward `target`. Snaps once the step lands within
 * `FOLLOW_SETTLE_EPSILON_PX` so the loop can park instead of approaching
 * asymptotically forever.
 */
export function easeScrollLeft(current: number, target: number): number {
  const distance = target - current
  if (Math.abs(distance) < FOLLOW_SETTLE_EPSILON_PX) return target
  const next = current + distance * FOLLOW_EASE
  return Math.abs(target - next) < FOLLOW_SETTLE_EPSILON_PX ? target : next
}

/** True once the viewport is close enough to `target` to stop animating. */
export function isFollowSettled(current: number, target: number): boolean {
  return Math.abs(target - current) < FOLLOW_SETTLE_EPSILON_PX
}
