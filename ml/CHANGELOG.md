# Model Changelog

Track changes to the prediction model (`ml/songSegmentation.ts`, the
`ml/model.json` it writes into the library, and the CLI/API that drive it).
Newest entries go on top. Each entry records *what* changed, *why*, and how it
moved the evaluation numbers, including ideas that failed, so they are not
retried. Recent entries open with **In plain terms**; the rest is written for
someone changing the model.

A status at the end of a heading says what became of the change:
**accepted** (shipped as a default), **experimental** (behind a setting, off by
default), or **rejected** / **not shipped** (measured, then removed or left
off).

How to read the numbers:
- **LOO** — leave-one-file-out: each recording is predicted by a model trained
  on all the others, so the model has never seen it. This is the honest number.
- **Insample** — predictions on the same files the model was trained on
  (optimistic; useful only for catching regressions in the pipeline).
- **Complete files** — recordings the player has marked complete. Compare
  models on these only: in an unfinished recording, a correct prediction on
  time not yet labeled counts as wrong, so an all-files number tracks how much
  has been annotated rather than how good the model is (see v2.10).
- **Segment F1** — overlap between predicted segments and annotations
  (recall = annotated time covered by a same-song segment; precision =
  predicted time that overlaps a same-song annotation; F1 combines the two).
  This is the closest single number to "predictions vs annotations".
- **Matched takes** — annotations paired one-to-one with a same-song
  prediction that overlaps at least half their combined time. F1 can rise
  while this falls, when one prediction swallows two takes.
- **Points** — percentage points: 93.10% to 93.15% is +0.05 points.
- **95% interval** — from a paired bootstrap over files: the recordings are
  resampled thousands of times and the difference between two runs
  recomputed. An interval that excludes zero means the change is unlikely to
  be chance.
- See `ml/eval.ts` for how these are computed.

---

## 2026-09-23 — v2.13: drop a short misread run in the middle of a take (accepted)

### In plain terms

Sometimes the model hears a few seconds of one piece as another. On June 17,
2026, a Maple Leaf Rag session came back with seven 9–15 second Bridge Over
Troubled Water segments, each sitting between two Maple Leaf Rag segments. The
8-second minimum segment length can't catch these without also discarding real
short takes: 59 of 1,430 annotations are under 15 seconds.

v2.13 recognizes the shape instead. A run of one song lasting 30 seconds or
less, with the same other song directly on both sides, is left unlabeled.
Across the library that removes 25 segments, and none of them was correct:

- 16 overlapped an annotation of a different song.
- 4 sat in a gap of a recording marked complete, where the player has declared
  there is no song.
- 4 were June 17 segments on time not yet annotated, all of which the player
  had already reviewed as invalid.
- 1 sits in an unreviewed stretch of an unfinished recording.

Nothing correct is lost: every take the model found before is still found,
with the same start and end. The overall score barely moves, because the
fragments are short; the figures are under Measurements.

### What changed

- `TrainConfig.dropFlankedRunSec`, a decode-only setting.
  `resolveTrainConfig` fills it with 30, so a model built from v2.13 records it.
  The decoder reads an absent value as 0, so a saved model decodes as it was
  built until it is rebuilt.
- `ml:train --drop-flanked-run-sec`, `ml:eval --drop-flanked-run-sec` (applied
  over the saved model without retraining), and `dropFlankedRunSec` on
  `POST /api/prediction-reviews/rebuild-model` and in prediction decoder
  overrides.
- `MODEL_VERSION` bumped to `v2.13`.

### Why dropped, not absorbed

The obvious rule gives the misread run to the song on either side. That was
tried first. Its F1 was higher (+0.053 at 10s, +0.091 at 30s, both intervals
clear of zero), but it lost 13–19 matched annotations and gained 1. Reading the
lost files one by one explains it: the misread run usually sits where a take
restarts, and it is often the model's only sign of that restart.

- Jmx-A00492 (Aug 22): Beethoven's 5th at 2008–2017s fills exactly the gap
  between two Bridge Over Troubled Water takes (2007.5s → 2018.4s).
- Jmx-A00444 (Jun 11): The Entertainer at 1753–1762s fills exactly the gap
  between two Whiter Shade of Pale takes (1752.8s → 1762.1s).
- Jmx-A00452 (Jun 20), Jmx-A00084, Jmx-A00439 and Jmx-A00048: the run is
  within a few seconds of a restart. Absorbing it joined the two takes.
- The June 17 file itself: the first misread run (870–883s) straddles the
  player's own take break at 878.6s/882.9s.

Absorbing merges two takes of one song, the error class that segment-overlap
F1 barely penalizes and that matters most for practice sessions. Dropping the
run removes the wrong song and keeps the split.

### Measurements

Leave-one-file-out, complete files only, frozen dataset
`71ca3e73e8e1bd9eff8a008d8ddc4b023125d07daf6989fb61f512bb5bd47bba`, paired
file bootstrap (3,000 resamples, seed 42) against the rule off:

| Variant | Recall | Precision | F1 | Δ F1, 95% interval | Matched lost / gained |
|---|---|---|---|---|---|
| off (v2.12) | 92.08% | 94.14% | 93.099% | — | — |
| absorb ≤ 10s | 92.16% | 94.17% | 93.152% | +0.053 [+0.029, +0.080] | 13 / 1 |
| absorb ≤ 30s | 92.20% | 94.21% | 93.190% | +0.091 [+0.046, +0.142] | 19 / 1 |
| drop ≤ 10s | 92.08% | 94.18% | 93.121% | +0.022 [+0.009, +0.036] | 0 / 0 |
| drop ≤ 20s | 92.08% | 94.21% | 93.136% | +0.037 [+0.019, +0.056] | 0 / 0 |
| **drop ≤ 30s** | 92.08% | 94.24% | 93.147% | +0.048 [+0.026, +0.073] | 0 / 0 |

The shipped rule, drop ≤ 30s, gains only in precision (94.14% → 94.24%).
Recall, all 758 matched annotations, and every matched boundary are unchanged.

Wrong-song time on complete files falls from 11,747s to 11,539s, and their
segment count from 974 to 958.

### Why 30 seconds

The longest misread run seen was 26.1s (Pathetique inside Maple Leaf Rag).
The shortest real song annotated between two takes of another is 34s
(Christmas Is Coming inside Winter Wonderland), and it has a pause on both
sides, which strict adjacency already protects. Raising the limit to 45, 60 or
90 seconds drops only one or two more runs, still none of them correct, but
leaves less margin under that 34s take.

## 2026-09-22 — melody: not shipped, as a feature or as a second check

### The question

The model describes each six-second window by *which* notes sound and how
(pitch classes, loudness, density, silence), never by the *order* they come in.
Songs in the same key with similar harmony differ mostly in their melody, and
several of the model's worst confusions look like that: Silent Night and Silver
Bells, Rudolph and Frosty, Waltz in A and Take Five. The idea came from a user:
find the melody line and give the model a feature for it.

### Finding the melody

The melody is taken to be the top line. Each time keys are struck, the highest
of them is a melody note, as long as no higher key is still held down. So a
chord counts once, and notes played under a sustained melody note are left out.
One correction was needed: when the right hand lifts early, a bass note can
briefly become the highest note. A note more than a major sixth below the last
melody note, within a second of it, is therefore treated as accompaniment.
After a pause of a second or more, the line may start anywhere, so a left-hand
passage on its own still counts. This keeps 31% of all notes. On Silent Night it
recovers the opening sol–la–sol–mi.

"The fastest-moving line" was considered and set aside. In this repertoire the
fastest line is often the accompaniment: ragtime stride bass, Alberti figures,
arpeggios, and practice drills.

### Describing it

An exact fingerprint of the note sequence breaks on a single wrong or missing
note, depends on where a window happens to start, and changes with tempo. So
the melody was summarized as counts, which survive all three and also ignore
the key:

- **Melody pitch profile:** how often each pitch class appears in the top line
  (12 numbers). Unlike the others, it depends on the key.
- **Interval profile:** how often each step or leap occurs, from an octave down
  to an octave up (17 numbers).
- **Motif pairs:** how often each pair of consecutive moves occurs, such as
  "small step up, then leap down" (49 numbers).

The model compares windows by distance, with every number counting equally, so
each melody block was scaled to count as a fixed number of features rather than
one per number. Otherwise a 49-number block would outweigh the existing 37.

### Inside the window model: no reliable gain

Leave-one-file-out on the September 21 library (dataset `460c80302e4a…`) with
v2.12 settings. The baseline run reproduced `ml:eval` exactly: 92.87% F1 and 652
matched takes. Ten variants were tried; the most informative:

| Variant | F1 change | 95% interval | Matched takes |
| --- | ---: | --- | ---: |
| Motif pairs | 0.00 | [−0.54, +0.50] | 645 |
| Intervals + motif pairs | −0.24 | [−1.42, +0.76] | 642 |
| Intervals + motif pairs, 12-second view | +0.21 | [−0.61, +1.06] | 621 |
| Melody pitch profile, light weight | +0.36 | [−0.06, +0.80] | 656 |

None clears zero. The best is the melody pitch profile, which carries no order
at all. After ten tries, a variant that happened to scrape past zero would not
be trustworthy either.

The per-song results explain the flat total. The melody features do fix the
confusions they were aimed at: Silent Night gains up to 16 F1 points, O
Christmas Tree up to 13 and Silver Bells up to 7. But they create new ones: Away
in a Manger loses up to 18 and Ashokan Farewell up to 27. Across the 58 songs
with enough annotation, 11–17 improve by more than 2 points and 5–13 get worse,
depending on the variant, and the total barely moves. Letting the melody block see
12 seconds instead of 6 helped identity, but cost about 30 matched takes,
because near a song change the wider view picks up the next song's melody.

The underlying problem is that a six-second window holds only about nine
melody notes, too few for a fingerprint to be reliable.

### Over a whole take: a strong signal

A whole take holds hundreds of melody notes. To see whether the fingerprint
works at that scale, each annotated take (1,186 takes of 64 songs) was matched
to the song whose average fingerprint it most resembles. The averages were
built only from takes in other recordings. No model was trained for this; it
is a deliberately simple test.

| Fingerprint of the whole take | Right song first | Among top three | Confusable songs, first |
| --- | ---: | ---: | ---: |
| Pitch content (what the model uses now) | 79.7% | 90.0% | 80.6% |
| Intervals + motif pairs | 86.2% | 91.0% | 89.1% |
| **Both together** | **92.7%** | **95.8%** | **93.3%** |

Over a whole take, the melody identifies the song better than pitch content
does, and the two together are much better than either. Melody adds
information the model does not have.

### Follow-up: checking each proposed segment's melody

That suggested a second stage instead of a feature: let the model propose its
segments as usual, then compare each segment's melody fingerprint with each
song's. The take-level test above used annotated boundaries. Real proposals are
messier, sometimes two takes merged or one take cut short, so the second stage
was measured on the model's own proposals, again leaving one recording out.
Each song's fingerprint was built only from takes in other recordings.

Two rules were tested:

- **Reject:** drop a proposed segment whose melody matches its own song poorly.
- **Relabel:** switch a segment to another song, but only one the model
  already ranked among its top three candidates for that stretch, and only when
  the melody clearly prefers it.

Thresholds were set from where correct and wrong segments separate, not by
tuning to F1. Correctly labeled segments match their song's fingerprint with a
typical similarity of 0.98, and, outside the left-hand passages described
below, none scores below 0.60. So the rejection cutoff
is 0.60: below it, the check drops 12 wrong segments, about 10 minutes of wrong
predictions, and no correct ones. Recordings made before July 18, 2026 alone
give the same cutoff. The relabel rule requires the other song to beat the
current label by at least 0.10. For 99% of correct segments, no other candidate
beats their label by more than 0.06.

| Rule | F1 change | 95% interval |
| --- | ---: | --- |
| **Reject poor melody matches** | **+0.15** | **[+0.01, +0.34]** |
| Relabel among the top three candidates | +0.09 | [−0.23, +0.41] |
| Both | +0.24 | [−0.12, +0.61] |
| Ceiling: a perfect check of every proposed segment | +1.70 | [+0.94, +2.70] |

Rejection is safe and clears zero, but the gain is small. On the newest quarter
of recordings (from July 18, 2026) it changes a single file, because the model
makes fewer of these mistakes on recent recordings.

The check captures little of the ceiling for two reasons:

- **Few proposals are wrong to begin with.** Of 817 checkable segments on
  complete recordings, 32 name the wrong song and 32 cover playing that is not
  a song.
- **Relabeling can reach only some of them.** The right song is among the
  model's top three candidates for just 12 of the 32 wrong-song segments.
  Widening the list breaks correct segments faster than it fixes wrong ones:
  the top five breaks 4, and the top ten breaks 10.

### Left-hand practice

A player sometimes practices only the left-hand accompaniment. Then the "top
line" is the accompaniment, and its fingerprint looks nothing like the song's
melody. That shows in the data: left-hand passages from a January 13 Moonlight
Sonata session and a July 8 Maple Leaf Rag session match their songs with a
similarity of only 0.57–0.86, against 0.98 for a typical correct segment.

So the check skips any segment with less than 20% of its playing at or above
middle C. On complete recordings that skipped 26 segments: 8 correct left-hand
passages, and 18 errors. Without the skip, rejection drops one of those correct
passages, a 9-second stretch of Moonlight Sonata, and any stricter cutoff would
drop more. Left-hand passages are also where the model itself goes wrong: in
the same Moonlight Sonata session it proposed Ashokan Farewell and Ain't
Misbehavin' over left-hand practice. A melody check cannot safely catch those,
because it cannot tell them from genuine left-hand practice.

Only 6 of 1,293 annotated takes have under 10% of their playing above middle
C, so the skip costs little here. A library with more left-hand practice would
depend on it more.

### Where this leaves it

Not shipped. +0.15 F1, and about none on recent recordings, does not justify
keeping melody fingerprints in the model and maintaining the extraction.

The signal may still be useful as a hint rather than a decision. On complete
recordings, every proposed segment with a melody similarity below 0.60 was
wrong. Marking such segments in the review queue ("the melody doesn't match
this song"), instead of dropping them, would help a reviewer triage without the
model ever deleting a correct left-hand take. That has not been built.

---

## 2026-09-21 — v2.12: learn "no song" only from finished recordings, and store twice the examples (accepted)

### In plain terms

The model learns what a song sounds like from annotated takes. It learns what
*no song* sounds like from the time between them. Until this release, it took
that "no song" time from every recording with at least one annotation,
including recordings the player hadn't finished labeling. Those gaps are
mostly real playing, often the very songs the model is trying to learn, so a
new song's unlabeled takes were being taught as "no song". v2.12 takes "no song"
only from recordings marked complete. It also stores 16,000 examples instead
of 8,000, which pays off once "no song" is cleaner.

What it buys:

- **New songs are found more often.** While a song has 1–3 annotated takes and
  more sitting unlabeled in unfinished recordings, v2.12 finds 5–6 more of every
  100 of its later takes.
- **On today's library, complete-file F1 rises from 91.8% to 92.9%** (+1.06
  points, 95% interval [+0.21, +2.01]).
- **On the older September 7 benchmark it is unchanged:** 93.3% to 93.4%, an
  interval of [−0.79, +0.80].

What it costs: some practice drills and noodling get a song name instead of
none, some takes are split in two at a weak passage, prediction takes about
twice as long, and the model file doubles to about 17 MB.

Marking a recording complete now matters to the model: it tells it that the
recording's unlabeled time really is "no song". Do it once every take is
annotated, and not before.

### What changed

- `resolveTrainConfig` resolves `noneFromCompleteFilesOnly` to `true` and
  `prototypeBudget` to 16,000. Both are fit-only and every model since v2.10
  records both, so no saved model decodes differently. With no file marked
  complete, `__none__` still falls back to every file.
- `ml:train --trusted-none` is replaced by `--none-from-all-files`, which builds
  the v2.11 behavior. `POST /api/prediction-reviews/rebuild-model` still accepts
  `noneFromCompleteFilesOnly: false`.
- `MODEL_VERSION` bumped to `v2.12`.
- `ml:eval`'s score cache now fingerprints every file in `ml/segmentation/`.
  It had been hashing only the file that re-exports them, so an edit to feature
  extraction or fitting could reuse the old code's cached scores. A test fails
  if a file there is left out. Existing cache entries are recomputed once.

### Why

The v2.10 entry rejected this setting at −0.67 F1. That was measured on 111
files, 40 of them incomplete, with legacy linking and no interval. Re-measured
on the current library (162 annotated files, 133 complete, 1,293 annotations,
dataset `460c80302e4a…`), the reason for the setting is concrete: of 53,661
`__none__` training windows, 37,528 (70%) came from the 29 incomplete files. The
v2.10 entry found that time is ~85% real playing.

**A song's unannotated takes in unfinished files.** Leave-one-file-out cannot
see this case, which every new song is in. It was measured directly: for each of
the 34 songs with at least 12 takes, keep k takes annotated, leave the rest in
their files unannotated with those files counted as incomplete, and score the
song's takes in held-out sessions. Paired on the same draws, bootstrap over
songs, at budget 8,000:

| k | takes found: removed from training / flag off / flag on | flag on vs off: found | flag on vs off: F1 |
| ---: | ---: | ---: | ---: |
| 1 | 56.1% / 50.7% / 56.8% | **+6.1 [+2.7, +9.8]** | +4.9 [+1.9, +8.2] |
| 3 | 75.7% / 72.1% / 77.3% | **+5.2 [+2.4, +8.3]** | +2.9 [+0.7, +5.2] |
| 5 | 80.8% / 80.1% / 82.4% | +2.3 [+0.0, +4.7] | +2.4 [−0.3, +6.4] |

With the flag off, learning those takes as silence costs a new song 4–5 points
of takes found. The flag recovers all of it, with the song's precision
unchanged (within ±0.5).

### Numbers: leave-one-file-out, complete files

Current library, v2.11 against v2.12: F1 91.81% → **92.87%** (recall 89.3 →
91.4, precision 94.5 → 94.4), matched takes 645 → 652, endings within 2s
43.3% → 45.1%, starts within 2s 63.6% → 66.6%. Paired: **+1.057 [+0.209,
+2.007]**. Per file, 50 improve, 18 worsen and 65 are unchanged.

The two changes need each other. On the current library, paired, file
bootstrap 95%:

| comparison | ΔF1 | interval |
| --- | ---: | --- |
| flag on vs off, budget 8,000 | +0.23 | [−0.51, +1.02] |
| budget 16,000 vs 8,000, flag off | +0.25 | [−0.70, +1.06] |
| flag on vs off, budget 16,000 | **+0.81** | **[+0.13, +1.53]** |
| budget 16,000 vs 8,000, flag on | **+0.82** | **[+0.27, +1.41]** |

Neither is distinguishable from zero alone; together they are. The v2.10
explanation for the flag's old gain — withholding windows buys songs a larger
share of a starved budget — predicts a gain that shrinks as the budget grows.
Here it grows. With the flag on, the budget sweep:

| budget | F1 | vs 8,000 | 63-minute prediction | model file |
| ---: | ---: | --- | ---: | ---: |
| 8,000 | 92.05% | — | 2.4s | 8.8 MB |
| 12,000 | 92.31% | +0.26 [−0.21, +0.72] | 3.4s | 13.1 MB |
| **16,000** | **92.87%** | **+0.82 [+0.27, +1.41]** | **4.3s** | **17.4 MB** |
| 24,000 | 93.05% | +1.01 [+0.49, +1.57] | 6.2s | 26.1 MB |

24,000 adds +0.18 over 16,000 ([−0.24, +0.63]) for 1.5x the prediction time,
so 16,000 is the default. A full rebuild takes 2.9s against 2.7s.

**September 7 benchmark** (145 files, 103 complete; the figures in `docs/`),
v2.11 against v2.12: F1 93.33% → 93.37%, **+0.04 [−0.79, +0.80]**. Recall
rises 92.6 → 93.7 and precision falls 94.1 → 93.0. Matched takes 397 → 394;
per file, 25 improve, 21 worsen, 57 are unchanged. The flag alone scores +0.10
[−0.34, +0.60] and the budget alone +0.15 [−0.43, +0.78]. Each trades a little
precision for recall. Why the gain appears on the current library and not this
one is not established; the library has since gained 28% more annotations and
17 more songs.

### The files that get worse, and why

Each was re-predicted both ways and read against its annotations.

- **A drill labeled as songs** (`Jmx-A00453-Jun-21-2026`, current library). One
  38-minute Maple Leaf Rag annotation; its last nine minutes are a two-note
  drill (E♭ 62% and D♭ 21% of sounding time, D and B natural under 1% each).
  v2.12 labels most of it Beethoven's 5th and Bridge Over Troubled Water, whose
  takes carry D and B natural heavily. v2.11 labeled almost none of it. With
  "no song" drawn only from finished recordings, the model has fewer examples
  of drills. **This is the main cost of the change.**
- **Takes split at a weak passage** (`Jmx-A00061-Dec-20-2025`,
  `Jmx-A00055-Dec-14-2025`, September 7 benchmark). The Christmas Song, It's
  Beginning to Look a Lot Like Christmas and White Christmas each come out as
  two predictions with a 9–20 second gap, where v2.11 had one.
- **A poorly known song absorbed** (`Jmx-A00504-Sep-05-2026`). On the
  September 7 benchmark, Maple Leaf Rag runs across both Ashokan Farewell takes,
  where v2.11 kept 14 seconds of the first. On the current library both versions
  do this.
- **A confusion between two 3/4 carols** (`Jmx-A00054-Dec-13-2025`, current
  library, flag on at 8,000). Silent Night, with five takes, is predicted as
  Silver Bells. It is not among the worst files at 16,000.

And the gains. In `Jmx-A00048-Dec-07-2025`, eight takes of Santa Claus is
Coming to Town, v2.11 finds the song for about 5 of 20 minutes and v2.12 for
about 16. Every other take of that song is annotated in a complete
file, so nothing was teaching *that* song as silence. What changed is the "no
song" class: drawn 70% from unfinished recordings, it looks like music, and a
half-recognized take loses to it. Improvements are mostly recall (26 of 37
improving files with the flag alone), and this supersedes the v2.10 "Rejected:
trusted `__none__` sampling" result.

---

## 2026-09-07 — v2.11: bridge linking is the default (accepted)

### In plain terms

A finished song used to keep its label for several seconds after the player
moved on, so the next song's prediction started late. Bridge linking, tried as
an option in the 2026-09-06 entry, fixes most of that, and this release makes
it the default for newly built models. On complete files the median take now
ends 0.81s late instead of 5.85s, twice as many takes end within two seconds of
the annotation (40.6% against 21.6%), and F1 rises from 91.16% to 93.33%. It
does not fix the largest remaining error: two takes of the same song still
merge.

### Context

The 2026-09-06 entry measured bridge linking on a frozen snapshot and left it
opt-in, with three open questions: does it hold on a larger annotated library,
are its thresholds right, and can the 14 files it regressed be fixed or
explained. This entry answers all three and turns it on.

Population: a frozen snapshot of the library taken September 7, 2026, 145 files,
1,007 annotations, dataset SHA-256
`90836c7f78419cf304311739d16d354e3aa5a8fb634da6bad46e57ba31267d8d`. All numbers
are leave-one-file-out over the **103 complete files**. Every run below was
pinned with `--expect-dataset`; every decoder variant reuses the same fold
scores, so they differ only in decoding.

### What changed

- `resolveTrainConfig` now resolves `linkPolicy` to `bridge`. Every model built
  from here on records `bridge`, `linkTailSec: 2` and `linkRescueRank: 5` in its
  own config. `--link-policy legacy` still builds the old model and records no
  thresholds.
- **The decoder still reads an *absent* policy as legacy.** A model saved before
  today decodes exactly as it was built; only a new fit gets the new default.
  This is the v2.3 rule — a default must never move an existing model — and a
  test asserts both halves of it.
- `--link-rescue-lookahead <seconds>` (`linkRescueLookaheadSec`, decode-only,
  default 0/off) is a new experimental knob: instead of testing a whole
  unlabeled span's mean rank at once, each end creeps inwards while its own
  local mean holds. Measured below; **not** enabled.
- The sidebar `Rebuild Model` button and `POST /api/prediction-reviews/rebuild-model`
  send no policy, so they now build a bridge model too.

### Numbers

| complete files, LOO | legacy | **bridge (new default)** |
| --- | ---: | ---: |
| Segment F1 | 91.16% | **93.33%** |
| recall / precision | 92.49 / 89.87 | 92.58 / **94.09** |
| Matched takes | 393 | **397** |
| Predicted segments | 531 | 517 |
| Median end error | +5.85s | **+0.81s** |
| Mean absolute end error | 21.50s | **16.67s** |
| p90 absolute end error | 55.2s | **48.4s** |
| End within 2s | 21.6% | **40.6%** |
| Start within 2s | 38.2% | **61.7%** |
| Start more than 2s early | 24.2% | **21.2%** |

Paired over the 383 annotations both runs matched: **F1 +2.167 points, file
bootstrap 95% [+1.403, +3.084]** (3,000 resamples, seed 42). Endings improve on
206 and worsen on 49; starts improve on 166 and worsen on 82. Per file, 58 of 103
improve, 11 worsen, 34 are unchanged — against 54/14/34 on the smaller snapshot,
so both the gain and the regression count moved the right way as annotation grew.

Median end error by what follows the take (the classification the 2026-09-06
entry introduced):

| what follows | n | legacy | bridge |
| --- | ---: | ---: | ---: |
| a different song after a gap | 210 | +8.09s | **+0.75s** |
| a different song within 2s | 52 | +3.23s | **+0.11s** |
| end of recording | 73 | +1.13s | +1.12s |
| the same song after a gap | 53 | +31.34s | +38.72s |
| the same song within 2s | 10 | +82.18s | **+36.39s** |

### Thresholds: re-swept, all defaults kept

Every knob was re-swept under bridge on this larger population. The 2026-09-06
values are still the best or statistically indistinguishable from it, so nothing
was re-fitted to this dataset:

| knob | swept | best | kept |
| --- | --- | --- | --- |
| `linkRescueRank` | -1, 2–12 | 6 (93.535) | **5** (93.329) |
| `linkTailSec` | 0–6 | **2** (93.329) | 2 |
| `anchorMargin` | 0.08–0.25 | **0.15** (93.329) | 0.15 |
| `minAnchorRun` | 2–5 | **3** (93.329) | 3 |
| `linkMaxSilenceRatio` | 0.4–1.0 | 0.6 (93.376) | **0.7** (93.329) |

Rank 6 scores +0.205 with a bootstrap interval of [-0.037, +0.545] — it crosses
zero, and 5 is the value that sits in the measured gap between the rank
distributions inside a take (p75 = 4.0) and outside one (p25 = 7.2) rather than
at the top of a curve fitted to this library. Same reasoning for silence 0.6.
**Every default here was chosen on prior evidence and survived re-measurement;
none was moved to chase a tenth of a point.**

### Rejected: a lookahead on the rescue pass

The 2026-09-06 entry's open item #2. A span's mean rank is only a fair statement
about the span when the span is one thing, and often it is not — the ambiguous
middle of a take runs straight into the dead air after it, and averaging the two
together rejects both. Creeping inwards from each end while a *local* mean holds
fixes that in the individual files where it was diagnosed, and is a wash overall:

| | bridge | +lookahead 10s, rank 8 |
| --- | ---: | ---: |
| Segment F1 | 93.329 | 93.349 |
| Matched takes | 397 | **401** |
| End within 2s | 40.6% | **42.6%** |
| p90 absolute end error | 48.4s | **46.6s** |
| same song after a gap, median end error | +38.7s | **+30.0s** |
| Start within 2s | **61.7%** | 59.6% |
| Start more than 2s early | **21.2%** | 24.4% |

**+0.020 points, 95% [-0.526, +0.403]** — the interval straddles zero. It trades
start accuracy for end accuracy and recognizes four more takes. Kept as a flag,
off, because the diagnosis behind it is sound and the trade may be worth taking
once repeated takes are handled; not made a default on a wash.

Also **rejected: letting the rescue claim a span with the same song on both
sides.** Measured twice. Whole-span it scores F1 93.506 but pushes the
back-to-back same-song ending error from +36.4s to +76.3s — worse than legacy, in
the error class that is already the worst — and loses 5 matched takes. With the
lookahead it is inert (93.496 against 93.349, every error class identical to two
decimal places). The flag was implemented, measured, and removed rather than
left in the config surface.

### The files that regress, and why

11 of 103 complete files get worse; 4 by more than 1.5 F1 points. Every one was
read window by window against its own MIDI. They fall into two kinds, and
neither is a reason to withhold the change.

**Lenient annotation (the model is right, the label is not).** File 143
(`Jmx-A00494-Aug-24-2026`) is four consecutive `The Entertainer` annotations
covering 73s–602s. Legacy predicts 62.8–602.4; bridge predicts 0.5–602.4 and
loses 9.8 points of precision for it. The disputed span is the first 73 seconds,
where the model says The Entertainer and the annotation says nothing. Legacy also
over-predicts there, by 11 seconds — bridge is scored worse for doing more of the
same thing. Tightening the decoder until this file scores well would be fitting
to an annotation boundary that was never drawn.

**Weak middles, which the leash then truncates (a real cost).** Files 503, 43 and
446 all have a take whose anchors stop well before the annotated ending — the
model half-recognizes the middle of the take and the rescue's whole-span mean,
diluted by the dead air that follows, refuses to give it back. File 503's second
`Ashokan Farewell` take keeps 14 seconds of a 78-second annotation. This is the
honest cost of the change, it is the exact failure the rejected lookahead
addresses (503 recovers to -10.4 from -29.0 under it), and it is bounded: these
three files are 3% of the population, against 58 that improve.

The two are told apart by direction. Lenient-annotation regressions lose
*precision* while recall stays put; leash regressions lose *recall*. Across the
11 regressing files, 4 are the first kind and 7 the second.

### What is still wrong

**Repeated takes of one song remain the dominant error**, unchanged from
2026-09-06: +38.7s median end error after a gap, and the class is now *worse*
than legacy there (+31.3s) even though it is much better back-to-back (+36.4s
against +82.2s). Two takes of one song vouch for each other and merge. Neither
the rescue's same-song refusal nor a lookahead fixes it; it needs a stop/restart
cue — a silence run, a bookmark, a compressed JMX pause — used as a barrier that
blocks *vouching*, which is the one bridge rule that still has no right-hand
bound. That is the next target, and `files.skips_json` already holds the cue.

---

## 2026-09-06 — bridge linking: a finished song no longer runs long (experimental, opt-in)

### Context

Reported symptom: a take keeps its label past the point where the playing
stopped, so the next song's prediction starts late. On the frozen 144-file
snapshot the median matched take ended **6.09s late**, and 81% of takes followed
by a different song ended more than 2s late.

Two candidate causes were measured and **ruled out**:

- **Note snapping.** Running the same folds without `snapSegmentBoundaries`
  moves the median end error from +6.09s to +6.02s. Snapping accounts for 0.07s
  of it. An adjacent-pair snapping refinement is not worth building for this.
- **The classifier.** Across the 6,391 windows that sit between an annotated end
  and its late prediction, the take's own song is the model's top label in a
  median **11.1%** of them, and `__none__` in 0.0%. The model does not think the
  song continues.

The cause is pass 2 of `anchorLinkDecode`. It links any window that is not
confidently something else, nothing bounds that on the right, and runs are
extended in recording order, so the earlier song reaches an ambiguous window
first and keeps it. The region between takes is not silent — mean
`silence_ratio` 0.097 — so `linkMaxSilenceRatio` never fires. A take's own edges
are short by comparison: median 2.8s from the annotated start to its first
anchor, 3.6s from its last anchor to the annotated end.

But that rule is load-bearing, and cutting it back naively costs more than it
saves: one 272s take carried by a *single* three-window anchor scores IoU 0.99
under legacy, because nothing else was anchored for 208s. What separates the two
cases is not per-window evidence — per window neither looks like anything — but
where a song sits in the ranking **averaged over a whole span**: median rank 1.3
across spans inside its own take against 16.0 outside one. The fraction of
windows a song actually wins does not separate them at all.

### What changed

`--link-policy bridge`, plus `--link-tail-sec` (default 2) and
`--link-rescue-rank` (default 5) in `ml:eval`. Legacy is still the default and is
bit-identical when the flag is absent — the legacy report matches the previous
one across all 22 metric keys.

1. A span with an anchor run of the **same** song on both sides is a passage
   inside a take: fill it from both ends with the existing rule, no limit.
2. Past a song's outermost anchor nothing vouches for it, so the run advances
   `linkTailSec` seconds and then only while the song is still the model's own
   top choice. A side with no different song anchored beyond it is not leashed —
   there is nothing to arbitrate against, so silence stays the only stop.
3. Unvouched tails advance in lockstep, so two songs reaching for the same
   window meet in the middle rather than the earlier one taking all of it.
4. A rescue pass then gives an unlabeled span to a neighboring song when that
   song's mean rank across the whole span is at most `linkRescueRank`. Silence
   splits a span rather than being claimed with it, and a span with the same song
   on both sides is skipped — that is the break between two takes of it.

Rules 1–3 fix the overrun; rule 4 pays back the coverage they cost.

Also added `npm run ml:compare`, which holds two eval reports against each other
on the annotations both matched, so a change in aggregate metrics can be told
apart from a change in which takes were recognized at all.

And a **Prediction Lab** on the file detail page, for trying these settings on a
recording you know. Preview is a dry run, so nothing reaches the review queue
until it is applied, and candidates live only in the page. Decode-only settings
go through `POST /api/prediction-reviews/run` as `decoderOverrides` and
re-decode the saved model rather than retraining it, so candidates that differ
only there are comparable. A preview is allowed on a completed file — a
committed run still is not — because that is the only place a prediction can be
checked against a known answer; there it shows the model's segments before
annotated time is subtracted. It is for forming a hypothesis, not settling one:
`ml:eval` over the library remains what decides.

### Numbers

Complete files, leave-one-file-out, 103 files / 688 annotations, snapshot
`926d930d…`. `evidence` is the `--anchor-gap-policy` experiment from the same
day, shown for comparison.

| | legacy | `evidence` | rules 1–3 only | **`bridge`** |
| --- | ---: | ---: | ---: | ---: |
| Segment F1 | 91.42% | 91.63% | 92.31% | **93.06%** |
| recall / precision | 92.99 / 89.90 | 93.19 / 90.12 | 89.99 / 94.76 | 92.37 / 93.76 |
| Median end error | +6.09s | +4.39s | +0.27s | **+1.20s** |
| Mean absolute end error | 20.32s | 19.42s | 15.46s | **16.03s** |
| End within 2s | 19.6% | 25.4% | 42.8% | **38.7%** |
| Start within 2s | 40.2% | 47.8% | 64.3% | **63.4%** |
| Start more than 2s early | 25.7% | 30.3% | 18.6% | **21.6%** |
| Matched annotations | 393 | 393 | 381 | **393** |

Paired over the 385 annotations both runs matched: endings improve on 208 and
worsen on 44; starts improve on 169 and worsen on 84. F1 **+1.640 points, file
bootstrap 95% [+1.016, +2.287]**. On the same 47 close different-song transitions
the companion document measured, the median ending error goes +3.70s → **+0.14s**
and the next take's start +2.51s → **+0.30s**, against +1.24s / +0.33s for
`evidence`.

Held out by recording date, the newest 25% of complete files (26 files, which did
not inform either threshold): matched takes unchanged at 76, median end error
+4.98s → +1.41s, mean absolute 19.76s → 16.54s, end within 2s 22.4% → 38.2%,
start within 2s 50.0% → 67.1%, start more than 2s early 28.9% → 25.0%. F1 there
moves +0.772; the gain is smaller on recent recordings because they already score
93.7%.

The gain survives every decoder setting swept (`anchorMargin` 0.10–0.25,
`minAnchorRun` 2–5, `linkMaxSilenceRatio` 0.5–0.9: +1.40 to +2.59) and both
thresholds are flat (rescue rank 2–10: 92.46–93.26; leash 1–4s: 92.98–93.06).
Per file, 54 of 102 improve, 14 worsen, 34 are unchanged.

### What it costs, and what is still wrong

- Annotation recall falls 92.99% → 92.37% on complete files and 94.49% → 93.50%
  on incomplete ones, against precision rising 89.90% → 93.76%.
- 14 of 102 complete files get worse, the worst by 8.9 F1 points.
- **Repeated takes of the same song are now the dominant error** (median end
  error +28.4s after a gap, +54.0s back to back, against +32.9s and +73.6s for
  legacy). Two takes of one song vouch for each other and merge. Rules 1–3 alone
  get these to +13.6s and +45.2s; the rescue pass gives part of that back. A
  stop/restart cue used as a barrier to vouching would fix both.
- The rescue pass costs about a point of ending precision against rules 1–3
  alone. `--link-rescue-rank -1` is the better setting when ending accuracy
  matters more than coverage, and still beats legacy on every boundary statistic.

Not the default, but now trainable: `ml:train --link-policy bridge`, plus
`--link-tail-sec` and `--link-rescue-rank`, and the same three fields on
`POST /api/prediction-reviews/rebuild-model`. `resolveTrainConfig` fills the two
thresholds only when the policy is on, so a model trained with it records all
three and the CLI, the import pipeline and the API decode it identically, while
a legacy-trained model records none of them and is unchanged. Turning it on for
real means retraining and reading the review queue's confirmed/edited/invalid
split — the offline evidence here does not measure how the predictions feel to
correct by hand. Variants tried and rejected: global `fillTopK`, per-window
rank gating, all-or-nothing bridging, a contention horizon, vote fraction as the
rescue statistic, rescuing same-song spans, and `bridge` combined with
`evidence`.

---

## 2026-09-03 — v2.10: honest evaluation scope, prototype budget, silence-blocked linking (accepted)

### In plain terms

Until this release, the headline precision mostly measured how much of the
library had been annotated, not how good the model was: a correct prediction on
an unlabeled stretch of an unfinished recording counted as wrong. `ml:eval` now
scores recordings marked complete separately, and that is the number to
compare models on. Measured that way, this release raises F1 from 83.08% to
88.15%, by rescaling the features, using six-second windows, storing four
times as many examples, and stopping a song from spilling into the silence
after it.

### Context

Most of this release comes out of one finding: **segment precision was never
measuring the model.** It was measuring how much of the library has been
annotated.

Split a single leave-one-out run by whether a file is marked complete:

| population | files | audio annotated | recall | precision | F1 |
| --- | --- | --- | --- | --- | --- |
| complete files | 71 | 87.7% | 85.87% | **85.52%** | **85.69%** |
| incomplete files | 40 | 37.2% | 87.24% | **38.04%** | 52.98% |
| all files (what earlier entries report) | 111 | 57.0% | 86.41% | 56.99% | 68.68% |

Same model, same fold, same code. Recall differs by 1.4 pt, so the
classification problem is equally hard in both populations. Precision differs by
**47 points**, because 63% of the audio in an incomplete file carries no
annotation and a correct prediction there scores as a false positive.

The review queue settles which number is real. 337 predictions carry a human
verdict, all of them on incomplete files (marking a file complete clears its
review rows). By duration, **85.5% were confirmed or edited rather than marked
invalid** — the complete-files number, not 38%. Two further checks agree: of all
predicted seconds only **2.9%** land inside an annotation naming a *different*
song, and of the predicted time that falls outside any annotation, 79.5% is
isolated runs with a **median length of 91s** — the length of a take, not of a
decoder error.

The practical damage is that the aggregate metric is nearly blind. Across window
lengths 4s to 8s it moves between 67.7% and 68.7%, under a point and
non-monotone, which reads as noise; the complete-files metric moves 83.1% to
86.4% over the same sweep. Precision lost on incomplete files was canceling
recall gained, and several sweeps were read as flat when they were not.

### What changed

- **`ml:eval` reports segment metrics three ways** — complete files, incomplete
  files, and everything — and names the complete-files row as the one to compare
  variants on. `loadAnnotatedMidiFiles` now carries `isComplete`; the report JSON
  gains `segmentComplete` and `segmentIncomplete`, each with its own file count.
- **`prototypeBudget` default raised 2000 -> 8000.** The largest single lever
  measured, and it had not been swept since v2.6 raised it to 2000 for a library
  less than half the current size. On complete files, segment F1 runs 81.9% /
  85.7% / 86.8% / 87.3% at budgets of 1000 / 2000 / 4000 / 8000, with precision
  rising alongside recall — not a coverage-for-accuracy trade. It also relieves
  the long-standing under-annotated-song defect from a side the three failed
  corrections in the v2.3 entry did not try: the smallest song goes from 4
  prototypes to 24. Nothing about the *relative* allocation changed, but every
  label now has enough prototypes to describe itself. Cost is linear —
  prediction scores each window against every prototype, and the model file
  grows from 2.0 MB to 7.7 MB. 8000 is the knee, not just where the sweep
  stopped: re-measured on the accepted configuration, 12000 / 16000 / 24000 give
  F1 88.15 / 88.30 / 88.12 against 8000's 88.15, flat within ±0.15 while costing
  up to 4.6x the scoring time.
- **`noneFromCompleteFilesOnly` added, default off** — a new flag for a
  hypothesis that did not survive its control. See "Rejected" below.
- **Silence-blocked anchor linking (`linkMaxSilenceRatio`, default 0.7).** The
  anchor decoder fills any window whose evidence is weak, and dead air always has
  weak evidence, so one recognizable phrase could claim the silence after it and
  carry on into whatever followed. Silence is not ambiguous evidence that the
  song continues. A model saved before this release has no value for the field
  and keeps the old behavior.
- **Window length 5s -> 6s**, re-tuned on top of the larger budget rather than
  carried over from the sweep that predates it.
- **One set of training defaults.** `POST /api/prediction-reviews/rebuild-model`
  restated its own defaults and had already drifted (window 4 against the CLI's
  5). Both entry points now read `TRAIN_CONFIG_DEFAULTS` and leave everything
  else to `resolveTrainConfig`.
- **Fixed: the fit read defaults off the caller's partial config.**
  `allocatePrototypeBudgets` fell back to `prototypeBudget ?? 1200` while
  `resolveTrainConfig` used 2000, and the model saved the *resolved* config —
  so a caller that omitted the field got a model whose saved config described a
  build that never happened. `fitModelFromSamples` now resolves once and builds
  from the resolved values, and the functions that read those fields take a
  `ResolvedTrainConfig` so the defaults cannot be restated at a use site.
- `MODEL_VERSION` bumped to `v2.10`.

### Results

Leave-one-file-out, 111 files, 718 annotations. **Complete-files scope.**

| step | acc | recall | precision | F1 |
| --- | --- | --- | --- | --- |
| v2.8 committed (win 4, minmax, budget 2000) | 79.10 | 79.60 | 86.89 | 83.08 |
| + z-score scaling | 82.38 | 82.86 | 86.18 | 84.49 |
| + window 5s (the in-flight v2.9) | 85.17 | 85.87 | 85.52 | 85.69 |
| + window 6s | 85.91 | 86.35 | 84.77 | 85.55 |
| + prototype budget 8000 | 89.32 | 89.48 | 86.38 | 87.90 |
| + silence-blocked linking (**v2.10**) | 89.29 | 89.48 | 86.86 | **88.15** |

The v2.9 half of that is worth recording separately, because it was ablated:
z-score alone at window 4 is +1.41 F1, while window 5 alone under min-max is
−0.03 (accuracy +4.4 pt, precision −2.8). Window length only pays off once the
features are z-scored — min-max maps each feature onto [0,1] from the training
extremes, so one outlier window compresses the useful range of that feature.

### Rejected in the same sweep

- **Trusted `__none__` sampling** — the idea that motivated half this
  investigation, and it does not hold up. Training labels every unannotated
  window of an annotated file `__none__`: a statement the user made in a
  complete file, an assumption in an incomplete one, and section above shows
  that assumption is wrong ~85% of the time. About **62,000 windows of real
  performances of songs the model already knows were being taught as silence** —
  the exact shape of the dominant error the last three releases chased. Dropping
  them measured **+0.83 F1 at `prototypeBudget` 2000** and **−0.67 at 8000**.

  The confound: withholding those windows lowers `__none__`'s `sqrt(support)`,
  which raises every song's share of a fixed budget. Trained both ways at budget
  8000, the `__none__` prototype count is identical (60 — `maxNonePrototypes`
  binds either way) while song prototypes rise 7,035 -> 7,650, **+8.7%**. Most
  of the apparent win was that share, worth more when songs are starved of
  prototypes than the negative class is. Once songs have enough, what remains is
  the loss: `__none__` has to cover everything that is not an annotated song,
  and the unannotated time in incomplete files is a large part of that variety.

  Kept behind `noneFromCompleteFilesOnly` / `--trusted-none`, default off, so it
  can be re-measured if the annotated library's shape changes. **A change that
  redistributes a fixed budget must be measured against a budget sweep**; this
  one read as a clean simultaneous win on accuracy, recall and precision until
  it was.
- **Score-sequence smoothing** (widths 3–25). Raises window accuracy
  (85.17 -> 89.11 at width 5) but blurs boundaries faster than it gains: F1
  85.35 / 84.45 / 81.02 / 74.90 / 69.22. A slower, worse version of lengthening
  the window.
- **Feature-group weighting.** Halving the six performance-style features is
  within noise (85.74 vs 85.69); ablating them costs 1.2 pt. Unlike `tempo_bpm`
  in v2.6, practice-state features are not a noise source here.
- **Relaxed anchor margin** (0.10, 0.12): 82.73 / 85.27. Reproduces the earlier
  conclusion on the honest metric. 0.15 stands.
- **`minAnchorRun`** 2 / 4 / 6: 85.16 / 84.96 / 80.41. 3 stands. 6 reaches
  90.04% precision at 72.65% recall if a precision-first mode is ever wanted.
- **`minSegmentSec`** 12 / 16: 85.49 / 85.06. Human-rejected predictions do
  average 33s against 87s for accepted ones, but raising the floor discards
  correct short segments at the same rate.
- **`maxNonePrototypes`** 120 / 240: 84.96 / 83.46. 60 stands.

### Where the remaining error is

About 10.5% of annotated time is still missed on complete files, and part of
that is structural rather than a model defect.

1.9% of annotated time cannot be recovered under leave-one-out at all: ten songs
have every annotation inside a single file, so the fold that tests them trains
without them (Sleigh Ride 762s, Beethoven's 5th 286s, and eight more). 20 of 63
songs appear in two files or fewer, and per-song recall tracks that closely. The
highest-value next move is annotation, not architecture — a second file for each
single-file song, and more coverage of the low-recall sparse pieces that
`trainingSummary.underAnnotatedLabels` already lists.

Marking a file complete is also what moves it into the honest evaluation
population: 40 of 111 annotated files are still outside it.

## 2026-09-03 — v2.8: boundary micro-snapping, cadence-chord detection, and flourish excision (accepted)

### Context

Two boundary artifacts degraded segmentation quality and human annotation workflow:
1. **Coarse window-center quantization and pre-song padding:** `windowsToSegments` previously derived segment bounds solely from window centers on a 1-second grid without access to physical note events. This left typical dead-air padding of 0.25s–1.5s before the first played note of a song, diluting segment precision and polluting training samples.
2. **Ending flourishes and extraneous arpeggios:** Pianists frequently end a piece by playing a dramatic arpeggio run across octaves after the final cadence chord. Because these flourishes are played in the home key, their chroma matched the song prototypes, and `anchorLinkDecode` tracked them across several extra seconds. Annotating flourishes confused prototype models, while manually trimming them created human annotator fatigue.
3. **Contiguous takes without silence:** In practice sessions, songs often begin immediately after a previous take or cadence without an intervening silence gap.

### What changed

- **Isomorphic boundary module (`core/boundaries.ts`):**
  - `detectCadenceAndFlourish`: Discovers multi-voice cadence chords ($\ge 3$ distinct pitches within 80ms) followed by rapid low-polyphony, high-pitch-span arpeggiated runs ($\ge 18$ semitones, inter-onset intervals $<0.35$s), calculating the exact clean `trimmedEndTime` of the final chord.
  - `snapSegmentBoundaries`: Micro-snaps segment start to the first physical note onset within $[startTime, startTime + 1.5s]$, trims trailing flourishes when detected, and snaps segment end to the acoustic release (incorporating damper pedal decay).
- **Segmentation pipeline integration (`ml/songSegmentation.ts`, `server/services/predictionImport.ts`, `ml/predict.ts`, `ml/eval.ts`):**
  - Updated `windowsToSegments` to accept `notes?: BoundaryNote[]` and refine boundary edges automatically during prediction and evaluation.
- **Human annotation UI assistance:**
  - **Detail view flourish pill & 1-click trim (`DetailAnnotationList.tsx`, `DetailPage.tsx`):** Displays a trailing flourish pill with pitch span / note count and a 1-click "Trim Flourish" button.
  - **Snap to notes action (`DetailAnnotationList.tsx`, `AnnotationModal.tsx`):** Provides a 1-click "Snap to Notes" button on annotation cards and inside modal creation/editing to eliminate dead air padding.
  - **Prediction review flourish detection (`PredictionReviewPage.tsx`):** Surfaces a dedicated banner highlighting detected flourishes with a 1-click "Trim Flourish & Confirm" button that promotes the trimmed segment without manual handle dragging.
- `MODEL_VERSION` bumped to `v2.8`.

### Results

#### 1. Generalization Benchmark: Leave-One-File-Out (LOO) Cross-Validation
Full Leave-One-File-Out cross-validation across all annotated files (111 files, 717 annotations, 91,883 evaluated song windows):

| metric | v2.4 baseline | v2.6 | v2.7 champion | **v2.8 (boundary snapping & flourish trimming)** | delta vs v2.7 |
| --- | --- | --- | --- | --- | --- |
| files evaluated | 73 | 73 | 73 | **111 files** | +38 files |
| window accuracy | 70.41% | 78.80% | 80.01% | **81.3%** | **+1.3 pt** |
| segment recall | 71.03% | 79.47% | 80.60% | **81.9%** | **+1.3 pt** |
| segment precision | 53.49% | 53.90% | 53.60% | **56.5%** | **+2.9 pt** |
| segment F1 | 61.03% | 64.24% | 64.40% | **66.9%** | **+2.5 pt** |
| unit & integration tests | pass | pass | pass | **55 server, 177 client pass (all green)** | |

*Key takeaway: Micro-snapping boundary padding and excising trailing arpeggios directly boosted Segment Precision from **53.6% to 56.5%** (+2.9 pt) and Segment F1 to an all-time high of **66.9%** (+2.5 pt), while Window Accuracy generalized to **81.3%**.*

#### 2. In-Sample Integration Smoke Test (`--mode insample`)
Full library in-sample test (111 files, 162,753 extracted windows):
- **Window Accuracy:** 94.5%
- **Segment Recall:** 95.2%
- **Segment Precision:** 62.5%
- **Segment F1:** 75.5%

#### 3. Architectural Experiments
Also explored, without a change shipping: window duration sweeps (2.5s to 6.0s), multi-scale dual-window concatenation, and note-density-modulated confidence thresholding.

---

## 2026-09-02 — v2.7: acoustic sustain-pedal decay modeling (accepted)

### Context

After releasing v2.6, false-negative collapses to silence (`Song -> __none__`) remained the primary failure mode. A user insight identified the root physical mechanism:
When pianists play with the damper pedal (CC 64), keys are frequently released 0.2s–0.8s before the next beat to shift hands. When decoding MIDI strictly by physical key-release events, the feature extractor found 0 active notes during these hand shifts: `silence_ratio` spiked to 1.0, pitch-class durations dropped to 0, and the nearest prototype collapsed to `__none__`. In reality, the strings were vibrating and the chord was still ringing acoustically (and in the app's audio playback).

A previous v2.5 experiment that added CC 64 metadata features (e.g. `sustain_ratio`) directly to the feature vector failed because pedaling varies across takes, adding noise to prototype distances. Modeling the *acoustic vibration of the strings* solves the root problem directly.

### What changed

- **Shared pedal interval modeling (`core/midi/noteSequence.ts`):** Canonical `buildPedalIntervals` and `heldByPedal` moved to `core`, unifying playback (`pianoSampler.ts`) and feature extraction (`songSegmentation.ts`).
- **Acoustic sustain extension with register caps (`extractNotesFromMidi`):** Notes released under a held damper pedal extend until the pedal lifts or natural acoustic decay ends the ring (0.7s cap for bass/mid; 0.6s cap above C5 due to faster treble string decay).
- **Decayed ringing tail weight (`extractWindowFeatures`):** The key-down portion receives full velocity weight ($\sqrt{v / 127}$); the sustained ringing tail receives a 0.5x decayed weight to prevent harmonic bleeding across chord changes while keeping the window acoustically alive.
- `MODEL_VERSION` bumped to `v2.7`.

### Results

73 annotated files, evaluated via full Leave-One-File-Out cross-validation on annotated windows.

| metric | v2.4 baseline | v2.6 | v2.7 champion | delta vs baseline |
| --- | --- | --- | --- | --- |
| window accuracy | 70.41% | 78.80% | **80.01%** (eval) / **80.99%** (sweep) | **+9.6 to +10.6 pt** |
| segment recall | 71.03% | 79.47% | **80.60%** (eval) / **81.58%** (sweep) | **+9.6 to +10.6 pt** |
| segment precision | 53.49% | 53.90% | **53.60%** (eval) / **54.08%** (sweep) | **+0.1 to +0.6 pt** |
| segment F1 | 61.03% | 64.24% | **64.40%** (eval) / **65.04%** (sweep) | **+3.4 to +4.0 pt** |
| emitted segments | 734 | 588 | **551** | **-183** (-25%) |
| false silences (`Bethena -> none`) | 1,668 | 804 | **734** | **-934** (-56%) |
| false silences (`Ashokan -> none`) | 1,117 | 819 | **653** | **-464** (-42%) |
| false silences (`Winter Wonderland -> none`) | 785 | 541 | **350** | **-435** (-55%) |

---

## 2026-09-02 — v2.6: compressive velocity-weighted chroma, tempo ablation, rebalanced prototype budgeting (accepted)

### Context

Diagnostic analysis of v2.4 LOO errors revealed that **92.7% of all classification errors** were collapses to silence (`Song -> __none__`), while cross-song confusion was minimal. Two structural factors drove this:
1. `__none__` prototype dominance: with `maxNonePrototypes=120`, nearest-prototype distance gave silence an artificial geometric advantage over songs with only 10–30 prototypes.
2. In piano practice, melodic phrases and chords are played with firm velocity (70–110), while pedal resonance and mechanical noise ring at lower velocities (20–50). Flat chroma duration accumulation treated all sounding notes equally.
3. Practice speeds are non-stationary: students practice difficult pieces slowly, with rubato, or haltingly. The `tempo_bpm` feature penalized true song matches when played at differing practice speeds.

### What changed

- **Compressive velocity-weighted chroma:** In `extractWindowFeatures`, pitch-class accumulation is weighted by `sqrt(velocity / 127)`. Melodic and accented notes dominate the low/high chroma profiles while preserving soft harmonic context.
- **Ablation of `tempo_bpm`:** Removed `tempo_bpm` from the feature set (38 -> 37 features). Practice speed variation no longer distorts nearest-prototype distance.
- **Rebalanced prototype budgeting:** Default `maxNonePrototypes` reduced from 120 to 60; default `prototypeBudget` increased from 1200 to 2000. Songs receive ample prototypes to capture diverse musical sections without being swallowed by silence.
- **Phrase gap merging:** Default `mergeGapSec` increased from 3s to 5s to bridge typical micro-pauses between practice phrases.
- `MODEL_VERSION` bumped to `v2.6`.

### Results

All numbers are 73 annotated files, evaluated via full Leave-One-File-Out cross-validation on annotated windows.

| metric | v2.4 baseline | v2.6 champion | delta |
| --- | --- | --- | --- |
| window accuracy | 70.41% | **78.80%** | **+8.39 pt** |
| segment recall | 71.03% | **79.47%** | **+8.44 pt** |
| segment precision | 53.49% | **53.90%** | **+0.41 pt** |
| segment F1 | 61.03% | **64.24%** | **+3.21 pt** |
| emitted segments | 734 | **588** | **-146** (-20%) |
| false negatives (`__none__`) | 15,016 | **10,371** | **-4,645** (-31%) |
| cross-song confusions | 2,997 | **2,528** | **-469** (-16%) |

### Notes

- Single-file songs: 11 songs only appear in 1 file across the database (2,012s of annotation). In LOO, their recall is mathematically bounded at 0% because the held-out fold has 0 training examples. For songs in >= 2 files, recall approaches ~82%.
- A 5.0-second window variant was also tested and achieved 81.76% window accuracy and 82.19% recall (F1 64.00%). The 4.0-second default was retained for sharper temporal boundaries.

---

## 2026-09-02 — v2.5 experiment: damper-pedal features (rejected)

### Context

The app started modeling the damper (sustain) pedal in playback: a key released
while the pedal is down keeps ringing until the pedal lifts (`pianoSampler.ts`,
CC 64 via `core/midi/noteSequence`). The pedal events are decoded in 235 of 236
files, and a pianist's pedalling is part of a song's identity -- ragtime's
syncopated re-pedalling versus a ballad's held pedal -- so the open question was
whether pedal features in the model help recognize songs in LOO evaluation.

### What changed

Added four window features from the CC 64 events (`38 -> 42` features):

- `sustain_ratio` — fraction of the window the pedal was held down
- `sustain_press_density` — pedal presses per second (capped at 4/s)
- `mean_sustain_span` — mean pedal-down span length / window length
- `sustain_span_std` — spread of pedal-down span lengths / window length

Spans were seeded at the window start when the pedal was already down (a press
before the window extends in), matching `sliceSequence`. `extractMidiSource`
replaced `extractNotesFromMidi` so feature extraction and playback share one
decode. `MODEL_VERSION` was bumped to `v2.5`.

### Results

All LOO numbers are 73 annotated files, the same dataset as v2.4.

| metric | v2.4 baseline | v2.5 +pedal | delta |
| --- | --- | --- | --- |
| window accuracy | 70.41% | 66.97% | -3.44 pt |
| segment recall | 71.03% | 67.59% | -3.44 pt |
| segment precision | 53.49% | 53.44% | -0.05 pt |
| segment F1 | 61.03% | 59.69% | -1.34 pt |
| segments emitted | 734 | 618 | -116 |
| predicted seconds | 80,872 | 77,087 | -3,785 |

**Pedal features are a measured regression and are rejected.** The model now
fails by *silence* more: `Etude No 2 -> __none__` 1,235 -> 2,066,
`Bridge Over Troubled Water -> __none__` 688 -> 1,074, `Ashokan Farewell ->
__none__` 708 -> 1,021, while `Bethena -> __none__` improved 1,668 -> 1,452 and
`True Love Leaves No Traces -> __none__` improved 708 -> 550.

The mechanism is visible in a per-song diagnostic: for `sustain_ratio`,
between-song variance is only ~31% of total variance (0.034 vs 0.075
within-song). Pedalling varies more across a player's repetitions of one song
within a practice session than it does between songs, so the features add
within-song noise to the prototype distances. There is real signal at the
extremes (Peacherine Rag almost no pedal, Silent Night/Away in a Manger ~0.84)
but not enough to overcome the noise through the prototype-scoring path.

**Reverted.** Feature extraction is back to the 38-feature v2.4 set and the app
model is retrained on it (deterministic retrain reproduces the baseline numbers
exactly: 70.41% / 71.03% / 53.49% / 61.03%). The experiment is reproducible
from this entry and the two stamped LOO reports left on disk.

### Notes

- Eval reports now stamp their filename with the model release (`v2.4`/`v2.5`,
  from the model's new `modelVersion` field) and a `YYYYMMDD-HHmmss` timestamp,
  so runs are referable without copying or renaming. See `ml/eval.ts`.
- Follow-up candidates if pedal is revisited: a single `sustain_ratio` feature
  (the most discriminative) instead of four; pedal features gated behind a
  train-time flag, which requires making the feature count (and the `loadModel`
  guard) config-dependent.

---

## 2026-09-01 — v2.4: split-register chroma features + hand-mask augmentation (rejected)

### Context

Flat pitch-class (chroma) profiles are octave-invariant: a C2 and a C5 both
increment `pc_C`. Register survived only in `mean_pitch`/`pitch_span`, so the
model could not see "left-hand content" vs "right-hand content". Practice
sessions mix two-hand and one-hand performances of the same song; the open
question was whether making register explicit in the features, and teaching the
model one-hand variants of each song, helps recognition.

### What changed

**Pitch classes are split by register.** The 12 flat chroma features are
replaced by 24 (`pcLow_*`, `pcHigh_*`), each register normalized independently
to sum 1, plus `low_register_ratio` (the low/high energy balance that
independent normalization hides). 25 → 38 features. The divide is
`registerDivide` (default 60, middle C), stored in the model config.
`loadModel`'s feature-set guard rejects older 25-feature models with the usual
"retrain it" error.

**Hand-mask augmentation (rejected, kept behind `--hand-mask-augment`).** A
fraction of annotated windows is duplicated with one register's chroma zeroed
and `low_register_ratio` set to the remaining register's extreme, under the
same label. Selection is an even stride with alternating masks — no RNG, so
training and LOO eval stay deterministic. A window whose target register is
already empty is skipped, so a song window is never masked into a
silence-shaped vector.

### Results

All LOO numbers below are 57 annotated files (v2.3 was 48 files, so part of the
jump is data growth, not features).

| metric | v2.3 (48 files) | v2.4 split (57) | +aug 0.15 (57) | +aug 0.5 (57) |
| --- | --- | --- | --- | --- |
| window accuracy | 50.91% | 73.65% | 70.23% | 68.35% |
| segment recall | 51.26% | 74.21% | 70.49% | 68.94% |
| segment precision | 45.43% | 50.37% | 50.93% | 51.58% |
| segment F1 | 48.17% | 60.01% | 59.13% | 59.01% |
| segments emitted | 364 | 512 | — | 524 |
| predicted seconds | 36,468 | 68,610 | — | 62,423 |

Songs with 60s+ annotation at 0% recall: 13 with split-only vs 16 recorded at
v2.3 (12 with aug 0.5). The confusions that remain are almost entirely
song → `__none__` (Bethena 2,039, True Love Leaves No Traces 708): the model
now mostly fails by *silence*, not by wrong song.

**Split-register chroma is the win.** It is the only change that improved
accuracy, and it is the register signal the flat chroma was throwing away. The
window-accuracy jump is large because LOO folds now separate songs that share
pitch classes but not registers (e.g. a Moonlight-style left-hand ostinato vs a
melody-led song).

**Hand-mask augmentation is a measured regression, monotone in the fraction.**
At 0.15 and 0.5 it lowers LOO F1 and window accuracy, and per-window recognition
of *single-register* windows (insample argmax, no decoder):

| register bucket | split-only | +aug 0.15 | +aug 0.5 |
| --- | --- | --- | --- |
| low-only windows (610) | 45.6% | 39.7% | 36.4% |
| high-only windows (2124) | 61.7% | 54.8% | 49.2% |
| two-hand windows (43,802) | 68.1% | 67.8% | 62.7% |

So it hurts even the case it was designed for. Likely mechanism: masked copies
of *different* songs all land in the sparse one-register region of feature
space, adding confusable prototype mass there, and the extra prototypes amplify
the known prototype-count bias (v2.3). The headroom is also small: only ~6% of
annotated windows are single-register. Conclusion: the augmentation idea is
sound in principle but does not work through the prototype-scoring path. The
flag stays for when one-hand practice is better represented in the annotations;
the default is off.

### Notes

- The `Rebuild Model` button now produces a 38-feature model. The existing
  `data/ml/model.json` (25 features) is rejected at load with a clear error
  until rebuilt.
- `registerDivide` and `handMaskAugmentFraction` are train-time knobs:
  `--register-divide` and `--hand-mask-augment`.

---

## 2026-08-31 — v2.3: segment boundaries, model-load guard, honest eval

### Context

A code review found four silent defects and one accuracy hypothesis. The
hypothesis failed. All numbers below are leave-one-file-out over 48 annotated
files. The failed experiments are recorded because they are expensive to repeat.

### What changed

**Segment boundaries now use window centers.** Training labels a window at its
center: `buildSamplesForFile` calls `getLabelAtTime` at
`startTime + windowSec / 2`. But `windowsToSegments` built spans from the full
window extent. With truth `A=[20,40)` and `B=[40,55)` and correct window labels,
it produced `A=[18,41]` and `B=[38,56]`. Each segment was 3s too long, and each
adjacent pair overlapped by `windowSec - stepSec`. These segments go into
`prediction_reviews`, and then into `annotations`, so the error entered the next
training set. Centers give the correct span. A 7000s file now gives 48 segments
and 0 overlapping pairs.

**`loadModel` rejects a model with a different feature set.** The feature vector
changed from 18 to 25 entries in v2.0. An older `model.json` still loaded, then
produced NaN for every distance. Every NaN comparison is false, so the decoder
returned `__none__` for every window. The user saw 0 segments and no error.
`loadModel` now throws and names the correction.

**Leave-one-out evaluation measures the decoder that the app uses.**
`evaluateLeaveOneOut` used a per-window argmax, with no anchor seeding, no
linking and no `__none__` handling. `ml:train` and `rebuild-model` therefore
reported an accuracy for a path that no caller runs, and disagreed with
`ml:eval`. It now calls `predictWindowsFromSamples`.

**The CLIs report the options that a decoder ignores.** The `anchor` decoder
never reads `minWindowConfidence` or `smoothingWindows`. The `viterbi` decoder
never reads `smoothingWindows`. The README, `ml:predict`, `ml:eval` and the run
endpoint documented both as tuning options, and the eval report recorded them as
if they changed the result. `minWindowConfidence` at 0.0 and at 0.99 gave
identical output. `decoderIgnoredOptions()` now holds this mapping.

**Smaller changes.** The model stores the resolved `TrainConfig`, so a change to
a default does not change an existing model. `allocatePrototypeBudgets` takes
the `__none__` index instead of assuming index 0. `predictLabelIndex` is
removed: its confidence was always 0 in `min` score mode, because every score
there is negative. `trainingSummary.underAnnotatedLabels` lists songs below the
average prototype budget.

### Results

| metric | v2.2 | v2.3 | delta |
| --- | --- | --- | --- |
| window accuracy | 50.91% | 50.91% | 0.00 pt |
| segment recall | 52.48% | 51.26% | -1.22 pt |
| segment precision | 45.05% | 45.43% | +0.37 pt |
| segment F1 | 48.49% | 48.17% | -0.32 pt |
| segments emitted | 361 | 364 | +3 |
| predicted seconds | 37,652 | 36,468 | -1,184 |

**This release does not improve accuracy.** Window accuracy is identical,
because the scoring code is unchanged. Segment F1 decreases by 0.32 pt. The
pipeline is deterministic, so this is a small real decrease, not noise. 16 songs
with 60s or more of annotation still get 0% recall, the same as v2.2.

The 1184s decrease in predicted time is the boundary correction. It removes
about 3s from each of 364 segments. Some of that time covered real annotations,
which is why recall decreases more than precision increases.

The value of this release is correct output and clear error reporting, not accuracy.

### Failed experiments

Prototype budgets scale with sqrt(support). A nearest-prototype distance
decreases as a label gains prototypes, so well-annotated songs win comparisons
they must lose. In a controlled test with two labels from an identical
distribution and 120 against 25 prototypes, the larger label won 81% of the
time instead of 50%. On real data, recall followed prototype count: 53.9% for
songs with 25 or more prototypes, 33.6% for songs below that.

The bias is real. Three corrections failed:

1. **One equal budget for every label**, 54 labels at 22 prototypes. Segment F1
   fell from 48.49% to 37.40%. Window accuracy fell 2.28 pt. Mean segment length
   grew from 104s to 261s. An equal budget discards coverage that
   well-annotated songs need. An equal budget for `__none__` also stops silence
   from competing, so songs extend across it.
2. **Equal budgets for songs, `__none__` exempt.** Segment F1 37.39%. The
   `__none__` budget was not the cause; the loss of per-song coverage was. A
   higher `minSegmentConfidence` did not help: 0.45, 0.55 and 0.65 gave F1
   32.5%, 24.3% and 9.8%. Precision stayed near 30-37% at every value, so the
   segments were wrong, not under-filtered.
3. **Per-label scale calibration.** Divide each label distance by the median
   spacing of its own prototypes. This cancels the count effect in theory, and
   it corrected the controlled test from 81% to 51%. On real data it gave F1
   23.37% and window accuracy 17.18%. Spacing does not separate "few
   prototypes" from "varied class". `__none__` is a varied class, so
   calibration gave it a large advantage and it covered most of the timeline.

Conclusion: sqrt(support) budgeting works as a prior, because a well-annotated
song is both more frequent and more varied. The prototype advantage of
`__none__` works as the song/none decision threshold. A correction must fix
song-against-song comparison without changing the song/none balance and without
reducing per-song coverage. One untried option is a per-label offset calibrated
on held-out windows rather than on prototype geometry.

Two related defects were also corrected, measured, and reverted. Tests now
record both:

- **Anchor and linked windows use different confidence scales.** An anchor keeps
  its raw margin, 0.15 to 0.3. A linked window gets 0.5. `windowsToSegments`
  averages these values against `minSegmentConfidence`, so it discards a segment
  of 20 strong anchors and keeps a segment of 3 anchors and 17 linked windows.
- **The duration limit applies before the merge**, so two adjacent 5s runs of
  one song are both discarded instead of merged into one 10s segment.

Both corrections were part of experiment 1 and could not be separated from its
losses. Each needs its own measurement.

## 2026-08-31 — v2.2: silence gaps as boundary hints + piano-roll markers

### Context

Bookmarks turned out to be rare, so the device's other implicit boundary
signal — `jmxSkip` silence-compression gaps — is the one worth building on.
When the player stops for the configured threshold (3s in the common
configuration) MIDI recording pauses and a `jmxSkip` records the omitted
wall-clock duration. These are far more common.

### Findings

- **Wall-clock gaps ARE encoded**, as `jmxSkip.millis`; playback position is
  the cumulative SMF delta-tick (same coordinates as annotations).
- **The vast majority of recordings** contain skips, vs a couple with bookmarks.
- **Noisy as boundaries**: only ~13-18% of skips sit near an annotation
  boundary; ~25-30% fall inside an annotated span (within-song pauses). Bigger
  gaps are more reliable but never clean, so they are split hints, not truth.

### What changed

- `server/utils/jmxParser.ts` parses `jmxSkip` into `JmxMetadata.skips`
  (`millis`, `timeSec`, optional wall-clock anchors).
- New `files.skips_json` column (migration 005), populated at sync; the
  `db:backfill-bookmarks` script now backfills skips too.
- The prediction pipeline splits segments at each bookmark (always) and at
  silence gaps >= `minSkipSplitSec` (default 30s, configurable via
  `POST /api/prediction-reviews/run` and `--min-skip-split-sec`).
- **Piano-roll visualization** (`PianoRollVisualizer`): device bookmarks render
  as solid green circles and skips >= 8s as green rings at the top edge of the
  roll, matching the Jamcorder device's look, so the user sees device-marked
  boundaries while annotating. `GET /api/files/:id` exposes both arrays.

### Results

No accuracy delta (hints only). Two workflow wins: (1) the ~30s+ silence gaps
now keep predictions from merging across genuine pauses/sessions, and (2) the
piano roll surfaces device boundaries during annotation. The dominant failure
mode remains: most song changes have *no* large gap (rapid transitions), so the
ML model still does most of the work.

---

## 2026-08-31 — v2.1: Jamcorder passage bookmarks as boundary hints

### Context

The v2 model improved generalization but still hallucinated wrong songs in
unannotated tails, and song boundaries remained pure inference. The Jamcorder
device writes `jmxBookmark` meta events when the player triggers a passage
marker — a natural, device-provided segmentation hint. The open question was
whether the device also stores *section names*; it does not (see below).

### Findings

- **Bookmarks exist and parse cleanly.** `jmxBookmark{bookmarkIdx,
  bookmarkUuid, bookmarkSource, unixtime, localOffset}` marks the end of a
  user-selected passage. Position on the playback timeline is the cumulative
  SMF delta-tick (1 ms/tick in JMX), which is the same coordinate system the
  annotations use. Sparse in practice: only a couple of files in the
  calibration library carry any.
- **No section names anywhere.** The JMX spec has no name event, and a raw byte
  scan of recording files found no human-readable song/section-name strings.
  Bookmarks carry no names, so the device cannot supply song names.
- **Bookmarks are not reliable song boundaries.** They have been observed
  sitting in an unannotated tail rather than at annotated song changes. They
  are passage hints, not truth.

### What changed

- `server/utils/jmxParser.ts` now parses `jmxBookmark` and records each
  bookmark's playback `timeSec`.
- New `files.bookmarks_json` column (migration 004), populated at sync for new
  and re-synced files; `npm run db:backfill-bookmarks` backfills the existing
  library.
- `core/timeRanges.ts` gains `splitSegmentsAtTimes`; the prediction pipeline
  (`server/services/predictionImport.ts`) splits predicted segments at each
  bookmark, so device passages become reviewable segments instead of being
  merged across.
- After a sync, newly imported files that carry bookmarks get predictions
  auto-run (`server/services/sync.service.ts`), so the device's passages land
  in the review queue without a manual "Run Predictions" step. Conservative:
  only bookmarked files, only if a model exists, failures never break sync.
- `GET /api/files/:id` and `POST /api/prediction-reviews/run` report bookmarks
  and bookmark-split counts.

### Results

No accuracy delta (bookmarks do not change the model). The win is workflow:
device-marked passages now structure the review queue automatically. Given how
sparse bookmarks are, the signal will matter more as the player uses the
trigger regularly.

### Known limitations

- Bookmarks are rare (2 files) and not validated as song boundaries; they are
  a split hint, so a bookmark in the middle of one song produces two segments
  for the user to merge.
- Section/song names are not available from the device. Auto-annotation still
  needs the ML model to name each passage.

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
  with √support so rare songs still get prototypes; `__none__` gets a hard
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

Concrete: recordings whose ground truth is a single dominant song now come
back as one contiguous, correctly-labeled span (previously they fragmented or
were mislabeled), and `ml:predict-import` fills annotation gaps with the
correct song instead of the wrong ones v1 proposed.

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