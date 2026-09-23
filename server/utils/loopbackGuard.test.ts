import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { test } from 'vitest';
import { loopbackGuard } from './loopbackGuard';

const PORT = 47831;

function run(headers: Record<string, string>): number | 'next' {
  let status: number | 'next' = 'next';
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json() {
      return this;
    }
  } as unknown as Response;
  loopbackGuard(PORT)({ headers } as Request, res, () => {});
  return status;
}

test('admits same-origin requests over loopback', () => {
  assert.equal(run({ host: `127.0.0.1:${PORT}` }), 'next');
  assert.equal(run({ host: `localhost:${PORT}` }), 'next');
  assert.equal(run({ host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}` }), 'next');
});

test('rejects a rebound hostname', () => {
  assert.equal(run({ host: `evil.example:${PORT}` }), 403);
  assert.equal(run({ host: `127.0.0.1:${PORT + 1}` }), 403);
  assert.equal(run({}), 403);
});

test('rejects a cross-site origin', () => {
  assert.equal(run({ host: `127.0.0.1:${PORT}`, origin: 'https://evil.example' }), 403);
  assert.equal(run({ host: `127.0.0.1:${PORT}`, origin: 'http://localhost:5173' }), 403);
  assert.equal(run({ host: `127.0.0.1:${PORT}`, origin: 'null' }), 403);
});
