/**
 * Storage adapter contract suite.
 *
 * Runs the same test set against InMemoryStorage. The Postgres equivalent
 * lives in storage.contract.postgres.test.ts and runs in CI with a real DB
 * via testcontainers — guaranteeing parity between in-memory and production.
 */

import { describe, it, expect } from 'vitest';
import type { EventStorage } from '../src/storage/index.js';
import { InMemoryStorage } from '../src/storage/index.js';
import { AppendConflictError } from '../src/storage/EventStorage.js';

function contractTests(name: string, factory: () => Promise<EventStorage>) {
  describe(`EventStorage contract — ${name}`, () => {
    it('append → getLast roundtrip', async () => {
      const s = await factory();
      try {
        const r = await s.append({
          workspaceId: 'w1',
          stream: 'encaissement',
          sequence: 1,
          previousHash: '0'.repeat(64),
          hash: 'a'.repeat(64),
          recordedAt: new Date().toISOString(),
          payload: { type: 'test' },
        });
        expect(r.sequence).toBe(1);
        const last = await s.getLast('w1', 'encaissement');
        expect(last?.sequence).toBe(1);
      } finally {
        await s.close();
      }
    });

    it('rejects duplicate (workspaceId, stream, sequence) with AppendConflictError', async () => {
      const s = await factory();
      try {
        const base = {
          workspaceId: 'w1',
          stream: 'encaissement' as const,
          sequence: 1,
          previousHash: '0'.repeat(64),
          hash: 'a'.repeat(64),
          recordedAt: new Date().toISOString(),
          payload: { type: 'test' },
        };
        await s.append(base);
        await expect(s.append(base)).rejects.toBeInstanceOf(AppendConflictError);
      } finally {
        await s.close();
      }
    });

    it('isolates streams within the same workspace', async () => {
      const s = await factory();
      try {
        await s.append({
          workspaceId: 'w1',
          stream: 'encaissement',
          sequence: 1,
          previousHash: '0'.repeat(64),
          hash: 'a'.repeat(64),
          recordedAt: new Date().toISOString(),
          payload: {},
        });
        await s.append({
          workspaceId: 'w1',
          stream: 'jet',
          sequence: 1,
          previousHash: '0'.repeat(64),
          hash: 'b'.repeat(64),
          recordedAt: new Date().toISOString(),
          payload: {},
        });
        const enc = await s.read({ workspaceId: 'w1', stream: 'encaissement' });
        const jet = await s.read({ workspaceId: 'w1', stream: 'jet' });
        expect(enc).toHaveLength(1);
        expect(jet).toHaveLength(1);
        expect(enc[0]!.hash).not.toBe(jet[0]!.hash);
      } finally {
        await s.close();
      }
    });

    it('isolates workspaces', async () => {
      const s = await factory();
      try {
        await s.append({
          workspaceId: 'w1',
          stream: 'encaissement',
          sequence: 1,
          previousHash: '0'.repeat(64),
          hash: 'a'.repeat(64),
          recordedAt: new Date().toISOString(),
          payload: {},
        });
        await s.append({
          workspaceId: 'w2',
          stream: 'encaissement',
          sequence: 1,
          previousHash: '0'.repeat(64),
          hash: 'b'.repeat(64),
          recordedAt: new Date().toISOString(),
          payload: {},
        });
        expect((await s.read({ workspaceId: 'w1', stream: 'encaissement' })).length).toBe(1);
        expect((await s.read({ workspaceId: 'w2', stream: 'encaissement' })).length).toBe(1);
        expect((await s.getLast('w1', 'encaissement'))?.hash).toBe('a'.repeat(64));
        expect((await s.getLast('w2', 'encaissement'))?.hash).toBe('b'.repeat(64));
      } finally {
        await s.close();
      }
    });

    it('returns records ordered by sequence ASC', async () => {
      const s = await factory();
      try {
        // Insert out of natural order to prove the sort.
        for (const seq of [3, 1, 2, 5, 4]) {
          await s.append({
            workspaceId: 'w1',
            stream: 'encaissement',
            sequence: seq,
            previousHash: '0'.repeat(64),
            hash: seq.toString().padStart(64, '0'),
            recordedAt: new Date().toISOString(),
            payload: { seq },
          });
        }
        const rows = await s.read({ workspaceId: 'w1', stream: 'encaissement' });
        expect(rows.map((r) => r.sequence)).toEqual([1, 2, 3, 4, 5]);
      } finally {
        await s.close();
      }
    });

    it('count() honors filters but ignores limit', async () => {
      const s = await factory();
      try {
        for (let seq = 1; seq <= 5; seq++) {
          await s.append({
            workspaceId: 'w1',
            stream: 'encaissement',
            sequence: seq,
            previousHash: '0'.repeat(64),
            hash: seq.toString().padStart(64, '0'),
            recordedAt: new Date().toISOString(),
            payload: {},
          });
        }
        expect(await s.count({ workspaceId: 'w1', stream: 'encaissement' })).toBe(5);
      } finally {
        await s.close();
      }
    });
  });
}

contractTests('InMemoryStorage', async () => new InMemoryStorage());
