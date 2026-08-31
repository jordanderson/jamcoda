/** Shapes shared by the piano roll container and its memoised layers. */

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
}

export interface RollIgnoredSection {
  id: number
  startTime: number
  endTime: number
  reason?: string
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
