// API client for local backend (Express server on localhost:3001)
import type {
  CreateIgnoredSectionRequest,
  CreateIgnoredSectionResponse,
  FilesByDateResponse,
  FileDetailResponse,
  IgnoredSectionListResponse,
  MergePredictionReviewsRequest,
  MergePredictionReviewsResponse,
  PredictionReviewListResponse,
  PredictionReviewQueueResponse,
  PredictionReviewStatus,
  RenameSongNameRequest,
  RenameSongNameResponse,
  RebuildPredictionModelRequest,
  RebuildPredictionModelResponse,
  PromotePredictionReviewResponse,
  PromoteReviewedPredictionReviewsResponse,
  SongPlayHistoryResponse,
  SetFileCompletionRequest,
  SetFileCompletionResponse,
  RunPredictionForFileRequest,
  RunPredictionForFileResponse
} from './localTypes';

export const syncApi = {
  start: async () => {
    const response = await fetch('/api/sync/start', { method: 'POST' });
    if (!response.ok) throw new Error('Failed to start sync');
    return response.json();
  },

  getProgress: async (syncId: string) => {
    const response = await fetch(`/api/sync/progress/${syncId}`);
    if (!response.ok) throw new Error('Failed to get sync progress');
    return response.json();
  },

  getStatus: async () => {
    const response = await fetch('/api/sync/status');
    if (!response.ok) throw new Error('Failed to get sync status');
    return response.json();
  }
};

export const localFilesApi = {
  getByDate: async (startDate?: string, endDate?: string): Promise<FilesByDateResponse> => {
    const params = new URLSearchParams();
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);

    const response = await fetch(`/api/files/by-date?${params}`);
    if (!response.ok) throw new Error('Failed to get files');
    return response.json();
  },

  getDetail: async (id: number): Promise<FileDetailResponse> => {
    const response = await fetch(`/api/files/${id}`);
    if (!response.ok) throw new Error('Failed to get file detail');
    return response.json();
  },

  setCompletion: async (id: number, data: SetFileCompletionRequest): Promise<SetFileCompletionResponse> => {
    const response = await fetch(`/api/files/${id}/completion`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!response.ok) {
      return throwApiError(response, 'Failed to update file completion');
    }
    return response.json();
  },

  download: async (id: number) => {
    const response = await fetch(`/api/files/${id}/download`);
    if (!response.ok) throw new Error('Failed to download file');
    return response.blob();
  }
};

export const ignoredSectionsApi = {
  list: async (fileId: number): Promise<IgnoredSectionListResponse> => {
    const params = new URLSearchParams({ fileId: String(fileId) });
    const response = await fetch(`/api/ignored-sections?${params.toString()}`);
    if (!response.ok) {
      return throwApiError(response, 'Failed to list ignored sections');
    }
    return response.json();
  },

  create: async (data: CreateIgnoredSectionRequest): Promise<CreateIgnoredSectionResponse> => {
    const response = await fetch('/api/ignored-sections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!response.ok) {
      return throwApiError(response, 'Failed to create ignored section');
    }
    return response.json();
  },

  delete: async (id: number): Promise<void> => {
    const response = await fetch(`/api/ignored-sections/${id}`, {
      method: 'DELETE'
    });
    if (!response.ok) {
      return throwApiError(response, 'Failed to delete ignored section');
    }
  }
};

export const annotationsApi = {
  list: async (fileId: number) => {
    const response = await fetch(`/api/annotations/${fileId}`);
    if (!response.ok) throw new Error('Failed to get annotations');
    return response.json();
  },

  getUniqueSongNames: async (): Promise<string[]> => {
    const response = await fetch('/api/annotations/song-names/unique');
    if (!response.ok) throw new Error('Failed to get song names');
    return response.json();
  },

  getSongPlayHistory: async (): Promise<SongPlayHistoryResponse> => {
    const response = await fetch('/api/annotations/songs');
    if (!response.ok) throw new Error('Failed to get song play history');
    return response.json();
  },

  create: async (data: { fileId: number; songName: string; startTime: number; endTime: number; notes?: string }) => {
    const response = await fetch('/api/annotations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!response.ok) throw new Error('Failed to create annotation');
    return response.json();
  },

  update: async (id: number, data: Partial<{ songName: string; startTime: number; endTime: number; notes: string }>) => {
    const response = await fetch(`/api/annotations/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!response.ok) throw new Error('Failed to update annotation');
    return response.json();
  },

  delete: async (id: number) => {
    const response = await fetch(`/api/annotations/${id}`, { method: 'DELETE' });
    if (!response.ok) throw new Error('Failed to delete annotation');
  },

  renameSongName: async (data: RenameSongNameRequest): Promise<RenameSongNameResponse> => {
    const response = await fetch('/api/annotations/song-names/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!response.ok) {
      return throwApiError(response, 'Failed to rename song');
    }
    return response.json();
  }
};

function parseErrorMessage(errorBody: any, fallback: string): string {
  if (errorBody && typeof errorBody.error === 'string' && errorBody.error.trim().length > 0) {
    return errorBody.error;
  }
  return fallback;
}

async function throwApiError(response: Response, fallback: string): Promise<never> {
  const text = await response.text();
  if (text.trim().length > 0) {
    let parsedMessage: string | null = null;
    try {
      const body = JSON.parse(text);
      parsedMessage = parseErrorMessage(body, fallback);
    } catch {
      parsedMessage = null;
    }
    throw new Error(parsedMessage ?? text);
  }
  throw new Error(fallback);
}

export const predictionReviewsApi = {
  list: async (params: {
    fileId?: number;
    status?: PredictionReviewStatus;
    includePromoted?: boolean;
    limit?: number;
    offset?: number;
  } = {}): Promise<PredictionReviewListResponse> => {
    const searchParams = new URLSearchParams();
    if (params.fileId !== undefined) searchParams.set('fileId', String(params.fileId));
    if (params.status) searchParams.set('status', params.status);
    if (params.includePromoted !== undefined) {
      searchParams.set('includePromoted', String(params.includePromoted));
    }
    if (params.limit !== undefined) searchParams.set('limit', String(params.limit));
    if (params.offset !== undefined) searchParams.set('offset', String(params.offset));

    const response = await fetch(`/api/prediction-reviews?${searchParams.toString()}`);
    if (!response.ok) {
      return throwApiError(response, 'Failed to list prediction reviews');
    }
    return response.json();
  },

  getQueue: async (params: {
    fileId?: number;
    limit?: number;
  } = {}): Promise<PredictionReviewQueueResponse> => {
    const searchParams = new URLSearchParams();
    if (params.fileId !== undefined) searchParams.set('fileId', String(params.fileId));
    if (params.limit !== undefined) searchParams.set('limit', String(params.limit));

    const response = await fetch(`/api/prediction-reviews/queue?${searchParams.toString()}`);
    if (!response.ok) {
      return throwApiError(response, 'Failed to get prediction review queue');
    }
    return response.json();
  },

  update: async (id: number, data: Partial<{
    status: PredictionReviewStatus;
    reviewedSongName: string | null;
    reviewedStartTime: number | null;
    reviewedEndTime: number | null;
    reviewNotes: string | null;
    modelVersion: string | null;
  }>) => {
    const response = await fetch(`/api/prediction-reviews/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!response.ok) {
      return throwApiError(response, 'Failed to update prediction review');
    }
    return response.json();
  },

  promote: async (id: number): Promise<PromotePredictionReviewResponse> => {
    const response = await fetch(`/api/prediction-reviews/${id}/promote`, {
      method: 'POST'
    });
    if (!response.ok) {
      return throwApiError(response, 'Failed to promote prediction review');
    }
    return response.json();
  },

  promoteReviewed: async (params: {
    fileId?: number;
    limit?: number;
  } = {}): Promise<PromoteReviewedPredictionReviewsResponse> => {
    const response = await fetch('/api/prediction-reviews/promote-reviewed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    if (!response.ok) {
      return throwApiError(response, 'Failed to promote reviewed prediction reviews');
    }
    return response.json();
  },

  merge: async (data: MergePredictionReviewsRequest): Promise<MergePredictionReviewsResponse> => {
    const response = await fetch('/api/prediction-reviews/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!response.ok) {
      return throwApiError(response, 'Failed to merge prediction reviews');
    }
    return response.json();
  },

  runForFile: async (data: RunPredictionForFileRequest): Promise<RunPredictionForFileResponse> => {
    const response = await fetch('/api/prediction-reviews/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!response.ok) {
      return throwApiError(response, 'Failed to run predictions for file');
    }
    return response.json();
  },

  rebuildModel: async (
    data: RebuildPredictionModelRequest = {}
  ): Promise<RebuildPredictionModelResponse> => {
    const response = await fetch('/api/prediction-reviews/rebuild-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!response.ok) {
      return throwApiError(response, 'Failed to rebuild model');
    }
    return response.json();
  }
};
