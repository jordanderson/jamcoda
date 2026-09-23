import { useQuery } from '@tanstack/react-query';
import { settingsApi } from '../api/localEndpoints';

export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: settingsApi.get,
    staleTime: Infinity
  });
}
