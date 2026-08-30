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
