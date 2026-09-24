import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { classifyLibraryFolder } from './library';

test('classifyLibraryFolder tells a library from an empty or unrelated folder', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jamcoda-library-'));
  try {
    writeFileSync(path.join(dir, '.DS_Store'), '');
    assert.equal(classifyLibraryFolder(dir), 'empty');
    writeFileSync(path.join(dir, 'notes.txt'), '');
    assert.equal(classifyLibraryFolder(dir), 'other');
    writeFileSync(path.join(dir, 'jamcoda.db'), '');
    assert.equal(classifyLibraryFolder(dir), 'library');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
