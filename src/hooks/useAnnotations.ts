import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { annotationsApi } from '@/api/localEndpoints';
import type {
  FileDetailAnnotation,
  FileDetailResponse,
  UpdateAnnotationRequest
} from '@/api/localTypes';

export function useCreateAnnotation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: annotationsApi.create,
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['fileDetail', variables.fileId] });
      queryClient.invalidateQueries({ queryKey: ['filesByDate'] });
      queryClient.invalidateQueries({ queryKey: ['songPlayHistory'] });
      // A brand-new song name must show up in the autocomplete for the next
      // segment without leaving the detail view.
      queryClient.invalidateQueries({ queryKey: ['uniqueSongNames'] });
      queryClient.invalidateQueries({ queryKey: ['rebuildStatus'] });
    }
  });
}

/**
 * Apply `patch` to annotation `id` wherever it sits in a cached file detail.
 *
 * Returns the entries it touched so a failed mutation can put them back.
 */
function patchCachedAnnotation(
  queryClient: QueryClient,
  id: number,
  patch: (annotation: FileDetailAnnotation) => FileDetailAnnotation
): Array<[QueryKey, FileDetailResponse | undefined]> {
  const touched: Array<[QueryKey, FileDetailResponse | undefined]> = [];

  for (const [key, detail] of queryClient.getQueriesData<FileDetailResponse>({
    queryKey: ['fileDetail']
  })) {
    if (!detail?.annotations.some((annotation) => annotation.id === id)) continue;

    touched.push([key, detail]);
    queryClient.setQueryData<FileDetailResponse>(key, {
      ...detail,
      annotations: detail.annotations.map(
        (annotation) => (annotation.id === id ? patch(annotation) : annotation)
      )
    });
  }

  return touched;
}

export function useUpdateAnnotation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: UpdateAnnotationRequest }) =>
      annotationsApi.update(id, data),

    // Paint the edit before the round trip. Drag-resize commits on pointer-up,
    // and without this the chip snapped back to its stored position and sat
    // there until the refetch landed.
    onMutate: async ({ id, data }) => {
      await queryClient.cancelQueries({ queryKey: ['fileDetail'] });

      const previous = patchCachedAnnotation(queryClient, id, (annotation) => ({
        ...annotation,
        song_name: data.songName ?? annotation.song_name,
        start_time: data.startTime ?? annotation.start_time,
        end_time: data.endTime ?? annotation.end_time,
        ...(data.notes === undefined ? {} : { notes: data.notes })
      }));

      return { previous };
    },

    onError: (_error, _variables, context) => {
      for (const [key, detail] of context?.previous ?? []) {
        queryClient.setQueryData(key, detail);
      }
    },

    onSuccess: (updated, variables) => {
      const merged = updated.absorbedIds.length > 0;
      const renamed = variables.data.songName !== undefined;

      // Take the saved row over the guess. Matching what the server holds is
      // also what lets the refetch below arrive as a no-op: react-query's
      // structural sharing keeps the annotations array's identity when the
      // contents are equal, so the detail page's per-annotation gap and
      // flourish scans do not re-run.
      patchCachedAnnotation(queryClient, variables.id, () => ({
        id: updated.id,
        file_id: updated.file_id,
        song_name: updated.song_name,
        start_time: updated.start_time,
        end_time: updated.end_time,
        // Only when there is one. An explicit `notes: undefined` is still a
        // key, and react-query compares key counts -- carrying it would make
        // every patch differ from the refetched row and cost a re-render.
        ...(updated.notes === undefined ? {} : { notes: updated.notes }),
        created_at: updated.created_at,
        updated_at: updated.updated_at
      }));

      // Still refetched: `percentageAnnotated` is computed server-side, and a
      // merge removed rows this client cannot identify from the patch alone.
      queryClient.invalidateQueries({ queryKey: ['fileDetail', updated.file_id] });
      queryClient.invalidateQueries({ queryKey: ['filesByDate'] });
      queryClient.invalidateQueries({ queryKey: ['songPlayHistory'] });
      queryClient.invalidateQueries({ queryKey: ['rebuildStatus'] });

      // The rest only move for some edits, and the detail page has both of
      // these mounted -- invalidating them unconditionally cost two refetches
      // on every drag-resize.
      if (renamed) {
        queryClient.invalidateQueries({ queryKey: ['uniqueSongNames'] });
      }
      // A merge re-points the promotion on any review promoted into an
      // absorbed row; a rename changes the names the reviews resolve to.
      if (merged || renamed) {
        queryClient.invalidateQueries({ queryKey: ['predictionReviews'] });
        queryClient.invalidateQueries({ queryKey: ['predictionReviewQueue'] });
      }
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
      queryClient.invalidateQueries({ queryKey: ['uniqueSongNames'] });
      queryClient.invalidateQueries({ queryKey: ['rebuildStatus'] });
      // Deleting a promoted annotation un-promotes its review, which puts the
      // review back on the roll and in the queue.
      queryClient.invalidateQueries({ queryKey: ['predictionReviews'] });
      queryClient.invalidateQueries({ queryKey: ['predictionReviewQueue'] });
    }
  });
}

export function useSplitAnnotation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      holeStartTime,
      holeEndTime
    }: {
      id: number;
      holeStartTime: number;
      holeEndTime: number;
    }) => annotationsApi.split(id, { holeStartTime, holeEndTime }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fileDetail'] });
      queryClient.invalidateQueries({ queryKey: ['filesByDate'] });
      queryClient.invalidateQueries({ queryKey: ['songPlayHistory'] });
      queryClient.invalidateQueries({ queryKey: ['uniqueSongNames'] });
      queryClient.invalidateQueries({ queryKey: ['rebuildStatus'] });
      queryClient.invalidateQueries({ queryKey: ['predictionReviews'] });
      queryClient.invalidateQueries({ queryKey: ['predictionReviewQueue'] });
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

/**
 * Model-ranked song suggestions for a time range, used by the create
 * annotation modal. Disabled when there is no region to suggest for.
 */
export function useSongSuggestions(
  fileId: number | null,
  startTime: number | null,
  endTime: number | null
) {
  return useQuery({
    queryKey: ['songSuggestions', fileId, startTime, endTime],
    queryFn: () => annotationsApi.suggestSongs({ fileId: fileId!, startTime: startTime!, endTime: endTime! }),
    enabled: (
      fileId !== null
      && startTime !== null
      && endTime !== null
      && endTime > startTime
    ),
    staleTime: 60 * 1000
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
