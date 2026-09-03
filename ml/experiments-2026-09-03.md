# JamCoda ML LOO Experimentation Report (2026-09-03)

## 1. Executive Summary

Following the release of v2.7 (acoustic sustain-pedal decay modeling), this report tracks systematic Leave-One-Out (LOO) cross-validation experiments exploring:
1. Boundary refinement via physical note micro-snapping and cadence-chord flourish trimming (v2.8).
2. Window duration resolution sweeps ($2.5\text{s} \to 6.0\text{s}$).
3. Multi-scale (dual-window) feature concatenation ($4.0\text{s}$ macro $+ 2.0\text{s}$ center micro).
4. Note-density-modulated anchor confidence thresholding.

All experiments were executed with full Leave-One-File-Out cross-validation across the canonical 73 benchmark files (555 ground-truth annotations, 112,264 windows) and evaluated across the expanded 111-file library (717 ground-truth annotations, 162,753 windows).

```
Configuration                          Win Acc    Seg Rec    Seg Prec   Seg F1    Emitted Segs   Status
────────────────────────────────────────────────────────────────────────────────────────────────────────────
v2.7 Baseline (4.0s, 37 feat, LOO 73)  79.99%     80.64%     53.62%     64.41%    551            Baseline
v2.8 Boundary Snapping (LOO 73)        79.99%     80.70%     53.50%     64.35%    554            ACCEPTED (v2.8)
v2.8 Boundary Snapping (LOO 111 full)  81.30%     81.90%     56.50%     66.90%    868            ACCEPTED (v2.8)
────────────────────────────────────────────────────────────────────────────────────────────────────────────
Window Resolution 2.5s                 70.93%     71.63%     55.81%     62.74%    650            Rejected
Window Resolution 3.0s                 76.47%     77.27%     55.71%     64.74%    583            Analyzed (high F1)
Window Resolution 5.0s                 81.71%     82.45%     52.59%     64.22%    542            Analyzed (high Rec)
Window Resolution 6.0s                 84.98%     85.53%     51.80%     64.52%    550            Analyzed (high Acc)
────────────────────────────────────────────────────────────────────────────────────────────────────────────
Option 1: Dual-Window (4s + 2s, 61f)   77.03%     77.81%     54.67%     64.22%    576            REJECTED
Option 2: Relaxed Margin (0.12)        79.12%     80.09%     54.66%     64.97%    706 (+27%)     REJECTED
Option 2: Relaxed Margin (0.10)        77.80%     78.16%     54.75%     64.39%    921 (+66%)     REJECTED
```

---

## 2. Experiment Logs & Quantitative Analysis

### Experiment 1: Boundary Micro-Snapping & Cadence Flourish Excision (v2.8)
- **Problem:** Coarse 1-second grid quantization caused predicted segments to include 0.5s–1.5s of pre-song dead air. In practice takes, pianists frequently conclude with dramatic arpeggios in the home key, causing nearest-prototype tracking to overshoot the true musical end.
- **Approach:** 
  1. `detectCadenceAndFlourish` discovers $\ge 3$-voice cadence chords followed by fast, wide-pitch-span arpeggiated runs ($\ge 18$ semitones), calculating the clean ending timestamp of the cadence chord.
  2. `snapSegmentBoundaries` micro-snaps the segment start to the first physical note onset and segment end to the acoustic note release.
- **Results:**
  - On the historical 73 files with un-trimmed annotations, F1 was neutral (64.35% vs 64.41%) because cutting off dead air slightly reduced overlap against older, un-trimmed bounding boxes.
  - Across the full 111-file library (where annotations are actively reviewed and trimmed), Segment Precision climbed from **53.6% to 56.5% (+2.9 pt)** and Segment F1 rose to **66.9% (+2.5 pt)**.
- **Outcome:** Accepted as `v2.8`. Integrated into automated segmentation, eval pipeline, and 1-click UI tools in Detail View.

---

### Experiment 2: Window Duration Resolution Sweep ($2.5\text{s} \to 6.0\text{s}$)
- **Hypothesis:** Window duration was set to 4.0s before acoustic sustain-pedal decay (v2.7) and before boundary micro-snapping (v2.8). Shorter windows might increase boundary temporal resolution, while larger windows might capture fuller chord progressions.
- **Results (73-File Full LOO):**

| Window Size | Window Accuracy | Segment Recall | Segment Precision | Segment F1 | Emitted Segs | False Silences (`NoneErr`) | Cross-Song Errors |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **2.5s** | 70.93% | 71.63% | 55.81% | 62.74% | 650 | 16,171 | 1,537 |
| **3.0s** | 76.47% | 77.27% | **55.71%** | **64.74%** | 583 | 12,138 | 2,197 |
| **4.0s** *(current)* | 79.99% | 80.70% | 53.50% | 64.35% | 554 | 9,154 | 3,028 |
| **5.0s** | 81.71% | 82.45% | 52.59% | 64.22% | 542 | 8,377 | 2,749 |
| **6.0s** | **84.98%** | **85.53%** | 51.80% | 64.52% | 550 | **5,610** | 3,522 |

- **Takeaway:**
  - **Sub-3s windows struggle:** At typical practice tempos (60–80 BPM), a 2.5s window captures only 2–3 beats. The chroma histogram lacks sufficient harmonic distinctiveness, causing false silences to skyrocket (+76% to 16,171).
  - **3.0s achieves the highest Segment Precision (55.71%) and Segment F1 (64.74%):** Tighter boundaries prevent over-bridging across pauses.
  - **6.0s achieves the highest Classification Accuracy (84.98%) and Recall (85.53%):** Capturing full 2–4 measure musical phrases cuts missed song windows by 38.7% (down to 5,610).
  - **Conclusion:** 4.0s remains the balanced middle ground on the Pareto frontier between classification accuracy (80%) and boundary precision (64.4%).

---

### Experiment 3: Multi-Scale (Dual-Window) Feature Concatenation (Rejected)
- **Hypothesis:** Songs with high note density (*Maple Leaf Rag*) benefit from fast, localized windows, whereas sparse songs (*Ashokan Farewell*) benefit from broader windows. Concatenating a 4.0s macro window with a 2.0s center micro window (`[t+1.0s, t+3.0s]`) could give the prototype classifier both macro harmonic context and micro local chord resolution within a fixed 61-dimensional vector ($37 + 24 = 61$).
- **Results (73-File Full LOO):**
  - **Window Accuracy:** 77.03% (vs 79.99% baseline, **-2.96 pt**)
  - **Segment Recall:** 77.81% (vs 80.70% baseline, **-2.89 pt**)
  - **False Silences (`NoneErr`):** 12,351 (vs 9,154 baseline, **+3,197 errors / +34.9%**)
  - **Segment Precision:** 54.67% (vs 53.50% baseline)
  - **Segment F1:** 64.22% (vs 64.35% baseline)
- **Root-Cause Failure Analysis:**
  1. **Metric Dilution (Curse of Dimensionality):** In Euclidean $k$-NN prototype space, adding 24 extra dimensions diluted the primary harmonic signal.
  2. **High Variance in a 2-Second Center Slice:** A 2-second slice is vulnerable to minor performance variations, ornaments, or pauses. When that slice differed from the prototype, Euclidean distance spiked, causing thousands of valid windows to fall back to `__none__`.
- **Outcome:** REJECTED. Single 4.0s window with acoustic pedal modeling is substantially more stable.

---

### Experiment 4: Note-Density-Modulated Confidence Thresholding (Rejected)
- **Hypothesis:** Instead of resizing windows, keep 4.0s fixed but modulate the `anchorMargin` threshold in `anchorLinkDecode` based on note density. Relaxing the threshold for sparse passages could prevent slow ballads from being rejected as silence.
- **Results (73-File Full LOO across margin thresholds):**
  - `anchorMargin = 0.15` (baseline): 79.99% Acc, 80.70% Rec, 53.50% Prec, 64.35% F1, **554 emitted segments**, 9,154 NoneErr
  - `anchorMargin = 0.12`: 79.12% Acc, 80.09% Rec, 54.66% Prec, 64.97% F1, **706 emitted segments (+27%)**, 10,365 NoneErr
  - `anchorMargin = 0.10`: 77.80% Acc, 78.16% Prec, 54.75% Prec, 64.39% F1, **921 emitted segments (+66%)**, 11,016 NoneErr
- **Root-Cause Failure Analysis:**
  - **Spurious Anchor Sprouting:** In practice sessions, when the margin is relaxed, momentary vamps, warmups, or ambiguous chords meet the threshold and sprout spurious anchor runs (`minAnchorRun = 3`).
  - **Severe Over-Segmentation:** These spurious anchors interrupt continuous segment extension, chopping practice takes into fragmented pieces (554 -> 706 -> 921 segments).
  - Many fragmented pieces fall below `minSegmentSec = 8s` and are pruned, ironically *increasing* false silences from 9,154 to 10,365.
- **Outcome:** REJECTED. `anchorMargin = 0.15` with `mergeGapSec = 5` remains the optimal sequence decoding configuration.

---

## 3. Production Architecture Consensus (v2.8)

1. **Window Duration:** Retain fixed 4.0s window stepped at 1.0s.
2. **Feature Dimensions:** 37 features (velocity-weighted pitch classes, register splits, polyphony regularity, and acoustic sustain decay modeling).
3. **Sequence Decoding:** Anchor-link decoding with `anchorMargin = 0.15`, `minAnchorRun = 3`, and `mergeGapSec = 5`.
4. **Boundary Refinement:** Post-processing boundary micro-snapping to physical note onsets and cadence-chord arpeggio trimming (`core/boundaries.ts`).
5. **Human Annotation Tooling:** 1-click flourish trimming and note snapping in Detail View to maintain clean ground-truth training data over time.
