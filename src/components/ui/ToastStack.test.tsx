import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { ToastStack } from './ToastStack'
import type { Toast } from '@/hooks/useToasts'

const successToast: Toast = { id: 1, type: 'success', message: 'Prediction marked invalid.' }
const errorToast: Toast = { id: 2, type: 'error', message: 'Failed to mark prediction invalid.' }

describe('ToastStack', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders the live region even while empty, so the first toast is announced', () => {
    render(<ToastStack toasts={[]} onDismiss={vi.fn()} />)

    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.queryByTestId('toast')).not.toBeInTheDocument()
  })

  it('dismisses a success toast on its own rather than leaving it on the page', () => {
    const onDismiss = vi.fn()
    render(<ToastStack toasts={[successToast]} onDismiss={onDismiss} />)

    expect(screen.getByText('Prediction marked invalid.')).toBeInTheDocument()

    act(() => { vi.advanceTimersByTime(5000) })

    expect(onDismiss).toHaveBeenCalledWith(1)
  })

  it('holds an error toast longer than a success, then still dismisses it', () => {
    const onDismiss = vi.fn()
    render(<ToastStack toasts={[errorToast]} onDismiss={onDismiss} />)

    act(() => { vi.advanceTimersByTime(5000) })
    expect(onDismiss).not.toHaveBeenCalled()

    act(() => { vi.advanceTimersByTime(4000) })
    expect(onDismiss).toHaveBeenCalledWith(2)
  })

  it('pauses every timer while the stack is hovered, and resumes on leave', () => {
    const onDismiss = vi.fn()
    render(<ToastStack toasts={[successToast, errorToast]} onDismiss={onDismiss} />)

    fireEvent.mouseEnter(screen.getByRole('status'))
    act(() => { vi.advanceTimersByTime(30000) })
    expect(onDismiss).not.toHaveBeenCalled()

    fireEvent.mouseLeave(screen.getByRole('status'))
    act(() => { vi.advanceTimersByTime(9000) })
    expect(onDismiss).toHaveBeenCalledWith(1)
    expect(onDismiss).toHaveBeenCalledWith(2)
  })

  it('dismisses on the close button without waiting for the timer', () => {
    const onDismiss = vi.fn()
    render(<ToastStack toasts={[successToast]} onDismiss={onDismiss} />)

    fireEvent.click(screen.getByLabelText('Dismiss notification'))

    expect(onDismiss).toHaveBeenCalledWith(1)
  })

  it('renders an optional action and runs it when clicked', () => {
    const onClick = vi.fn()
    render(
      <ToastStack
        toasts={[{ ...successToast, action: { label: 'Open review queue', onClick } }]}
        onDismiss={vi.fn()}
      />
    )

    fireEvent.click(screen.getByText('Open review queue'))

    expect(onClick).toHaveBeenCalled()
  })
})
