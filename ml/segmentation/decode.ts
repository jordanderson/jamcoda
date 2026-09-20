/**
 * Scoring windows and joining them into song segments.
 *
 * This is the half that turns per-window guesses into takes: score each
 * window against the model, find the runs it is sure about, then link those
 * runs across the passages it is not. `anchorLinkDecode` holds those rules.
 */
import { clamp, roundTo } from '@core/cli/args';
import { snapSegmentBoundaries, type BoundaryNote } from '@core/boundaries';
import {
  NO_SONG_LABEL,
  SILENCE_RATIO_INDEX,
  type NoteEvent,
  type PredictConfig,
  type SongSegment,
  type SongSegmentModel,
  type TrainConfig,
  type WindowPrediction,
  type WindowSample
} from './types';
import { squaredDistance } from './vectors';

function computeKnnScores(normalizedVector: number[], model: SongSegmentModel): number[] {
  const vectors = model.trainingVectors!;
  const labels = model.trainingLabelIndices!;
  const total = vectors.length;
  const k = Math.max(1, Math.min(model.config.k, total));
  const distances = new Array<{ idx: number; distance: number }>(total);

  for (let i = 0; i < total; i++) {
    distances[i] = {
      idx: i,
      distance: squaredDistance(normalizedVector, vectors[i])
    };
  }
  distances.sort((a, b) => a.distance - b.distance);

  const scores = new Array<number>(model.labels.length).fill(0);
  for (let i = 0; i < k; i++) {
    const row = distances[i];
    const weight = 1 / (Math.sqrt(row.distance) + 1e-6);
    scores[labels[row.idx]] += weight;
  }
  return scores;
}

/** v2: per-label score from that label's prototypes. */
function computePrototypeScores(normalizedVector: number[], model: SongSegmentModel): number[] {
  const scores = new Array<number>(model.labels.length).fill(0);

  if (model.config.scoreMode === 'avg') {
    const count = new Array<number>(model.labels.length).fill(0);
    const kernelScale = model.kernelScale ?? 1;
    for (const prototype of model.prototypes!) {
      const d = squaredDistance(normalizedVector, prototype.features);
      scores[prototype.labelIndex] += Math.exp(-d / kernelScale);
      count[prototype.labelIndex]++;
    }
    for (let labelIndex = 0; labelIndex < model.labels.length; labelIndex++) {
      if (count[labelIndex] > 0) scores[labelIndex] /= count[labelIndex];
    }
    return scores;
  }

  // 'min' mode: score each label by the distance to its nearest prototypes.
  // The score is negative, so a higher score is a better match.
  //
  // Labels with more prototypes score better than they should. See
  // `allocatePrototypeBudgets` for the measurements.
  const neighbors = Math.max(1, model.scoreNeighbors ?? 1);
  const nearest: number[][] = Array.from({ length: model.labels.length }, () => []);

  for (const prototype of model.prototypes!) {
    const d = squaredDistance(normalizedVector, prototype.features);
    const heap = nearest[prototype.labelIndex];
    // Keep the `neighbors` smallest distances per label, largest last.
    if (heap.length < neighbors) {
      heap.push(d);
      heap.sort((a, b) => a - b);
    } else if (d < heap[heap.length - 1]) {
      heap[heap.length - 1] = d;
      heap.sort((a, b) => a - b);
    }
  }

  for (let labelIndex = 0; labelIndex < model.labels.length; labelIndex++) {
    const heap = nearest[labelIndex];
    if (heap.length === 0) {
      scores[labelIndex] = -Infinity;
      continue;
    }
    let sum = 0;
    for (const d of heap) sum += Math.sqrt(d);
    scores[labelIndex] = -(sum / heap.length);
  }
  return scores;
}

export function computeLabelScores(normalizedVector: number[], model: SongSegmentModel): number[] {
  if (model.prototypes && model.prototypes.length > 0) {
    return computePrototypeScores(normalizedVector, model);
  }
  return computeKnnScores(normalizedVector, model);
}

// This file contained `predictLabelIndex`, a per-window argmax. Its
// confidence was `max(0, best) / sum(max(0, scores))`. In 'min' score mode
// every score is negative, so the sum was always 0 and the confidence was
// always 0. Its only caller, leave-one-out evaluation, now uses
// `predictWindowsFromSamples`.

function scoresToLogProbs(scores: number[], temperature: number): number[] {
  let maxScore = -Infinity;
  for (const score of scores) if (score > maxScore) maxScore = score;

  const shifted = scores.map((score) => (score - maxScore) / Math.max(1e-9, temperature));
  let sumExp = 0;
  for (const value of shifted) sumExp += Math.exp(value);
  const logZ = Math.log(Math.max(1e-9, sumExp));
  return shifted.map((value) => value - logZ);
}

/**
 * Viterbi decode over per-window log-probabilities with a single label-change
 * penalty. Enforces that songs occupy contiguous runs of windows, which is the
 * structure the annotations actually have.
 */
function decodeViterbi(emissions: number[][], changePenalty: number): number[] {
  const windowCount = emissions.length;
  if (windowCount === 0) return [];
  const labelCount = emissions[0].length;

  let dp = emissions[0].slice();
  const backPointers = new Array<Int32Array>(windowCount);
  backPointers[0] = new Int32Array(labelCount).fill(-1);

  for (let t = 1; t < windowCount; t++) {
    let top1 = -Infinity;
    let top2 = -Infinity;
    let arg1 = -1;
    let arg2 = -1;
    for (let labelIndex = 0; labelIndex < labelCount; labelIndex++) {
      const value = dp[labelIndex];
      if (value > top1) {
        top2 = top1;
        arg2 = arg1;
        top1 = value;
        arg1 = labelIndex;
      } else if (value > top2) {
        top2 = value;
        arg2 = labelIndex;
      }
    }

    const current = new Array<number>(labelCount);
    const back = new Int32Array(labelCount);
    const emission = emissions[t];
    for (let labelIndex = 0; labelIndex < labelCount; labelIndex++) {
      const stay = dp[labelIndex];
      const bestOther = (labelIndex === arg1 ? top2 : top1) - changePenalty;
      if (stay >= bestOther) {
        current[labelIndex] = emission[labelIndex] + stay;
        back[labelIndex] = labelIndex;
      } else {
        current[labelIndex] = emission[labelIndex] + bestOther;
        back[labelIndex] = labelIndex === arg1 ? arg2 : arg1;
      }
    }
    dp = current;
    backPointers[t] = back;
  }

  let bestLabel = 0;
  for (let labelIndex = 1; labelIndex < labelCount; labelIndex++) {
    if (dp[labelIndex] > dp[bestLabel]) bestLabel = labelIndex;
  }

  const path = new Array<number>(windowCount);
  path[windowCount - 1] = bestLabel;
  for (let t = windowCount - 1; t > 0; t--) {
    path[t - 1] = backPointers[t][path[t]];
  }
  return path;
}

interface WindowEvidence {
  scores: number[];
  bestLabel: number;
  /** Mode-agnostic margin: (top1 - top2) / (|top1| + |top2|) in score space. */
  margin: number;
  /** rank[label] = position of label in descending score order (0 = best). */
  rank: number[];
}

function computeEvidence(scoresList: number[][], needRank: boolean): WindowEvidence[] {
  return scoresList.map((scores) => {
    let top1 = -Infinity;
    let top2 = -Infinity;
    let bestLabel = 0;
    for (let labelIndex = 0; labelIndex < scores.length; labelIndex++) {
      const value = scores[labelIndex];
      if (value > top1) {
        top2 = top1;
        top1 = value;
        bestLabel = labelIndex;
      } else if (value > top2) {
        top2 = value;
      }
    }
    const scale = Math.abs(top1) + Math.abs(top2);
    const margin = scale > 1e-9 ? (top1 - top2) / scale : 0;

    // `rank` is read only when `fillTopK >= 0`; the default disables it.
    // Building it costs a sort per window — ~11M discarded allocations per
    // leave-one-out run. See PERFORMANCE_TUNING.md item 7.
    const rank = new Array<number>(scores.length).fill(0);
    if (needRank) {
      scores
        .map((score, labelIndex) => ({ score, labelIndex }))
        .sort((a, b) => b.score - a.score)
        .forEach((entry, position) => { rank[entry.labelIndex] = position; });
    }

    return { scores, bestLabel, margin, rank };
  });
}

/**
 * Two-pass "anchor and link" decoder.
 *
 * Pass 1 finds recognizable anchor runs: consecutive windows whose top label
 * beats the runner-up by a wide margin. These are the easy-to-recognize
 * phrases of a song. Pass 2 links those anchors by extending each run across
 * intervening windows whose evidence is weak or ambiguous: the generic
 * vamping, left-hand-only, or warm-up passages between recognizable moments.
 * Extension stops at a strong anchor of a different song (a real transition)
 * or a strong `__none__` anchor (genuine silence).
 */
function anchorLinkDecode(
  evidence: WindowEvidence[],
  config: TrainConfig,
  noneLabelIndex: number,
  /** Per-window: may this window be linked into a neighbouring anchor run? */
  linkable: boolean[]
): { labels: number[]; confidence: number[] } {
  const n = evidence.length;
  const labels = new Array<number>(n).fill(-1);
  const confidence = new Array<number>(n).fill(0);

  const anchorMargin = config.anchorMargin ?? 0.15;
  const minAnchorRun = Math.max(1, config.minAnchorRun ?? 3);
  const fillMinMargin = config.fillMinMargin ?? 0;
  const fillTopK = config.fillTopK ?? -1;
  const linkConfidence = clamp(config.linkConfidence ?? 0.5, 0, 1);
  const anchors: Array<{ start: number; end: number; label: number; fillConf: number }> = [];

  const isAnchor = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    const e = evidence[i];
    if (e.bestLabel !== noneLabelIndex && e.margin >= anchorMargin) {
      isAnchor[i] = true;
    }
  }

  const canLink = (i: number, label: number): boolean => {
    // Dead air is not ambiguous evidence that the song continues.
    if (!linkable[i]) return false;
    const e = evidence[i];
    if (e.bestLabel === label) return true;
    if (e.margin >= anchorMargin) return false;
    if (e.margin < fillMinMargin) return false;
    if (fillTopK >= 0 && e.rank[label] >= fillTopK) return false;
    return true;
  };
  const canFill = (i: number, label: number) => labels[i] === -1 && canLink(i, label);

  // Pass 1: seed runs of consecutive same-label anchors. Linked windows get
  // the run margin, or `linkConfidence` if the margin is lower.
  for (let i = 0; i < n; ) {
    if (!isAnchor[i]) {
      i++;
      continue;
    }
    const label = evidence[i].bestLabel;
    let j = i;
    let marginSum = 0;
    while (j < n && isAnchor[j] && evidence[j].bestLabel === label) {
      marginSum += evidence[j].margin;
      j++;
    }
    if (j - i >= minAnchorRun) {
      const runMargin = marginSum / (j - i);
      const fillConf = Math.max(linkConfidence, runMargin * 0.85);
      anchors.push({ start: i, end: j, label, fillConf });
      for (let k = i; k < j; k++) {
        labels[k] = label;
        confidence[k] = evidence[k].margin;
      }
      if (config.linkPolicy !== 'bridge') {
        // Extend this run to the right.
        for (let k = j; k < n; k++) {
          if (labels[k] !== -1) break;
          if (!canFill(k, label)) break;
          labels[k] = label;
          confidence[k] = fillConf;
        }
        // Extend this run to the left.
        for (let k = i - 1; k >= 0; k--) {
          if (labels[k] !== -1) break;
          if (!canFill(k, label)) break;
          labels[k] = label;
          confidence[k] = fillConf;
        }
      }
    }
    i = j;
  }

  // Legacy linking treats "the evidence here is ambiguous" as "the song that
  // was playing is still playing", and nothing bounds that on the right. After
  // a take actually stops, the following warm-up and noodling is ambiguous but
  // not silent, so the finished song keeps claiming it until the next song
  // produces an anchor. Bridge linking splits the two cases the single
  // `canFill` rule conflates:
  //
  //   * an ambiguous span *between two anchor runs of the same song* is a
  //     passage inside a take. Both ends vouch for it, so link all of it.
  //   * an ambiguous span past a song's outermost anchor is unvouched. Nothing
  //     ahead confirms the song is still playing, so advance only while the
  //     model itself still ranks that song first.
  if (config.linkPolicy === 'bridge') {
    // These two fallbacks must match `resolveTrainConfig`; a model trained with
    // this policy carries both explicitly, so they only apply to a config that
    // was never resolved.
    const tailLimit = Math.floor((config.linkTailSec ?? 2) / Math.max(1e-9, config.stepSec));
    /**
     * The leash arbitrates contention between two songs. Beyond a song's
     * outermost anchor in a recording there is no other song to arbitrate
     * against, so silence stays the only stop, as it was before.
     */
    const contested = (a: number, side: 1 | -1): boolean => {
      for (let b = a + side; b >= 0 && b < anchors.length; b += side) {
        if (anchors[b].label !== anchors[a].label) return true;
      }
      return false;
    };

    const claim = (k: number, run: { label: number; fillConf: number }, limit = Infinity, distance = 0): boolean => {
      if (k < 0 || k >= n || labels[k] !== -1 || !canLink(k, run.label)) return false;
      // Past the leash the song must still be the model's own first choice.
      if (distance > limit && evidence[k].bestLabel !== run.label) return false;
      labels[k] = run.label;
      confidence[k] = run.fillConf;
      return true;
    };

    // Vouched: another anchor run of the same song closes this side, so the
    // span is a passage inside a take and links with no leash, exactly as
    // before. Extending from both ends rather than requiring the whole span to
    // be fillable keeps the legacy reach when something blocks the middle.
    for (let a = 0; a < anchors.length; a++) {
      const run = anchors[a];
      if (anchors[a + 1]?.label === run.label) {
        for (let k = run.end; claim(k, run); k++);
      }
      if (anchors[a - 1]?.label === run.label) {
        for (let k = run.start - 1; claim(k, run); k--);
      }
    }

    // Unvouched tails advance in lockstep. Two songs reaching for the same
    // window meet in the middle instead of the earlier one taking all of it,
    // which is the directional bias that made a finished song run long.
    const rightAlive = anchors.map((run, a) => anchors[a + 1]?.label !== run.label);
    const leftAlive = anchors.map((run, a) => anchors[a - 1]?.label !== run.label);
    const rightLimit = anchors.map((_, a) => (contested(a, 1) ? tailLimit : Infinity));
    const leftLimit = anchors.map((_, a) => (contested(a, -1) ? tailLimit : Infinity));
    for (let d = 1; ; d++) {
      let advanced = false;
      for (let a = 0; a < anchors.length; a++) {
        if (rightAlive[a]) {
          rightAlive[a] = claim(anchors[a].end + d - 1, anchors[a], rightLimit[a], d);
          advanced = advanced || rightAlive[a];
        }
        if (leftAlive[a]) {
          leftAlive[a] = claim(anchors[a].start - d, anchors[a], leftLimit[a], d);
          advanced = advanced || leftAlive[a];
        }
      }
      if (!advanced) break;
    }
  }

  // Legacy extension gives the earlier song first claim on every ambiguous
  // window. Compete only inside an uninterrupted, mutually linkable gap between
  // two established different-song anchors. Preserve silence, strong third-song
  // evidence, same-song links, and open recording edges.
  if (config.anchorGapPolicy && config.anchorGapPolicy !== 'legacy') {
    for (let a = 1; a < anchors.length; a++) {
      const left = anchors[a - 1];
      const right = anchors[a];
      if (left.label === right.label || left.end >= right.start) continue;
      let eligible = true;
      for (let i = left.end; i < right.start; i++) {
        if (!canLink(i, left.label) || !canLink(i, right.label)) {
          eligible = false;
          break;
        }
      }
      if (!eligible) continue;
      const midpoint = (left.end + right.start) / 2;
      let split = Math.round(midpoint);
      if (config.anchorGapPolicy === 'evidence') {
        // Maximize evidence for a single A -> B change. Moving the cut right
        // changes the objective by score(A) - score(B) at that window.
        let cumulative = 0;
        let best = 0;
        split = left.end;
        for (let i = left.end; i < right.start; i++) {
          cumulative += evidence[i].scores[left.label] - evidence[i].scores[right.label];
          if (cumulative > best || (cumulative === best
            && Math.abs(i + 1 - midpoint) < Math.abs(split - midpoint))) {
            best = cumulative;
            split = i + 1;
          }
        }
      }
      for (let i = left.end; i < right.start; i++) {
        const owner = i < split ? left : right;
        labels[i] = owner.label;
        confidence[i] = owner.fillConf;
      }
    }
  }

  // Per-window evidence cannot tell a passage the model half-recognizes from
  // the dead air after a take: in both, no song wins the window. Averaged over a
  // whole span it can. A song sits a median rank of 1.3 across spans inside its
  // own take and 16 across spans outside it, so a span-level mean recovers the
  // long takes that a leash truncates without reopening the gap between takes.
  const rescueRank = config.linkRescueRank ?? (config.linkPolicy === 'bridge' ? 5 : -1);
  if (rescueRank >= 0) {
    const rescueConfidence = clamp(config.linkConfidence ?? 0.5, 0, 1);
    // A lookahead of 0 tests the whole span at once, which is the original rule.
    const lookahead = Math.max(0, config.linkRescueLookaheadSec ?? 0);
    const reach = lookahead > 0
      ? Math.max(1, Math.round(lookahead / Math.max(1e-9, config.stepSec)))
      : 0;
    const meanRank = (from: number, to: number, label: number): number => {
      let sum = 0;
      for (let i = from; i < to; i++) {
        const scores = evidence[i].scores;
        const value = scores[label];
        for (let c = 0; c < scores.length; c++) if (scores[c] > value) sum++;
      }
      return sum / (to - from);
    };
    for (let i = 0; i < n; ) {
      if (labels[i] !== -1 || !linkable[i]) {
        i++;
        continue;
      }
      // Silence still splits a span rather than being claimed with it.
      let j = i;
      while (j < n && labels[j] === -1 && linkable[j]) j++;
      const left = i > 0 ? labels[i - 1] : -1;
      const right = j < n ? labels[j] : -1;
      let best = -1;
      let bestRank = rescueRank;
      // The rescue exists to undo the leash, and the leash only ever applies to
      // a song's outer edge. The same song on both sides was never leashed — it
      // was vouched, and something stopped the fill — so this is the break
      // between two takes of one song, not a passage inside one. Absorbing it
      // would merge the takes, which is already the largest error left.
      const betweenTakesOfOneSong = left >= 0 && left === right && left !== noneLabelIndex;
      const claimable = (label: number) => label >= 0 && label !== noneLabelIndex
        && !betweenTakesOfOneSong;

      if (reach > 0) {
        // Creep inwards from each end while that side's own lookahead holds.
        // Where both sides qualify they meet in the middle, and where neither
        // does the span stays unlabelled — the same arbitration the leash uses.
        let lo = i;
        let hi = j;
        let leftAlive = claimable(left);
        let rightAlive = claimable(right);
        while (hi > lo && (leftAlive || rightAlive)) {
          if (leftAlive) {
            leftAlive = meanRank(lo, Math.min(lo + reach, hi), left) <= rescueRank;
            if (leftAlive) {
              labels[lo] = left;
              confidence[lo] = rescueConfidence;
              lo++;
            }
          }
          if (rightAlive && hi > lo) {
            rightAlive = meanRank(Math.max(hi - reach, lo), hi, right) <= rescueRank;
            if (rightAlive) {
              labels[hi - 1] = right;
              confidence[hi - 1] = rescueConfidence;
              hi--;
            }
          }
        }
        i = j;
        continue;
      }

      for (const neighbour of [left, right]) {
        if (!claimable(neighbour) || neighbour === best) continue;
        const rank = meanRank(i, j, neighbour);
        if (rank <= bestRank) {
          bestRank = rank;
          best = neighbour;
        }
      }
      if (best >= 0) {
        for (let k = i; k < j; k++) {
          labels[k] = best;
          confidence[k] = rescueConfidence;
        }
      }
      i = j;
    }
  }

  for (let i = 0; i < n; i++) {
    if (labels[i] === -1) labels[i] = noneLabelIndex;
  }

  return { labels, confidence };
}


export function decodeWindowScores(
  model: Pick<SongSegmentModel, 'config' | 'labels'>,
  windows: Pick<WindowSample, 'startTime' | 'endTime' | 'features'>[],
  scoresList: number[][],
  options: Pick<PredictConfig, 'minWindowConfidence' | 'smoothingWindows'>
): WindowPrediction[] {
  const windowCount = windows.length;
  if (scoresList.length !== windowCount || scoresList.some((row) => row.length !== model.labels.length)) {
    throw new Error('Score matrix dimensions do not match the model labels and windows.');
  }
  if (windowCount === 0) return [];

  const decoder = model.config.decoder ?? 'anchor';
  const temperature = model.config.temperature ?? 1;

  if (decoder === 'anchor') {
    const noneLabelIndex = model.labels.indexOf(NO_SONG_LABEL);
    const evidence = computeEvidence(scoresList, (model.config.fillTopK ?? -1) >= 0);
    // A model saved before this rule existed has no value here, and a change
    // to a default must not change an existing model (see v2.3 in the
    // changelog), so an absent value means "off" rather than the new default.
    const maxLinkSilence = model.config.linkMaxSilenceRatio ?? Number.POSITIVE_INFINITY;
    const linkable = windows.map(
      (window) => window.features[SILENCE_RATIO_INDEX] < maxLinkSilence
    );
    const { labels, confidence } = anchorLinkDecode(
      evidence, model.config, noneLabelIndex, linkable
    );
    const predictions: WindowPrediction[] = [];
    for (let i = 0; i < windowCount; i++) {
      predictions.push({
        startTime: windows[i].startTime,
        endTime: windows[i].endTime,
        label: model.labels[labels[i]],
        confidence: confidence[i]
      });
    }
    return predictions;
  }

  const changePenalty = model.config.viterbiChangePenalty ?? 1;
  const emissions = scoresList.map((scores) => scoresToLogProbs(scores, temperature));

  let finalLabels: number[];
  let finalConfidence: number[];
  if (decoder === 'viterbi') {
    const path = decodeViterbi(emissions, changePenalty);
    finalLabels = path;
    finalConfidence = path.map((labelIndex, i) => Math.exp(emissions[i][labelIndex]));
  } else {
    finalLabels = emissions.map((emission) => {
      let best = 0;
      for (let labelIndex = 1; labelIndex < emission.length; labelIndex++) {
        if (emission[labelIndex] > emission[best]) best = labelIndex;
      }
      return best;
    });
    finalConfidence = finalLabels.map((labelIndex, i) => Math.exp(emissions[i][labelIndex]));
  }

  const predictions: WindowPrediction[] = [];
  for (let i = 0; i < windowCount; i++) {
    let label = model.labels[finalLabels[i]];
    if (finalConfidence[i] < options.minWindowConfidence) {
      label = NO_SONG_LABEL;
    }
    predictions.push({
      startTime: windows[i].startTime,
      endTime: windows[i].endTime,
      label,
      confidence: finalConfidence[i]
    });
  }

  if (decoder === 'viterbi') {
    return predictions;
  }
  return smoothWindowPredictions(predictions, options.smoothingWindows);
}

export function smoothWindowPredictions(
  windows: WindowPrediction[],
  smoothingWindows: number
): WindowPrediction[] {
  if (smoothingWindows <= 1 || windows.length <= 1) {
    return [...windows];
  }

  const radius = Math.floor(smoothingWindows / 2);
  const smoothed: WindowPrediction[] = [];

  for (let i = 0; i < windows.length; i++) {
    const start = Math.max(0, i - radius);
    const end = Math.min(windows.length - 1, i + radius);
    const voteScores = new Map<string, number>();
    let totalScore = 0;

    for (let j = start; j <= end; j++) {
      const label = windows[j].label;
      const score = windows[j].confidence;
      voteScores.set(label, (voteScores.get(label) || 0) + score);
      totalScore += score;
    }

    let bestLabel = windows[i].label;
    let bestScore = -1;
    for (const [label, score] of voteScores.entries()) {
      if (score > bestScore) {
        bestLabel = label;
        bestScore = score;
      }
    }

    smoothed.push({
      startTime: windows[i].startTime,
      endTime: windows[i].endTime,
      label: bestLabel,
      confidence: totalScore > 0 ? bestScore / totalScore : windows[i].confidence
    });
  }

  return smoothed;
}


function inferStepSec(windows: WindowPrediction[]): number {
  for (let i = 1; i < windows.length; i++) {
    const delta = windows[i].startTime - windows[i - 1].startTime;
    if (delta > 1e-9) return delta;
  }
  return Math.max(1e-9, windows[0].endTime - windows[0].startTime);
}

export function windowsToSegments(
  windows: WindowPrediction[],
  options: Pick<PredictConfig, 'minSegmentSec' | 'minSegmentConfidence' | 'mergeGapSec'>,
  notes?: NoteEvent[] | BoundaryNote[]
): SongSegment[] {
  const provisional: SongSegment[] = [];
  if (windows.length === 0) return provisional;

  // A window label describes the song at the window centre. Training uses the
  // same rule: `buildSamplesForFile` labels each window at
  // `startTime + windowSec / 2`.
  //
  // The full window extent is therefore the wrong span. It made each segment
  // half a window too long at each end, and made adjacent segments overlap by
  // `windowSec - stepSec` (3s at the 4s/1s default). These segments go into
  // `prediction_reviews` and then into annotations. Centres give the correct
  // span.
  const lastIndex = windows.length - 1;
  const stepSec = inferStepSec(windows);
  const centreOf = (i: number) => (windows[i].startTime + windows[i].endTime) / 2;
  // The first run starts at the start of the audio. The last run continues
  // to the end. Other runs continue to the centre of the next window.
  const boundStart = (i: number) => (i === 0 ? windows[0].startTime : centreOf(i));
  const boundEnd = (i: number) => (
    i === lastIndex
      ? windows[i].endTime
      : Math.min(centreOf(i) + stepSec, windows[i].endTime)
  );

  let runStartIndex = 0;
  const flush = (endIndex: number) => {
    const label = windows[runStartIndex].label;
    if (!label || label === NO_SONG_LABEL) return;

    let confidenceSum = 0;
    for (let i = runStartIndex; i <= endIndex; i++) confidenceSum += windows[i].confidence;

    const startTime = boundStart(runStartIndex);
    const endTime = boundEnd(endIndex);
    if (endTime <= startTime) return;

    provisional.push({
      songName: label,
      startTime,
      endTime,
      durationSec: endTime - startTime,
      confidence: confidenceSum / (endIndex - runStartIndex + 1)
    });
  };

  for (let i = 1; i <= lastIndex; i++) {
    if (windows[i].label === windows[runStartIndex].label) continue;
    flush(i - 1);
    runStartIndex = i;
  }
  flush(lastIndex);

  const filtered = provisional.filter(
    (segment) =>
      segment.durationSec >= options.minSegmentSec
      && segment.confidence >= options.minSegmentConfidence
  );
  const merged: SongSegment[] = [];
  for (const segment of filtered) {
    const last = merged[merged.length - 1];
    if (
      last
      && last.songName === segment.songName
      && segment.startTime - last.endTime <= options.mergeGapSec
    ) {
      const combinedDuration = (last.endTime - last.startTime) + (segment.endTime - segment.startTime);
      const weightedConfidence = (
        (last.confidence * (last.endTime - last.startTime))
        + (segment.confidence * (segment.endTime - segment.startTime))
      ) / Math.max(1e-9, combinedDuration);

      last.endTime = segment.endTime;
      last.durationSec = last.endTime - last.startTime;
      last.confidence = weightedConfidence;
    } else {
      merged.push({ ...segment });
    }
  }

  // Refine boundaries against physical note onsets and acoustic releases,
  // trimming extraneous ending flourishes (arpeggios) if notes are provided.
  let candidates = merged;
  if (notes && notes.length > 0) {
    candidates = candidates
      .map((segment) => {
        const snapped = snapSegmentBoundaries(segment.startTime, segment.endTime, notes, {
          trimFlourish: true
        });
        const startTime = roundTo(snapped.startTime);
        const endTime = roundTo(snapped.endTime);
        const durationSec = roundTo(endTime - startTime);
        return {
          ...segment,
          startTime,
          endTime,
          durationSec
        };
      })
      .filter((segment) => segment.durationSec >= options.minSegmentSec);
  }

  return candidates
    .map((segment) => ({
      ...segment,
      startTime: roundTo(segment.startTime),
      endTime: roundTo(segment.endTime),
      durationSec: roundTo(segment.durationSec),
      confidence: roundTo(segment.confidence)
    }));
}
