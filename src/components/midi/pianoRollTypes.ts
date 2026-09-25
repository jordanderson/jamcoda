/** Shapes shared by the piano roll container and its memoised layers. */

import type { EvidencePart } from '@core/predictionEvidence'

export interface RollAnnotation {
  id: number
  song_name: string
  start_time: number
  end_time: number
  notes?: string
}

export interface RollPrediction {
  id: number
  songName: string
  startTime: number
  endTime: number
  confidence: number | null
  /**
   * How the model reached the song over each stretch, for a prediction still
   * awaiting review. Absent once it is reviewed, and for predictions stored
   * before parts were.
   */
  parts?: EvidencePart[]
}


/** Device passage bookmark, drawn as a solid green circle like the Jamcorder. */
export interface RollBookmark {
  bookmarkIdx: number
  timeSec: number
}

/** Device silence gap, drawn as a green ring. */
export interface RollSkip {
  millis: number
  timeSec: number
}
