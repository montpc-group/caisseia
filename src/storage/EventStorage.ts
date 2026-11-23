/**
 * EventStorage — persistence adapter contract for the event store.
 *
 * The contract is intentionally narrow: append, read, getLast, count, assertSchema.
 * No update. No delete. No "rewrite". Inalterability is contractual at this layer
 * and (for the Postgres adapter) structurally enforced at the DB level via REVOKE
 * and BEFORE-trigger (see migrations/001_initial.sql).
 *
 * Implementations: InMemoryStorage (tests), PostgresStorage (dev + prod).
 */

import type { PoolClient } from 'pg';
import type { StreamName, EventRecord } from '../eventStore.js';

/**
 * Run a storage call on the caller's connection, inside the caller's
 * transaction (Postgres). The SDK never begins, commits or releases it.
 * Adapters without transactions (InMemoryStorage) ignore it.
 */
export interface TxOptions {
  client?: PoolClient;
}

export interface AppendInput<T> {
  workspaceId: string;
  stream: StreamName;
  sequence: number;
  previousHash: string;
  hash: string;
  recordedAt: string;
  payload: T;
}

export interface ReadFilter {
  workspaceId: string;
  stream: StreamName;
  /** ISO-8601 inclusive lower bound on `recordedAt`. */
  from?: string;
  /** ISO-8601 inclusive upper bound on `recordedAt`. */
  to?: string;
  /** Inclusive lower bound on `sequence` (1-based). */
  fromSequence?: number;
  /** Inclusive upper bound on `sequence`. */
  toSequence?: number;
  /** Cap on number of returned records. Adapter must still order by sequence ASC. */
  limit?: number;
}

export interface EventStorage {
  /**
   * Persist a single event record. Must enforce uniqueness on
   * (workspaceId, stream, sequence) — a duplicate is a fatal append-conflict
   * the caller will retry.
   */
  append<T>(input: AppendInput<T>, opts?: TxOptions): Promise<EventRecord<T>>;

  /** Read events ordered by `sequence` ASC. */
  read<T>(filter: ReadFilter, opts?: TxOptions): Promise<EventRecord<T>[]>;

  /**
   * Last record of a stream — or null if the stream is empty.
   * With `opts.client` this is the read-for-append of a caller transaction:
   * the adapter serializes appenders of (workspaceId, stream) until that
   * transaction ends, so the sequence it returns cannot be taken meanwhile.
   */
  getLast<T>(workspaceId: string, stream: StreamName, opts?: TxOptions): Promise<EventRecord<T> | null>;

  /**
   * Run `fn` holding the (workspaceId, stream) append lock, so a read-check-
   * append done inside `fn` is one serialized step per stream.
   * With `opts.client`: the lock is taken on the caller's connection and held
   * until the caller's transaction ends; `fn` gets `opts` back.
   * Without: the adapter runs `fn` in its own transaction (Postgres: BEGIN,
   * lock, `fn({ client })`, COMMIT — ROLLBACK if `fn` throws).
   */
  withStreamLock<R>(
    workspaceId: string,
    stream: StreamName,
    fn: (opts: TxOptions) => Promise<R>,
    opts?: TxOptions,
  ): Promise<R>;

  /** Count records matching the filter (no limit applied). */
  count(filter: Omit<ReadFilter, 'limit'>): Promise<number>;

  /** Assert that the underlying store has the expected schema and constraints applied. */
  assertSchema(): Promise<void>;

  /** Release any resources (DB pool, etc.). Idempotent. */
  close(): Promise<void>;
}

/** Thrown when an append violates the unique-sequence constraint (concurrent writer). */
export class AppendConflictError extends Error {
  constructor(
    public readonly workspaceId: string,
    public readonly stream: StreamName,
    public readonly sequence: number,
    cause?: unknown,
  ) {
    super(
      `NF525_APPEND_CONFLICT: concurrent write on (workspace=${workspaceId}, stream=${stream}, sequence=${sequence})`,
    );
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

/** Thrown by the adapter / trigger when something tried to mutate an existing row. */
export class InalterableViolationError extends Error {
  constructor(message: string) {
    super(`NF525_INALTERABLE: ${message}`);
  }
}
