import { describe, expect, it } from 'vitest'
import {
  applyBrowseView,
  DEFAULT_BROWSE_VIEW,
  getBrowseProgress,
  type BrowseFile
} from './browseView'

function file(overrides: Partial<BrowseFile> & { id: number }): BrowseFile {
  return {
    filename: `file-${overrides.id}.mid`,
    fileSize: 1024,
    dateRecorded: '2026-01-01',
    isComplete: false,
    completedAt: null,
    annotationCount: 0,
    percentageAnnotated: 0,
    totalDuration: 600,
    annotatedDuration: 0,
    annotations: [],
    unreviewedPredictionCount: 0,
    date: '2026-01-01',
    ...overrides
  }
}

// As the server hands them over: date_recorded DESC, filename ASC.
const files: BrowseFile[] = [
  file({ id: 1, date: '2026-03-02', filename: 'a.mid', unreviewedPredictionCount: 2 }),
  file({ id: 2, date: '2026-03-02', filename: 'b.mid', unreviewedPredictionCount: 9 }),
  file({ id: 3, date: '2026-03-01', filename: 'c.mid', unreviewedPredictionCount: 9, isComplete: true }),
  file({ id: 4, date: '2026-02-28', filename: 'd.mid', unreviewedPredictionCount: 0 })
]

describe('applyBrowseView', () => {
  it('defaults to newest first with every file shown', () => {
    const result = applyBrowseView(files, DEFAULT_BROWSE_VIEW)

    expect(result.map((f) => f.id)).toEqual([1, 2, 3, 4])
  })

  it('sorts by unreviewed count descending', () => {
    const result = applyBrowseView(files, { sort: 'unreviewed-desc', incompleteOnly: false })

    expect(result.map((f) => f.unreviewedPredictionCount)).toEqual([9, 9, 2, 0])
  })

  it('breaks an unreviewed tie by date, newest first', () => {
    const result = applyBrowseView(files, { sort: 'unreviewed-desc', incompleteOnly: false })

    // Ids 2 and 3 both have 9 unreviewed; 2 was recorded a day later.
    expect(result.slice(0, 2).map((f) => f.id)).toEqual([2, 3])
  })

  it('keeps the filename order the server sent for files that tie completely', () => {
    const sameDay = [
      file({ id: 10, date: '2026-03-02', filename: 'a.mid', unreviewedPredictionCount: 4 }),
      file({ id: 11, date: '2026-03-02', filename: 'b.mid', unreviewedPredictionCount: 4 }),
      file({ id: 12, date: '2026-03-02', filename: 'c.mid', unreviewedPredictionCount: 4 })
    ]

    const result = applyBrowseView(sameDay, { sort: 'unreviewed-desc', incompleteOnly: false })

    expect(result.map((f) => f.filename)).toEqual(['a.mid', 'b.mid', 'c.mid'])
  })

  it('drops completed files when the filter is on', () => {
    const result = applyBrowseView(files, { sort: 'date-desc', incompleteOnly: true })

    expect(result.map((f) => f.id)).toEqual([1, 2, 4])
  })

  it('combines the filter with the unreviewed sort', () => {
    const result = applyBrowseView(files, { sort: 'unreviewed-desc', incompleteOnly: true })

    expect(result.map((f) => f.id)).toEqual([2, 1, 4])
  })

  it('never reorders or filters the array it was given', () => {
    const input = [...files]

    applyBrowseView(input, { sort: 'unreviewed-desc', incompleteOnly: true })

    expect(input.map((f) => f.id)).toEqual([1, 2, 3, 4])
  })
})

describe('getBrowseProgress', () => {
  it('counts a complete file as fully annotated whatever its annotations cover', () => {
    const progress = getBrowseProgress([
      file({ id: 1, isComplete: true, totalDuration: 600, annotatedDuration: 120 })
    ])

    expect(progress.annotatedSeconds).toBe(600)
    expect(progress.percentage).toBe(100)
    expect(progress.completeFileCount).toBe(1)
  })

  it('adds the annotated span of every file still incomplete', () => {
    const progress = getBrowseProgress([
      file({ id: 1, isComplete: true, totalDuration: 600, annotatedDuration: 0 }),
      file({ id: 2, totalDuration: 600, annotatedDuration: 300 }),
      file({ id: 3, totalDuration: 800, annotatedDuration: 0 })
    ])

    expect(progress.totalSeconds).toBe(2000)
    expect(progress.annotatedSeconds).toBe(900)
    expect(progress.percentage).toBe(45)
    expect(progress.completeFileCount).toBe(1)
    expect(progress.fileCount).toBe(3)
  })

  it('clamps a file whose overlapping annotations exceed its duration', () => {
    // getTotalAnnotatedDuration sums annotations without merging them.
    const progress = getBrowseProgress([
      file({ id: 1, totalDuration: 600, annotatedDuration: 900 }),
      file({ id: 2, totalDuration: 600, annotatedDuration: 0 })
    ])

    expect(progress.annotatedSeconds).toBe(600)
    expect(progress.percentage).toBe(50)
  })

  it('reports zero rather than dividing by an empty library', () => {
    expect(getBrowseProgress([]).percentage).toBe(0)
    expect(getBrowseProgress([file({ id: 1, totalDuration: 0 })]).percentage).toBe(0)
  })

  it('measures the whole library, not the files a filter left visible', () => {
    const all = [
      file({ id: 1, isComplete: true, totalDuration: 600 }),
      file({ id: 2, totalDuration: 600, annotatedDuration: 0 })
    ]

    const progress = getBrowseProgress(all)
    const incompleteOnly = applyBrowseView(all, { sort: 'date-desc', incompleteOnly: true })

    expect(incompleteOnly).toHaveLength(1)
    expect(progress.fileCount).toBe(2)
    expect(progress.percentage).toBe(50)
  })
})
