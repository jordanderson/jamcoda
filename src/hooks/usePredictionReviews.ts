import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { predictionReviewsApi } from '@/api/localEndpoints';
import type {
  MergePredictionReviewsRequest,
  PredictionReviewStatus,
  RebuildPredictionModelRequest,
  RunPredictionForFileRequest
} from '@/api/localTypes';

export function usePredictionReviews(params: {
  fileId?: number;
  status?: PredictionReviewStatus;
  includePromoted?: boolean;
  limit?: number;
  offset?: number;
}) {
  return useQuery({
    queryKey: ['predictionReviews', params],
    queryFn: () => predictionReviewsApi.list(params),
    staleTime: 30000
  });
}

export function usePredictionReviewQueue(fileId?: number, limit = 50) {
  return useQuery({
    queryKey: ['predictionReviewQueue', fileId, limit],
    queryFn: () => predictionReviewsApi.getQueue({ fileId, limit }),
    staleTime: 15000
  });
}

export function useUpdatePredictionReview() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: {
      id: number;
      data: Partial<{
        status: PredictionReviewStatus;
        reviewedSongName: string | null;
        reviewedStartTime: number | null;
        reviewedEndTime: number | null;
        reviewNotes: string | null;
        modelVersion: string | null;
      }>;
    }) => predictionReviewsApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['predictionReviews'] });
      queryClient.invalidateQueries({ queryKey: ['predictionReviewQueue'] });
    }
  });
}

export function usePromotePredictionReview() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: number) => predictionReviewsApi.promote(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['predictionReviews'] });
      queryClient.invalidateQueries({ queryKey: ['predictionReviewQueue'] });
      queryClient.invalidateQueries({ queryKey: ['filesByDate'] });
      queryClient.invalidateQueries({ queryKey: ['fileDetail'] });
      queryClient.invalidateQueries({ queryKey: ['songPlayHistory'] });
    }
  });
}

/** Promote a review with one stretch cut out; see `promoteWithCut` on the server. */
export function usePromotePredictionReviewWithCut() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, cutStart, cutEnd }: { id: number; cutStart: number; cutEnd: number }) =>
      predictionReviewsApi.promoteWithCut(id, { cutStart, cutEnd }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['predictionReviews'] });
      queryClient.invalidateQueries({ queryKey: ['predictionReviewQueue'] });
      queryClient.invalidateQueries({ queryKey: ['filesByDate'] });
      queryClient.invalidateQueries({ queryKey: ['fileDetail'] });
      queryClient.invalidateQueries({ queryKey: ['songPlayHistory'] });
    }
  });
}

export function usePromoteReviewedPredictionReviews() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: { fileId?: number; limit?: number }) =>
      predictionReviewsApi.promoteReviewed(params),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['predictionReviews'] });
      queryClient.invalidateQueries({ queryKey: ['predictionReviewQueue'] });
      queryClient.invalidateQueries({ queryKey: ['filesByDate'] });
      queryClient.invalidateQueries({ queryKey: ['fileDetail'] });
      queryClient.invalidateQueries({ queryKey: ['songPlayHistory'] });
    }
  });
}

export function useRunPredictionForFile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: RunPredictionForFileRequest) =>
      predictionReviewsApi.runForFile(params),
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: ['predictionReviews'] });
      queryClient.invalidateQueries({ queryKey: ['predictionReviewQueue'] });
      queryClient.invalidateQueries({ queryKey: ['fileDetail', variables.fileId] });
      queryClient.invalidateQueries({ queryKey: ['filesByDate'] });
    }
  });
}

/**
 * A preview run. It writes nothing, so unlike `useRunPredictionForFile` it
 * invalidates no queries — the review queue on screen is still the truth, and
 * the candidate lives only in the caller's state until it is committed.
 */
export function usePreviewPredictionForFile() {
  return useMutation({
    mutationFn: (params: Omit<RunPredictionForFileRequest, 'dryRun'>) =>
      predictionReviewsApi.runForFile({ ...params, dryRun: true })
  });
}

export function useRebuildPredictionModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: RebuildPredictionModelRequest) =>
      predictionReviewsApi.rebuildModel(params),
    onSuccess: () => {
      // A fresh model is newer than every prior annotation edit, so the
      // staleness badge clears.
      queryClient.invalidateQueries({ queryKey: ['rebuildStatus'] });
      queryClient.invalidateQueries({ queryKey: ['libraryModels'] });
    }
  });
}

/** Model files the Prediction Lab can preview with. Fetched only while the lab is open. */
export function useLibraryModels(enabled: boolean) {
  return useQuery({
    queryKey: ['libraryModels'],
    queryFn: () => predictionReviewsApi.listModels(),
    enabled,
    staleTime: 15000
  });
}

export function useRebuildStatus() {
  return useQuery({
    queryKey: ['rebuildStatus'],
    queryFn: () => predictionReviewsApi.getRebuildStatus(),
    staleTime: 15000,
    refetchInterval: 60000
  });
}

export function useMergePredictionReviews() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: MergePredictionReviewsRequest) =>
      predictionReviewsApi.merge(params),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['predictionReviews'] });
      queryClient.invalidateQueries({ queryKey: ['predictionReviewQueue'] });
      queryClient.invalidateQueries({ queryKey: ['fileDetail'] });
      queryClient.invalidateQueries({ queryKey: ['filesByDate'] });
      queryClient.invalidateQueries({ queryKey: ['songPlayHistory'] });
    }
  });
}
