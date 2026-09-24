import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { normalizeJamcorderUrl, readConfig, writeConfig } from './config';

test('normalizeJamcorderUrl accepts hosts and http(s) origins', () => {
  assert.equal(normalizeJamcorderUrl('jamcorder.local'), 'http://jamcorder.local');
  assert.equal(normalizeJamcorderUrl(' 192.168.1.20:8080 '), 'http://192.168.1.20:8080');
  assert.equal(normalizeJamcorderUrl('https://jamcorder.local/'), 'https://jamcorder.local');
  assert.equal(normalizeJamcorderUrl('HTTP://Jamcorder.Local'), 'http://jamcorder.local');
});

test('normalizeJamcorderUrl rejects anything that is not a bare origin', () => {
  assert.equal(normalizeJamcorderUrl(''), null);
  assert.equal(normalizeJamcorderUrl('file:///etc/passwd'), null);
  assert.equal(normalizeJamcorderUrl('javascript://x'), null);
  assert.equal(normalizeJamcorderUrl('http://jamcorder.local/api'), null);
  assert.equal(normalizeJamcorderUrl('http://user:pw@jamcorder.local'), null);
  assert.equal(normalizeJamcorderUrl('http://jamcorder.local?x=1'), null);
  assert.equal(normalizeJamcorderUrl('http://'), null);
});

test('config round-trips, and a bad stored value falls back to the default', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jamcoda-config-'));
  try {
    assert.equal(readConfig(dir).jamcorderUrl, 'http://jamcorder.local');
    writeConfig(dir, { jamcorderUrl: 'http://10.0.0.5' });
    assert.equal(readConfig(dir).jamcorderUrl, 'http://10.0.0.5');
    writeFileSync(path.join(dir, 'jamcoda-config.json'), '{"jamcorderUrl":"file:///x"}');
    assert.equal(readConfig(dir).jamcorderUrl, 'http://jamcorder.local');
    writeFileSync(path.join(dir, 'jamcoda-config.json'), '{not json');
    assert.equal(readConfig(dir).jamcorderUrl, 'http://jamcorder.local');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('libraryDir round-trips and ignores a relative path', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jamcoda-config-'));
  try {
    const library = path.join(dir, 'library');
    writeConfig(dir, { jamcorderUrl: 'http://jamcorder.local', libraryDir: library });
    assert.equal(readConfig(dir).libraryDir, library);
    writeFileSync(path.join(dir, 'jamcoda-config.json'), '{"libraryDir":"relative/data"}');
    assert.equal(readConfig(dir).libraryDir, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
