import { useQuery } from '@tanstack/react-query';
import { localFilesApi } from '../api/localEndpoints';

export function useLocalFileDownload(fileId: number | null, enabled: boolean = true) {
  return useQuery({
    queryKey: ['localMidiFile', fileId],
    queryFn: async () => {
      if (!fileId) throw new Error('No file ID provided');
      console.log('Downloading local MIDI file:', fileId);
      return localFilesApi.download(fileId);
    },
    enabled: enabled && !!fileId,
    staleTime: Infinity, // Downloaded files never go stale.
    gcTime: 30 * 60 * 1000, // Keep in cache for 30 minutes.
    retry: 1 // Only retry once on failure.
  });
}
