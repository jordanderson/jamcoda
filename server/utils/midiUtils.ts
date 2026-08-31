import { readFileSync } from 'fs';
import { parseNoteSequence } from '@core/midi/noteSequence';

// Cache for MIDI durations to avoid re-parsing
const durationCache = new Map<string, number>();

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
    const sequence = parseNoteSequence(new Uint8Array(readFileSync(filePath)));
    const duration = Number.isFinite(sequence.totalTime) ? sequence.totalTime : 0;

    // Cache the result
    durationCache.set(filePath, duration);
    return duration;
  } catch (error) {
    console.error(`Error parsing MIDI file ${filePath}:`, error);
    return 0;
  }
}
