/**
 * Plain-language notes for every setting the Prediction Lab exposes.
 *
 * Each one says what the setting does, which way to move it, and — where the
 * library has actually been measured — what that measurement was, so a number
 * in a box is not a guess. Figures come from `ml/CHANGELOG.md` and
 * `experiments-2026-09-06-linking.md` (kept locally under `data/ml/notes/`).
 */

export interface SettingHelp {
  title: string
  /** What it does, then how to move it, then anything measured. */
  body: string[]
}

export const SETTING_HELP: Record<string, SettingHelp> = {
  minSegmentSec: {
    title: 'Min segment',
    body: [
      'The shortest span the model is allowed to call a song. Anything shorter is discarded after decoding. Default 8 seconds.',
      'Raise it if you are getting stray few-second fragments between real takes. Lower it if genuinely short takes — a fragment of a tune, a false start worth logging — are disappearing.'
    ]
  },
  mergeGapSec: {
    title: 'Merge gap',
    body: [
      'Two neighbouring predictions of the same song less than this far apart are joined into one. Default 5 seconds.',
      'Raise it if one take keeps arriving in pieces. Lower it if two separate takes of the same song keep being glued together — though that is usually better fixed in decoding than here.'
    ]
  },
  minWindowConfidence: {
    title: 'Min window confidence',
    body: [
      'Not used by the anchor decoder, which is the default and almost certainly what this model uses. With an anchor model this field changes nothing.',
      'It applies to the viterbi and smooth decoders, where a window scoring below this is left unlabelled.'
    ]
  },
  smoothingWindows: {
    title: 'Smoothing',
    body: [
      'Not used by the anchor decoder (the default), and ignored by viterbi as well. With an anchor model this field changes nothing.',
      'For the smooth decoder it is the width of the median filter run across per-window labels, which removes one-off flickers.'
    ]
  },
  minSegmentConfidence: {
    title: 'Min segment confidence',
    body: [
      'A finished segment whose average window confidence falls below this is dropped. Default 0.3.',
      'Confidence here is the anchor margin — how far the winning song outscored the runner-up — so this removes spans the model was never really sure about. Raise it for fewer, safer predictions; lower it to see everything the model produced.'
    ]
  },

  linkPolicy: {
    title: 'Link policy',
    body: [
      'How the ambiguous stretches between takes — warm-up, noodling, talking — get attached to a song.',
      'legacy: any window that is not confidently something else joins whichever song reaches it first, with no limit. Runs extend in recording order, so the earlier song claims the whole gap. This is why a finished take tends to run past its ending and the next one starts late.',
      'bridge: a stretch is linked freely only when the same song is anchored on both sides of it, which means it sits inside one take. Past a song’s outermost anchor the run gets a short leash, and two competing songs advance in step so they meet in the middle instead of the earlier one taking everything. A second pass then hands leftover stretches back to a neighbouring song when the evidence across the whole stretch supports it.',
      'bridge is the default a new model is trained with. Measured over 103 fully annotated files: the median ending error falls from +5.85s to +0.81s and complete-file F1 rises 2.17 points, recognizing four more takes.',
      'Empty means whatever this model was trained with — legacy for a model built before 2026-09-07.'
    ]
  },
  anchorMargin: {
    title: 'Anchor margin',
    body: [
      'How far ahead the winning song must score before a window can seed a segment, measured as (top − runner-up) ÷ (|top| + |runner-up|). Default 0.15.',
      'Raise it to demand clearer evidence: fewer segments, more confident ones. Lower it to pick up songs the model only weakly recognizes, at the cost of more false starts.'
    ]
  },
  minAnchorRun: {
    title: 'Min anchor run',
    body: [
      'How many consecutive confident windows are needed before a segment can start. Default 3, which at the one-second window step means three seconds of agreement.',
      'Raise it to suppress momentary confusions. Lower it to catch very short takes — at 2 the library scored slightly higher, but with more spurious starts.'
    ]
  },
  linkMaxSilenceRatio: {
    title: 'Max link silence',
    body: [
      'A window whose silence ratio is at or above this cannot be joined to a neighbouring song, so a real pause acts as a barrier. Default 0.7; 1 disables the rule.',
      'Lower it to make a song stop sooner at quiet passages. Raise it to link across rests, at the risk of carrying a take through the gap before the next one.',
      'It does not catch the usual overrun: the stretch between takes is normally full of playing, not silence.'
    ]
  },
  fillTopK: {
    title: 'Fill top-K',
    body: [
      'Requires the song to be among the top K scorers in every window it links, rather than only "nothing else is confident". Default -1, which turns the test off.',
      'Small values keep predictions tight but fragment long takes, because the test also applies to quiet passages inside a take: at K=3 the library split into 852 segments instead of 532.',
      'Bridge linking’s rescue rank does this job better, judging a whole stretch at once instead of one window at a time.'
    ]
  },
  linkTailSec: {
    title: 'Tail leash',
    body: [
      'Bridge linking only. How many seconds a song may keep running past its last confident window before it has to be the model’s own top choice to continue. Default 2.',
      'A take’s own ending is short — a median 3.6 seconds past its last anchor — so a short leash is what stops one song running into the next.',
      'Not a delicate setting: everything from 1 to 12 seconds scored within a point of F1 on the library.'
    ]
  },
  linkRescueRank: {
    title: 'Rescue rank',
    body: [
      'Bridge linking only. After leashing, an unlabelled stretch is handed back to a neighbouring song when that song’s average rank across the whole stretch is at most this. Default 5; -1 switches the pass off.',
      'Inside a take a song sits at a median rank of 1.3 even where it never wins a single window; in the dead air between takes it falls to 16. Five sits in the gap between those.',
      'Raise it to recover more coverage, lower it to keep predictions tight. A stretch with the same song on both sides is always skipped — that is the break between two takes of it, and joining them would merge the takes.'
    ]
  }
}
