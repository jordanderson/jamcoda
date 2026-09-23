import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, test } from 'vitest';
import { transaction } from './transaction';

let db: DatabaseSync;

function names(): string[] {
  return (db.prepare('SELECT name FROM t ORDER BY name').all() as unknown as Array<{ name: string }>)
    .map((row) => row.name);
}

function insert(name: string): void {
  db.prepare('INSERT INTO t (name) VALUES (?)').run(name);
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (name TEXT NOT NULL UNIQUE)');
});

test('commits and returns the result', () => {
  const tx = transaction(db, (a: string, b: string) => {
    insert(a);
    insert(b);
    return 2;
  });
  assert.equal(tx('a', 'b'), 2);
  assert.deepEqual(names(), ['a', 'b']);
  assert.equal(db.isTransaction, false);
});

test('rolls back everything and rethrows when the function throws', () => {
  const tx = transaction(db, () => {
    insert('a');
    insert('a');
  });
  assert.throws(() => tx(), /UNIQUE/);
  assert.deepEqual(names(), []);
  assert.equal(db.isTransaction, false);
});

test('a nested failure rolls back only the inner work', () => {
  const inner = transaction(db, () => {
    insert('inner');
    throw new Error('inner failed');
  });
  const outer = transaction(db, () => {
    insert('outer');
    assert.throws(() => inner(), /inner failed/);
    insert('after');
  });
  outer();
  assert.deepEqual(names(), ['after', 'outer']);
});

test('an outer failure rolls back committed inner work', () => {
  const inner = transaction(db, () => insert('inner'));
  const outer = transaction(db, () => {
    inner();
    throw new Error('outer failed');
  });
  assert.throws(() => outer(), /outer failed/);
  assert.deepEqual(names(), []);
  assert.equal(db.isTransaction, false);
});
