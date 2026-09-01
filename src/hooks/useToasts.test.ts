import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useToasts } from './useToasts'

describe('useToasts', () => {
  it('queues toasts and dismisses them individually by id', () => {
    const { result } = renderHook(() => useToasts())

    act(() => {
      result.current.showToast({ type: 'success', message: 'Prediction marked invalid.' })
      result.current.showToast({ type: 'error', message: 'Failed to run predictions.' })
    })
    expect(result.current.toasts.map((toast) => toast.message)).toEqual([
      'Prediction marked invalid.',
      'Failed to run predictions.'
    ])

    act(() => {
      result.current.dismissToast(result.current.toasts[0].id)
    })
    expect(result.current.toasts.map((toast) => toast.message)).toEqual([
      'Failed to run predictions.'
    ])
  })

  it('keeps only the newest three so a burst of actions cannot fill the screen', () => {
    const { result } = renderHook(() => useToasts())

    act(() => {
      for (const message of ['first', 'second', 'third', 'fourth']) {
        result.current.showToast({ type: 'success', message })
      }
    })

    expect(result.current.toasts.map((toast) => toast.message)).toEqual([
      'second',
      'third',
      'fourth'
    ])
  })

  it('gives every toast a distinct id, including repeats of the same message', () => {
    const { result } = renderHook(() => useToasts())

    act(() => {
      result.current.showToast({ type: 'success', message: 'Ignored section deleted.' })
      result.current.showToast({ type: 'success', message: 'Ignored section deleted.' })
    })

    const [first, second] = result.current.toasts
    expect(first.id).not.toBe(second.id)
  })

  it('clears the queue when the view moves to another file', () => {
    const { result } = renderHook(() => useToasts())

    act(() => {
      result.current.showToast({ type: 'success', message: 'File marked complete.' })
      result.current.clearToasts()
    })

    expect(result.current.toasts).toEqual([])
  })
})
