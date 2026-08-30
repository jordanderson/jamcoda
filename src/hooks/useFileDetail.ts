import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { localFilesApi } from '../api/localEndpoints';

export function useFileDetail(fileId: number | null) {
  return useQuery({
    queryKey: ['fileDetail', fileId],
    queryFn: () => localFilesApi.getDetail(fileId!),
    enabled: !!fileId,
    staleTime: 5 * 60 * 1000
  });
}

export function useSetFileCompletion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ fileId, isComplete }: { fileId: number; isComplete: boolean }) =>
      localFilesApi.setCompletion(fileId, { isComplete }),
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: ['fileDetail', variables.fileId] });
      queryClient.invalidateQueries({ queryKey: ['filesByDate'] });
      queryClient.invalidateQueries({ queryKey: ['predictionReviews'] });
      queryClient.invalidateQueries({ queryKey: ['predictionReviewQueue'] });
    }
  });
}
