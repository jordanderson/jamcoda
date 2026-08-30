import { useMutation, useQueryClient } from '@tanstack/react-query';
import { syncApi } from '../api/localEndpoints';

export function useStartSync() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: syncApi.start,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['syncStatus'] });
    }
  });
}
