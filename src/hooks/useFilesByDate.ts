import { useQuery } from '@tanstack/react-query';
import { localFilesApi } from '@/api/localEndpoints';

export function useFilesByDate(startDate?: string, endDate?: string) {
  return useQuery({
    queryKey: ['filesByDate', startDate, endDate],
    queryFn: () => localFilesApi.getByDate(startDate, endDate),
    staleTime: 5 * 60 * 1000  // 5 minutes
  });
}
