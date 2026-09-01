import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { annotationsApi, ignoredSectionsApi } from '@/api/localEndpoints';

export function useCreateAnnotation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: annotationsApi.create,
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['fileDetail', variables.fileId] });
      queryClient.invalidateQueries({ queryKey: ['filesByDate'] });
      queryClient.invalidateQueries({ queryKey: ['songPlayHistory'] });
      // A brand-new song name must show up in the autocomplete for the next
      // segment without leaving the detail view.
      queryClient.invalidateQueries({ queryKey: ['uniqueSongNames'] });
      queryClient.invalidateQueries({ queryKey: ['rebuildStatus'] });
    }
  });
}

export function useUpdateAnnotation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: any }) =>
      annotationsApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fileDetail'] });
      queryClient.invalidateQueries({ queryKey: ['filesByDate'] });
      queryClient.invalidateQueries({ queryKey: ['songPlayHistory'] });
      queryClient.invalidateQueries({ queryKey: ['uniqueSongNames'] });
      queryClient.invalidateQueries({ queryKey: ['rebuildStatus'] });
      // Editing an annotation can merge it with an overlapping same-song one.
      // Merging or deleting re-points or clears the promotion on any prediction
      // review promoted into it, so the review lists are stale too.
      queryClient.invalidateQueries({ queryKey: ['predictionReviews'] });
      queryClient.invalidateQueries({ queryKey: ['predictionReviewQueue'] });
    }
  });
}

export function useDeleteAnnotation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: annotationsApi.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fileDetail'] });
      queryClient.invalidateQueries({ queryKey: ['filesByDate'] });
      queryClient.invalidateQueries({ queryKey: ['songPlayHistory'] });
      queryClient.invalidateQueries({ queryKey: ['uniqueSongNames'] });
      queryClient.invalidateQueries({ queryKey: ['rebuildStatus'] });
      // Deleting a promoted annotation un-promotes its review, which puts the
      // review back on the roll and in the queue.
      queryClient.invalidateQueries({ queryKey: ['predictionReviews'] });
      queryClient.invalidateQueries({ queryKey: ['predictionReviewQueue'] });
    }
  });
}

export function useUniqueSongNames() {
  return useQuery({
    queryKey: ['uniqueSongNames'],
    queryFn: annotationsApi.getUniqueSongNames,
    staleTime: 30000, // Cache for 30 seconds
  });
}

/**
 * Model-ranked song suggestions for a time range, used by the create
 * annotation modal. Disabled when there is no region to suggest for.
 */
export function useSongSuggestions(
  fileId: number | null,
  startTime: number | null,
  endTime: number | null
) {
  return useQuery({
    queryKey: ['songSuggestions', fileId, startTime, endTime],
    queryFn: () => annotationsApi.suggestSongs({ fileId: fileId!, startTime: startTime!, endTime: endTime! }),
    enabled: (
      fileId !== null
      && startTime !== null
      && endTime !== null
      && endTime > startTime
    ),
    staleTime: 60 * 1000
  });
}

export function useSongPlayHistory() {
  return useQuery({
    queryKey: ['songPlayHistory'],
    queryFn: annotationsApi.getSongPlayHistory,
    staleTime: 30000
  });
}

export function useRenameSongName() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ oldSongName, newSongName }: { oldSongName: string; newSongName: string }) =>
      annotationsApi.renameSongName({ oldSongName, newSongName }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fileDetail'] });
      queryClient.invalidateQueries({ queryKey: ['filesByDate'] });
      queryClient.invalidateQueries({ queryKey: ['songPlayHistory'] });
      queryClient.invalidateQueries({ queryKey: ['uniqueSongNames'] });
      queryClient.invalidateQueries({ queryKey: ['predictionReviews'] });
      queryClient.invalidateQueries({ queryKey: ['predictionReviewQueue'] });
    }
  });
}

export function useCreateIgnoredSection() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ignoredSectionsApi.create,
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['fileDetail', variables.fileId] });
      queryClient.invalidateQueries({ queryKey: ['filesByDate'] });
      queryClient.invalidateQueries({ queryKey: ['predictionReviews'] });
      queryClient.invalidateQueries({ queryKey: ['predictionReviewQueue'] });
    }
  });
}

export function useDeleteIgnoredSection() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ignoredSectionsApi.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fileDetail'] });
      queryClient.invalidateQueries({ queryKey: ['filesByDate'] });
    }
  });
}
