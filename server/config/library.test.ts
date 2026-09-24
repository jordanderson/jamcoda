import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'vitest';
import {
  libraryDir,
  libraryModelPath,
  libraryRelativeFromLegacy,
  resolveStoredMidiPath,
  toStoredMidiPath
} from './library';

const db = path.resolve('/lib/jamcoda.db');

test('library paths all sit beside the database', () => {
  assert.equal(libraryDir(db), path.resolve('/lib'));
  assert.equal(libraryModelPath(db), path.resolve('/lib/ml/model.json'));
  assert.equal(resolveStoredMidiPath('midi/2025-10-14/a.mid', db), path.resolve('/lib/midi/2025-10-14/a.mid'));
  assert.equal(toStoredMidiPath(path.resolve('/lib/midi/2025-10-14/a.mid'), db), 'midi/2025-10-14/a.mid');
});

test('legacy paths reduce to the library-relative form', () => {
  assert.equal(
    libraryRelativeFromLegacy('/Users/me/Library/Application Support/JamCoda/data/midi/2025-10-14/Jmx-A00001.mid'),
    'midi/2025-10-14/Jmx-A00001.mid'
  );
  assert.equal(libraryRelativeFromLegacy('data/midi/2025-10-14/a_1.mid'), 'midi/2025-10-14/a_1.mid');
  assert.equal(libraryRelativeFromLegacy('midi/2025-10-14/a.mid'), 'midi/2025-10-14/a.mid');
  assert.equal(libraryRelativeFromLegacy('C:\\Users\\me\\data\\midi\\2025-10-14\\a.mid'), 'midi/2025-10-14/a.mid');
  assert.equal(libraryRelativeFromLegacy('/music/midi/x/data/midi/2025-10-14/a.mid'), 'midi/2025-10-14/a.mid');
});

test('a path with no midi directory is not guessed at', () => {
  assert.equal(libraryRelativeFromLegacy('/recordings/2025-10-14/a.mid'), null);
  assert.equal(libraryRelativeFromLegacy('a.mid'), null);
  assert.equal(libraryRelativeFromLegacy('/data/midi/'), null);
});
