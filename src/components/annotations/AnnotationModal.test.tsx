import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils/renderWithProviders';
import { AnnotationModal } from './AnnotationModal';

describe('AnnotationModal', () => {
  it('renders standard create mode when no split target annotation is provided', () => {
    renderWithProviders(
      <AnnotationModal
        isOpen={true}
        startTime={10}
        endTime={20}
        existingSongNames={['Song A', 'Song B']}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(screen.getByRole('heading', { name: /create label/i })).toBeInTheDocument();
    expect(screen.getByText(/region:/i)).toBeInTheDocument();
    expect(screen.queryByText(/inside existing label/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /split label/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create label/i })).toBeInTheDocument();
  });

  it('renders split option when the selected region is inside an existing annotation', () => {
    const existingAnnotation = {
      id: 42,
      song_name: 'Moonlight Sonata',
      start_time: 0,
      end_time: 60
    };

    renderWithProviders(
      <AnnotationModal
        isOpen={true}
        startTime={15}
        endTime={25}
        existingSongNames={['Moonlight Sonata']}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        splitTargetAnnotation={existingAnnotation}
        onSplitAnnotation={vi.fn()}
      />
    );

    expect(screen.getByText(/inside existing label/i)).toBeInTheDocument();
    expect(screen.getByText('Moonlight Sonata')).toBeInTheDocument();
    expect(screen.getByText(/split into two segments/i)).toBeInTheDocument();

    const splitButtons = screen.getAllByRole('button', { name: /split label/i });
    expect(splitButtons.length).toBeGreaterThanOrEqual(1);
  });

  it('calls onSplitAnnotation when the split button is clicked', async () => {
    const existingAnnotation = {
      id: 42,
      song_name: 'Moonlight Sonata',
      start_time: 0,
      end_time: 60
    };
    const onSplitAnnotation = vi.fn().mockResolvedValue(undefined);

    renderWithProviders(
      <AnnotationModal
        isOpen={true}
        startTime={15}
        endTime={25}
        existingSongNames={['Moonlight Sonata']}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        splitTargetAnnotation={existingAnnotation}
        onSplitAnnotation={onSplitAnnotation}
      />
    );

    const splitButtons = screen.getAllByRole('button', { name: /split label/i });
    fireEvent.click(splitButtons[0]);

    expect(onSplitAnnotation).toHaveBeenCalledTimes(1);
    expect(onSplitAnnotation).toHaveBeenCalledWith(existingAnnotation, 15, 25);
  });

  it('calls onSubmit when submitting song name', () => {
    const onSubmit = vi.fn();
    renderWithProviders(
      <AnnotationModal
        isOpen={true}
        startTime={10}
        endTime={20}
        existingSongNames={['Song A']}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );

    const input = screen.getByPlaceholderText(/type to search or enter new song name/i);
    fireEvent.change(input, { target: { value: 'New Song' } });
    fireEvent.click(screen.getByRole('button', { name: /create label/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('New Song');
  });

  it('calls onCancel when cancel is clicked or escape is pressed', () => {
    const onCancel = vi.fn();
    renderWithProviders(
      <AnnotationModal
        isOpen={true}
        startTime={10}
        endTime={20}
        existingSongNames={['Song A']}
        onSubmit={vi.fn()}
        onCancel={onCancel}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    const input = screen.getByPlaceholderText(/type to search or enter new song name/i);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
