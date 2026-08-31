# Model Changelog

Track changes to the prediction model (`ml/songSegmentation.ts`, the
`data/ml/model.json` it produces, and the CLI/API that drive it). Newest
entries go on top. For each change, record *what* changed, *why*, and how it
moved the evaluation numbers so we can judge whether a change helped.

How to read the numbers:
- **Insample** — predictions on the same files the model was trained on
  (optimistic; useful for catching regressions in the pipeline).
- **LOO** — leave-one-file-out (honest generalization to files the model has
  not seen). This is the number to watch.
- **Segment F1** — overlap between predicted segments and annotations
  (recall = annotated time covered by a same-song segment; precision =
  predicted time that overlaps a same-song annotation). This is the closest
  single number to "predictions vs annotations".
- See `ml/eval.ts` for how these are computed.

---

## 2026-08-31 — v2: prototype model + anchor-and-link decoding

### Context

The v1 model (classic k-NN over ~73k retained training windows) had three
problems in practice:

1. **Memorization, not prediction.** Per-window k-NN on training files scored
   ~98% F1 purely because each window's own copy sat at distance 0 in the
   training set. On unseen files generalization was poor.
2. **Fragmentation and hallucination.** Stored review queues showed songs
   split into many tiny segments and wrong songs proposed in noodling tails.
3. **Heavy.** Every prediction recomputed distances against all 73k vectors
   (eval took 13+ minutes), and the model file was 36 MB.

### What changed

- **Condensed prototype representation.** Instead of retaining every training
  window, each label keeps a small set of prototype vectors (budget scales
  with √support so rare songs are not drowned out; `__none__` gets a hard
  cap). 73,164 windows → 1,129 prototypes. Model file 36 MB → ~0.7 MB, eval
  runs in seconds.
- **Richer features (18 → 25).** Added `velocity_std`, `duration_std`,
  `polyphony_std`, `silence_ratio`, `pitch_span`, `tempo_bpm` (median
  inter-onset tempo), `regularity` (peak onset autocorrelation).
- **minmax feature scaling** instead of z-score (z-score's tiny stds were
  distorting distances).
- **`min` score mode:** each window is scored by its nearest prototype per
  label, so prototype counts do not bias the vote.
- **Anchor-and-link decoder** (replaces per-window smoothing). Pass 1 finds
  *anchor runs* — consecutive windows whose top song beats the runner-up by a
  margin ≥ 0.15. Pass 2 links anchors of the same song across the intervening
  low-confidence (vamping / left-hand-only) windows, stopping at a strong
  anchor of a different song or at genuine silence. This yields contiguous
  song spans instead of fragmented runs.
- **Confidence rescale.** Confidence is now margin-based (anchor strength);
  the `minSegmentConfidence` default dropped 0.65 → 0.3 to match.
- **Tooling:** `ml:eval` now reports segment-level recall/precision/F1 vs
  annotations; `ml:train` gained the new knobs; added
  `ml/songSegmentation.test.ts`.

### Results

| Metric (LOO, unseen files) | v1 baseline | v2 |
|---|---|---|
| Annotated-window accuracy | 37% (Feb eval, 21 files) / 51% (8-file subset) | **52.6%** (44 files) / **57.7%** (8-file subset) |
| Segment recall / precision / F1 | n/a (not measured) | 54.3% / 45.0% / **49.2%** |

Insample: window accuracy 84.9% (annotated windows), segment recall /
precision / F1 = 87.1% / 57.9% / 69.5%.

Concrete: file 82 (Etude No 2 + Waltz in A) now predicts exactly those two
songs with contiguous spans; file 5 (Take Five + Into the Unknown) matches;
`ml:predict-import` fills annotation gaps with the correct song instead of the
wrong ones v1 proposed.

### Known limitations / next candidates

- LOO precision is still ~45%: on unseen files, roughly half of predicted
  song-time is wrong. The 4s window features do not separate these songs
  strongly, so human review remains necessary.
- **JMX bookmarks (TODO):** the Jamcorder JMX trailer may carry bookmark
  events at song/session boundaries. `server/utils/jmxParser.ts` currently
  parses `jmxAsset` / `jmxStoneHdr` / `jmxEof` but not bookmarks. Worth
  investigating as a boundary hint (caveats: a bookmark can split the same
  song if the player stepped away, and rapid song changes may have no
  bookmark).
- Window-level features are noisy; aggregating features over longer spans
  (e.g. a second-level "song template" classifier) is the most promising
  direction for the next LOO precision jump.

---

## Before v2 — v1 model (historical reference)

The prior model (`knn-song-segmenter`, model version 1) that shipped before
the 2026-08-31 change:

- Classic k-NN (k=7) over every training window; the full set of standardized
  windows was embedded in `data/ml/model.json` (~36 MB).
- 18 features: 12 pitch-class durations + onset density, mean pitch, pitch
  std, mean velocity, mean duration, mean polyphony, z-scored.
- Per-window label by inverse-distance k-NN vote; confidence = best vote
  share; `minWindowConfidence=0.45`, `minSegmentConfidence=0.65`.
- Post-processing: majority smoothing over 5 windows, then contiguous-run
  segmentation with length/confidence filters and gap merging.
- Documented LOO window accuracy on annotated windows: ~37% (Feb 2026 eval,
  21 files). Failure modes: false negatives (annotated song windows predicted
  as `__none__`), fragmented segments, and wrong-song predictions in
  unannotated tails.