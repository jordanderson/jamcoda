import { readFileSync } from 'fs';
import * as toneMidiPkg from '@tonejs/midi';
import { normalizeJamcorderTempoMap } from '../../lib/midiTempoNormalization';

// Cache for MIDI durations to avoid re-parsing
const durationCache = new Map<string, number>();
const Midi = (
  (toneMidiPkg as any).Midi
  ?? (toneMidiPkg as any).default?.Midi
  ?? (toneMidiPkg as any).default
);

// Export function to clear cache if needed (useful for debugging)
export function clearDurationCache() {
  durationCache.clear();
}

export function getMidiDuration(filePath: string): number {
  // Check cache first
  if (durationCache.has(filePath)) {
    return durationCache.get(filePath)!;
  }

  try {
    const rawBytes = new Uint8Array(readFileSync(filePath));
    const normalizedBytes = normalizeJamcorderTempoMap(rawBytes);
    const midi = new Midi(normalizedBytes);
    const duration = Number.isFinite(midi.duration) ? midi.duration : 0;

    // Cache the result
    durationCache.set(filePath, duration);
    return duration;
  } catch (error) {
    console.error(`Error parsing MIDI file ${filePath}:`, error);
    return 0;
  }
}
