import { useQuery } from '@tanstack/react-query';
import { syncApi } from '../api/localEndpoints';

export function useSyncProgress(syncId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['syncProgress', syncId],
    queryFn: () => syncApi.getProgress(syncId!),
    enabled: enabled && !!syncId,
    refetchInterval: (query) => {
      const data = query.state.data as any;
      // Stop polling when completed or errored
      if (!data || data.status === 'completed' || data.status === 'error') {
        return false;
      }
      return 500; // Poll every 500ms during sync
    }
  });
}
