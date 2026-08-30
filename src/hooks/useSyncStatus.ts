import { useQuery } from '@tanstack/react-query';
import { syncApi } from '../api/localEndpoints';

export function useSyncStatus() {
  return useQuery({
    queryKey: ['syncStatus'],
    queryFn: syncApi.getStatus,
    staleTime: 0,
    refetchOnMount: 'always'
  });
}
