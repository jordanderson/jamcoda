import { useState } from 'react'
import { FlaskConical, Play, Trash2, ChevronDown, ChevronRight, Check, HelpCircle, X } from 'lucide-react'
import { useLibraryModels, usePreviewPredictionForFile, useRunPredictionForFile } from '@/hooks/usePredictionReviews'
import { TimelineBar } from './FileOverview'
import { SETTING_HELP } from './predictionSettingHelp'
import {
  canApplyCandidate, candidateCountLabel, candidateSpans, type CandidateRun, type SegmentParams
} from './predictionCandidates'
import type { LibraryModelSummary, PredictionDecoderOverrides } from '@/api/localTypes'
import type { RollAnnotation, RollPrediction } from '../midi/pianoRollTypes'
import { errorMessage } from '@core/errors'

/**
 * Try prediction settings on one recording and compare the results.
 *
 * Candidates are owned by the detail page, not by this panel, so the overview
 * beside the piano roll can draw the same runs against the notes. They are
 * never written anywhere: a preview is a dry run, so nothing reaches the review
 * queue until "Apply" is pressed. That is what makes it safe to run on a
 * completed file, where the annotations are the answer to check against.
 *
 * One file is for forming a hypothesis, not for settling one. A setting that
 * looks better here should be checked over the library with `npm run ml:eval`
 * before it changes how models are built.
 */

interface LabParams {
  segment: SegmentParams
  decoder: PredictionDecoderOverrides
  /** A model other than the library's, by file name; absent means `ml/model.json`. */
  modelName?: string
  holdOut: boolean
}

/**
 * On a completed file the lab checks a prediction against a known answer, and
 * the saved model has already learned that answer, so a held-out model is the
 * fair default there. On an unfinished file the app's own predictions do come
 * from a model trained on its annotations so far, so the plain run matches
 * what the app does.
 */
const emptyParams = (isFileComplete: boolean): LabParams =>
  ({ segment: {}, decoder: {}, holdOut: isFileComplete })

/** Model defaults, shown as placeholders so an empty box is not a mystery. */
const SEGMENT_FIELDS: Array<{ key: keyof SegmentParams; label: string; placeholder: string; step: number }> = [
  { key: 'minSegmentSec', label: 'Min segment', placeholder: '8', step: 1 },
  { key: 'mergeGapSec', label: 'Merge gap', placeholder: '5', step: 1 },
  { key: 'minWindowConfidence', label: 'Min window conf.', placeholder: '0.45', step: 0.05 },
  { key: 'smoothingWindows', label: 'Smoothing', placeholder: '5', step: 1 },
  { key: 'minSegmentConfidence', label: 'Min segment conf.', placeholder: '0.3', step: 0.05 }
]

const DECODER_FIELDS: Array<{ key: keyof PredictionDecoderOverrides; label: string; placeholder: string; step: number }> = [
  { key: 'anchorMargin', label: 'Anchor margin', placeholder: '0.15', step: 0.01 },
  { key: 'minAnchorRun', label: 'Min anchor run', placeholder: '3', step: 1 },
  { key: 'linkMaxSilenceRatio', label: 'Max link silence', placeholder: '0.7', step: 0.05 },
  { key: 'fillTopK', label: 'Fill top-K', placeholder: '-1', step: 1 },
  { key: 'linkTailSec', label: 'Tail leash (s)', placeholder: '2', step: 1 },
  { key: 'linkRescueRank', label: 'Rescue rank', placeholder: '5', step: 1 }
]

const SEGMENT_KEYS: string[] = SEGMENT_FIELDS.map((field) => field.key)
const MODEL_KEYS = ['model', 'holdOut']

/** `knn-song-segmenter@2026-09-04T01:47:18.913Z` reads better as a date. */
function modelStamp(modelVersion: string): string {
  const match = modelVersion.match(/(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/)
  return match ? `${match[1]} ${match[2]}` : modelVersion
}

function modelOptionLabel(model: LibraryModelSummary): string {
  const name = model.isLibraryModel ? `${model.name} (library model)` : model.name
  if (model.error) return `${name} — cannot load`
  const details = [
    model.modelVersion,
    model.createdAt ? modelStamp(model.createdAt) : null,
    model.featureCount !== null ? `${model.featureCount} features` : null
  ].filter(Boolean)
  return details.length > 0 ? `${name} — ${details.join(', ')}` : name
}

/** Name a run by what it changed, so the list stays readable without notes. */
function describe(params: LabParams): string {
  const parts: string[] = []
  if (params.modelName) parts.push(`model=${params.modelName}`)
  if (params.holdOut) parts.push('held out')
  if (params.decoder.linkPolicy) parts.push(`link=${params.decoder.linkPolicy}`)
  for (const [key, value] of Object.entries({ ...params.decoder, ...params.segment })) {
    if (key === 'linkPolicy' || value === undefined) continue
    parts.push(`${key}=${value}`)
  }
  return parts.length > 0 ? parts.join(', ') : 'model defaults'
}

function HelpButton({ settingKey, openKey, onToggle }: {
  settingKey: string
  openKey: string | null
  onToggle: (key: string) => void
}) {
  const isOpen = openKey === settingKey
  return (
    <button
      type="button"
      onClick={() => onToggle(settingKey)}
      aria-expanded={isOpen}
      aria-label={`What does ${SETTING_HELP[settingKey]?.title ?? settingKey} do?`}
      className={`shrink-0 rounded-full transition-colors ${
        isOpen ? 'text-indigo-600' : 'text-gray-400 hover:text-gray-600'
      }`}
    >
      <HelpCircle className="w-3.5 h-3.5" />
    </button>
  )
}

/**
 * The explanation appears below its group rather than floating over the field.
 * These notes run to a paragraph or two, which a tooltip cannot hold, and a
 * panel cannot be clipped by the edge of the grid.
 */
function HelpPanel({ settingKey, onClose }: { settingKey: string; onClose: () => void }) {
  const help = SETTING_HELP[settingKey]
  if (!help) return null
  return (
    <div className="mt-3 rounded-lg border border-indigo-200 bg-indigo-50 p-3">
      <div className="flex items-start justify-between gap-3">
        <h4 className="text-sm font-semibold text-indigo-900">{help.title}</h4>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close explanation"
          className="shrink-0 text-indigo-400 hover:text-indigo-700"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="mt-1 space-y-2">
        {help.body.map((paragraph, index) => (
          <p key={index} className="text-xs leading-relaxed text-indigo-900/90">{paragraph}</p>
        ))}
      </div>
    </div>
  )
}

function NumberField({ settingKey, label, placeholder, step, value, onChange, openKey, onToggleHelp }: {
  settingKey: string
  label: string
  placeholder: string
  step: number
  value: number | undefined
  onChange: (value: number | undefined) => void
  openKey: string | null
  onToggleHelp: (key: string) => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1 text-xs text-gray-600">
        <label htmlFor={`lab-${settingKey}`} className="truncate">{label}</label>
        <HelpButton settingKey={settingKey} openKey={openKey} onToggle={onToggleHelp} />
      </div>
      <input
        id={`lab-${settingKey}`}
        type="number"
        step={step}
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(event) => {
          const raw = event.target.value
          onChange(raw === '' ? undefined : Number(raw))
        }}
        className="w-full px-2 py-1 border rounded text-sm text-gray-900"
      />
    </div>
  )
}

interface PredictionLabProps {
  fileId: number
  durationSec: number
  currentTime: number
  annotations: RollAnnotation[]
  currentPredictions: RollPrediction[]
  isFileComplete: boolean
  /**
   * Model that produced the rows currently in the review queue. The queue is
   * stored output, not a fresh decode, so it can predate the model on disk —
   * and then it is not a baseline any candidate can be compared against.
   */
  queueModelVersion?: string
  /** Owned by the detail page so the overview can draw the same runs. */
  runs: CandidateRun[]
  onRunsChange: (update: (current: CandidateRun[]) => CandidateRun[]) => void
  onSeek: (time: number) => void
  onError: (message: string) => void
}

export function PredictionLab({
  fileId, durationSec, currentTime, annotations, currentPredictions, isFileComplete,
  queueModelVersion, runs, onRunsChange, onSeek, onError
}: PredictionLabProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [params, setParams] = useState<LabParams>(() => emptyParams(isFileComplete))
  const [nextId, setNextId] = useState(1)
  const [openHelp, setOpenHelp] = useState<string | null>(null)
  const [previewModelVersion, setPreviewModelVersion] = useState<string | null>(null)

  const preview = usePreviewPredictionForFile()
  const commit = useRunPredictionForFile()
  const models = useLibraryModels(isOpen)

  const toggleHelp = (key: string) => setOpenHelp((current) => (current === key ? null : key))

  const handlePreview = () => {
    preview.mutate(
      {
        fileId,
        ...params.segment,
        decoderOverrides: Object.keys(params.decoder).length > 0 ? params.decoder : undefined,
        modelName: params.modelName,
        holdOut: params.holdOut || undefined
      },
      {
        onSuccess: (result) => {
          // The review queue only ever holds predictions from the library model.
          if (!params.modelName) setPreviewModelVersion(result.modelVersion)
          onRunsChange((current) => [
            ...current,
            {
              id: nextId,
              label: describe(params),
              request: {
                segment: params.segment,
                decoder: params.decoder,
                modelName: params.modelName,
                holdOut: params.holdOut
              },
              segments: result.segments ?? [],
              rawSegments: result.rawSegments ?? []
            }
          ])
          setNextId((id) => id + 1)
        },
        onError: (error) => onError(errorMessage(error, 'Preview failed'))
      }
    )
  }

  const handleApply = (run: CandidateRun) => {
    commit.mutate(
      {
        fileId,
        ...run.request.segment,
        decoderOverrides: Object.keys(run.request.decoder).length > 0 ? run.request.decoder : undefined
      },
      {
        onSuccess: () => onRunsChange(() => []),
        onError: (error) => onError(errorMessage(error, 'Failed to apply settings'))
      }
    )
  }

  const setSegment = (key: keyof SegmentParams, value: number | undefined) =>
    setParams((current) => ({ ...current, segment: { ...current.segment, [key]: value } }))
  const setDecoder = (key: keyof PredictionDecoderOverrides, value: number | undefined) =>
    setParams((current) => ({ ...current, decoder: { ...current.decoder, [key]: value } }))

  const helpGroup = openHelp === null
    ? null
    : MODEL_KEYS.includes(openHelp) ? 'model' : SEGMENT_KEYS.includes(openHelp) ? 'segment' : 'decoder'
  const modelList = models.data ?? []
  // Only knowable once a preview has reported which model it used.
  const isStaleQueue = Boolean(
    queueModelVersion && previewModelVersion && queueModelVersion !== previewModelVersion
  )

  return (
    <div className="border rounded-lg shadow-sm bg-white">
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        className="w-full p-6 flex items-center gap-2 text-left"
      >
        {isOpen ? <ChevronDown className="w-4 h-4 text-gray-500" /> : <ChevronRight className="w-4 h-4 text-gray-500" />}
        <FlaskConical className="w-5 h-5 text-indigo-600" />
        <span className="text-xl font-bold text-gray-900">Prediction Lab</span>
      </button>

      {isOpen && (
        <div className="px-6 pb-6 space-y-5">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Model and training</h3>
            <p className="text-xs text-gray-500 mb-2">
              Which trained model predicts. Runs from different models differ in what was
              learned, not just in how it is decoded.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-1 text-xs text-gray-600">
                  <label htmlFor="lab-model" className="truncate">Model</label>
                  <HelpButton settingKey="model" openKey={openHelp} onToggle={toggleHelp} />
                </div>
                <select
                  id="lab-model"
                  value={params.modelName ?? ''}
                  onChange={(event) => setParams((current) => ({
                    ...current,
                    modelName: event.target.value === '' ? undefined : event.target.value
                  }))}
                  className="w-full px-2 py-1 border rounded text-sm text-gray-900"
                >
                  {modelList.length === 0 && <option value="">model.json (library model)</option>}
                  {modelList.map((model) => (
                    <option
                      key={model.name}
                      value={model.isLibraryModel ? '' : model.name}
                      disabled={Boolean(model.error)}
                      title={model.error ?? undefined}
                    >
                      {modelOptionLabel(model)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-1 text-xs text-gray-600">
                  <span className="truncate">Training</span>
                  <HelpButton settingKey="holdOut" openKey={openHelp} onToggle={toggleHelp} />
                </div>
                <label className="flex items-center gap-2 py-1 text-sm text-gray-900">
                  <input
                    type="checkbox"
                    checked={params.holdOut}
                    onChange={(event) => setParams((current) => ({ ...current, holdOut: event.target.checked }))}
                  />
                  Hold this file out
                  <span className="text-xs text-gray-500">(retrains without it, a few seconds)</span>
                </label>
              </div>
            </div>
            {helpGroup === 'model' && openHelp && (
              <HelpPanel settingKey={openHelp} onClose={() => setOpenHelp(null)} />
            )}
          </div>

          <div>
            <h3 className="text-sm font-semibold text-gray-900">Segment shaping</h3>
            <p className="text-xs text-gray-500 mb-2">
              Applied after decoding. These never touch the model.
            </p>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {SEGMENT_FIELDS.map((field) => (
                <NumberField
                  key={field.key}
                  settingKey={field.key}
                  label={field.label}
                  placeholder={field.placeholder}
                  step={field.step}
                  value={params.segment[field.key]}
                  onChange={(value) => setSegment(field.key, value)}
                  openKey={openHelp}
                  onToggleHelp={toggleHelp}
                />
              ))}
            </div>
            {helpGroup === 'segment' && openHelp && (
              <HelpPanel settingKey={openHelp} onClose={() => setOpenHelp(null)} />
            )}
          </div>

          <div>
            <h3 className="text-sm font-semibold text-gray-900">Decoding</h3>
            <p className="text-xs text-gray-500 mb-2">
              Re-decodes the same trained model, so runs that differ only here are
              directly comparable. Empty means whatever the model was trained with.
            </p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-1 text-xs text-gray-600">
                  <label htmlFor="lab-linkPolicy" className="truncate">Link policy</label>
                  <HelpButton settingKey="linkPolicy" openKey={openHelp} onToggle={toggleHelp} />
                </div>
                <select
                  id="lab-linkPolicy"
                  value={params.decoder.linkPolicy ?? ''}
                  onChange={(event) => setParams((current) => ({
                    ...current,
                    decoder: {
                      ...current.decoder,
                      linkPolicy: event.target.value === ''
                        ? undefined
                        : (event.target.value as 'legacy' | 'bridge')
                    }
                  }))}
                  className="w-full px-2 py-1 border rounded text-sm text-gray-900"
                >
                  <option value="">model default</option>
                  <option value="legacy">legacy</option>
                  <option value="bridge">bridge</option>
                </select>
              </div>
              {DECODER_FIELDS.map((field) => (
                <NumberField
                  key={field.key}
                  settingKey={field.key}
                  label={field.label}
                  placeholder={field.placeholder}
                  step={field.step}
                  value={params.decoder[field.key] as number | undefined}
                  onChange={(value) => setDecoder(field.key, value)}
                  openKey={openHelp}
                  onToggleHelp={toggleHelp}
                />
              ))}
            </div>
            {helpGroup === 'decoder' && openHelp && (
              <HelpPanel settingKey={openHelp} onClose={() => setOpenHelp(null)} />
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handlePreview}
              disabled={preview.isPending}
              className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2"
            >
              <Play className="w-4 h-4" />
              {preview.isPending
                ? (params.holdOut ? 'Retraining without this file…' : 'Previewing…')
                : 'Preview'}
            </button>
            <button
              type="button"
              onClick={() => setParams(emptyParams(isFileComplete))}
              className="px-3 py-2 rounded-lg border text-sm text-gray-700 hover:bg-gray-50"
            >
              Reset to defaults
            </button>
            {runs.length > 0 && (
              <button
                type="button"
                onClick={() => onRunsChange(() => [])}
                className="px-3 py-2 rounded-lg border text-sm text-gray-700 hover:bg-gray-50"
              >
                Clear candidates
              </button>
            )}
          </div>

          <div className="space-y-3">
            {annotations.length > 0 && (
              <TimelineBar
                label={`Labels ${isFileComplete
                  ? '(this file is complete, so these are the answer)'
                  : '(so far)'}`}
                durationSec={durationSec}
                currentTime={currentTime}
                onSeek={onSeek}
                spans={annotations.map((annotation) => ({
                  key: `lab-annotation-${annotation.id}`,
                  label: annotation.song_name,
                  start: annotation.start_time,
                  end: annotation.end_time
                }))}
              />
            )}

            <div>
              <TimelineBar
                label={`Current review queue (${currentPredictions.length})`}
                detail={queueModelVersion ? `stored from ${modelStamp(queueModelVersion)}` : 'stored output'}
                durationSec={durationSec}
                currentTime={currentTime}
                onSeek={onSeek}
                emptyLabel="Nothing in the queue"
                spans={currentPredictions.map((prediction) => ({
                  key: `lab-current-${prediction.id}`,
                  label: prediction.songName,
                  start: prediction.startTime,
                  end: prediction.endTime,
                  ...(prediction.parts ? { parts: prediction.parts } : {})
                }))}
              />
              {isStaleQueue && (
                <p className="mt-1 text-[11px] text-amber-700">
                  This queue was written by an older model ({modelStamp(queueModelVersion!)}), not the one
                  a preview uses ({modelStamp(previewModelVersion!)}). Comparing a candidate against it mixes a
                  model change with a settings change — preview once with <strong>Link policy: legacy</strong> for a
                  like-for-like baseline.
                </p>
              )}
            </div>

            {runs.map((run) => (
              <TimelineBar
                key={run.id}
                label={`Candidate ${run.id}: ${run.label}`}
                detail={candidateCountLabel(run, isFileComplete)}
                durationSec={durationSec}
                currentTime={currentTime}
                onSeek={onSeek}
                spans={candidateSpans(run, isFileComplete)}
                trailing={(
                  <>
                    <button
                      type="button"
                      onClick={() => handleApply(run)}
                      disabled={commit.isPending || isFileComplete || !canApplyCandidate(run)}
                      title={isFileComplete
                        ? 'A completed file\u2019s labels are final, so predictions cannot be written to it'
                        : !canApplyCandidate(run)
                          ? 'Only the library model, as saved, writes to the review queue; this run is for comparing'
                          : 'Re-run for real and replace the unpromoted review queue'}
                      className="px-2 py-1 rounded border text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-40 flex items-center gap-1"
                    >
                      <Check className="w-3 h-3" />
                      Apply
                    </button>
                    <button
                      type="button"
                      onClick={() => onRunsChange((current) => current.filter((item) => item.id !== run.id))}
                      title="Discard this candidate"
                      className="p-1 rounded border text-gray-500 hover:bg-gray-50"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </>
                )}
              />
            ))}
          </div>

          <p className="text-xs text-gray-500 border-t pt-3">
            Candidates also appear in the overview beside the piano roll, and are held
            in this page only — they disappear when you leave it.
            Check a setting across the library with <code className="text-gray-700">npm run ml:eval</code> and{' '}
            <code className="text-gray-700">npm run ml:compare</code> before changing how models are built.
          </p>
        </div>
      )}
    </div>
  )
}
