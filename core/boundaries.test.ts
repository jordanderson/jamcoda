import { describe, it, expect } from 'vitest';
import {
  detectCadenceAndFlourish,
  snapSegmentBoundaries,
  type BoundaryNote
} from './boundaries';

describe('core/boundaries', () => {
  const chord = (startTime: number, duration: number, pitches: number[]): BoundaryNote[] =>
    pitches.map((pitch) => ({
      pitch,
      startTime,
      endTime: startTime + duration,
      acousticEndSec: startTime + duration
    }));

  const note = (startTime: number, duration: number, pitch = 60): BoundaryNote => ({
    pitch,
    startTime,
    endTime: startTime + duration,
    acousticEndSec: startTime + duration
  });

  describe('detectCadenceAndFlourish', () => {
    it('returns null when no flourish exists', () => {
      const notes = [
        ...chord(10, 2.0, [48, 55, 60, 64]), // C major cadence
      ];
      const result = detectCadenceAndFlourish(0, 12, notes);
      expect(result).toBeNull();
    });

    it('detects cadence chord followed by a rapid multi-octave arpeggio', () => {
      const notes: BoundaryNote[] = [
        ...chord(10.0, 2.5, [36, 48, 55, 60, 64]), // Big cadence chord ending at 12.5s
        // Extraneous flourish notes starting at 12.6s sweeping across 3 octaves
        note(12.6, 0.1, 48),
        note(12.8, 0.1, 52),
        note(13.0, 0.1, 55),
        note(13.2, 0.1, 60),
        note(13.4, 0.1, 64),
        note(13.6, 0.1, 67),
        note(13.8, 0.1, 72),
        note(14.0, 0.1, 76),
        note(14.2, 0.1, 79),
        note(14.4, 0.2, 84)
      ];

      // Segment predicted as 0 to 15s (swallowing the flourish)
      const result = detectCadenceAndFlourish(0, 15.0, notes);
      expect(result).not.toBeNull();
      expect(result!.cadence.timeSec).toBe(10.0);
      expect(result!.flourishNoteCount).toBe(10);
      expect(result!.flourishPitchSpan).toBe(84 - 48); // 36 semitones
      // Trimmed end should be the cadence end (12.5s)
      expect(result!.trimmedEndTime).toBe(12.5);
    });

    it('does not trigger on ordinary multi-voice counterpoint in song body', () => {
      const notes: BoundaryNote[] = [
        ...chord(10.0, 1.0, [48, 52, 55]),
        ...chord(11.0, 1.0, [48, 52, 55]),
        ...chord(12.0, 1.0, [48, 52, 55]),
      ];
      const result = detectCadenceAndFlourish(0, 13.0, notes);
      expect(result).toBeNull();
    });
  });

  describe('snapSegmentBoundaries', () => {
    it('snaps pre-song dead air to first note onset', () => {
      const notes: BoundaryNote[] = [
        note(5.2, 1.0, 60),
        note(6.0, 1.0, 64),
        note(7.0, 2.0, 67)
      ];
      // Segment starts at 4.0 (1.2s before the first note) and ends at 9.0
      const snapped = snapSegmentBoundaries(4.0, 9.0, notes);
      expect(snapped.startTime).toBe(5.2);
      expect(snapped.endTime).toBe(9.0);
    });

    it('snaps trailing silence back to last acoustic release', () => {
      const notes: BoundaryNote[] = [
        note(5.0, 1.0, 60),
        note(6.0, 1.0, 64),
        note(7.0, 1.5, 67) // Ends at 8.5s
      ];
      // Segment ends at 10.0 (1.5s of dead air)
      const snapped = snapSegmentBoundaries(5.0, 10.0, notes);
      expect(snapped.startTime).toBe(5.0);
      expect(snapped.endTime).toBe(8.5);
    });

    it('trims extraneous ending flourish and snaps to cadence end', () => {
      const notes: BoundaryNote[] = [
        note(5.0, 1.0, 60),
        ...chord(10.0, 2.0, [36, 48, 55, 60, 64]), // Cadence ends at 12.0s
        note(12.2, 0.1, 48),
        note(12.4, 0.1, 55),
        note(12.6, 0.1, 60),
        note(12.8, 0.1, 67),
        note(13.0, 0.1, 72),
        note(13.2, 0.1, 79),
        note(13.4, 0.3, 84)
      ];

      // Segment was coarsely predicted as 4.5s to 14.0s
      const snapped = snapSegmentBoundaries(4.5, 14.0, notes);
      expect(snapped.startTime).toBe(5.0); // Snapped from 4.5 to 5.0
      expect(snapped.endTime).toBe(12.0); // Trimmed from 14.0 to 12.0
      expect(snapped.trimmedFlourish).not.toBeNull();
    });

    it('handles empty notes gracefully', () => {
      const snapped = snapSegmentBoundaries(5.0, 10.0, []);
      expect(snapped.startTime).toBe(5.0);
      expect(snapped.endTime).toBe(10.0);
    });
  });
});
