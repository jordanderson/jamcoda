import { useMutation, useQueryClient } from '@tanstack/react-query';
import { syncApi } from '../api/localEndpoints';

export function useStartSync() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (full?: boolean) => syncApi.start(full ?? false),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['syncStatus'] });
    }
  });
}
