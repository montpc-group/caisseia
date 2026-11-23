/**
 * Event Store append-only avec chainage cryptographique.
 *
 * Cf. COMPLIANCE.md § 1 (Inaltérabilité) et § 2 (Sécurisation).
 *
 * Cœur du système. Toute opération qui doit être inaltérable
 * passe par cet event store. Aucune mise à jour ni suppression
 * n'est exposée publiquement.
 */

import { hash, canonicalize, GENESIS_HASH } from './crypto.js';
import { getActiveStorage } from './storage/index.js';
import { AppendConflictError, type TxOptions } from './storage/EventStorage.js';

const APPEND_MAX_RETRIES = 3;

/**
 * Append un événement à un flux. Calcule
 * le previousHash et le hash propre.
 *
 * @param stream - identifiant du flux ('encaissement', 'jet', 'closure-day', ...)
 * @param workspaceId - identifiant du workspace (multi-tenant)
 * @param payload - données métier de l'événement
 * @param opts - `client` : lecture du dernier maillon, hash et insertion sur la
 *   connexion de l'appelant, dans sa transaction (une seule tentative : un
 *   conflit annule déjà sa transaction, il remonte tel quel)
 * @returns l'enregistrement complet écrit en base
 */
export async function append<T>(
  stream: StreamName,
  workspaceId: string,
  payload: T,
  opts: TxOptions = {},
): Promise<EventRecord<T>> {
  const storage = await getActiveStorage();
  const attempts = opts.client ? 1 : APPEND_MAX_RETRIES;

  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const last = await storage.getLast<T>(workspaceId, stream, opts);
    const sequence = (last?.sequence ?? 0) + 1;
    const previousHash = last?.hash ?? GENESIS_HASH;
    const recordedAt = new Date().toISOString();

    const skeleton = {
      _id: makeRecordId(workspaceId, stream, sequence),
      stream,
      sequence,
      workspaceId,
      previousHash,
      recordedAt,
      payload,
    };
    const ownHash = hash(canonicalize(skeleton));

    try {
      const record = await storage.append<T>({
        workspaceId,
        stream,
        sequence,
        previousHash,
        hash: ownHash,
        recordedAt,
        payload,
      }, opts);
      return record;
    } catch (err) {
      if (err instanceof AppendConflictError && !opts.client) {
        lastErr = err;
        // Concurrent writer claimed our sequence; retry with refreshed previous.
        // (No JET log here to avoid recursion — consumers can observe via metrics.)
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    `NF525_APPEND: failed after ${APPEND_MAX_RETRIES} retries on (workspace=${workspaceId}, stream=${stream})` +
      (lastErr instanceof Error ? `: ${lastErr.message}` : ''),
  );
}

/**
 * Lit un flux complet ou une plage.
 * Lecture uniquement — aucune fonction d'altération exposée.
 */
export async function read<T>(
  stream: StreamName,
  workspaceId: string,
  options: ReadOptions = {},
): Promise<EventRecord<T>[]> {
  const storage = await getActiveStorage();
  return storage.read<T>(
    {
      workspaceId,
      stream,
      from: options.from?.toISOString(),
      to: options.to?.toISOString(),
      fromSequence: options.fromSequence,
      toSequence: options.toSequence,
      limit: options.limit,
    },
    { client: options.client },
  );
}

/**
 * Récupère le dernier enregistrement d'un flux (pour calcul du previousHash).
 */
export async function getLast<T>(
  stream: StreamName,
  workspaceId: string,
  opts: TxOptions = {},
): Promise<EventRecord<T> | null> {
  const storage = await getActiveStorage();
  return storage.getLast<T>(workspaceId, stream, opts);
}

/**
 * Exécute `fn` en tenant le verrou d'écriture du flux (workspace, stream) :
 * une lecture-vérification-écriture faite dans `fn` devient une seule étape
 * sérialisée par flux. Avec `opts.client`, le verrou est pris dans la
 * transaction de l'appelant ; sans, le SDK ouvre sa propre transaction et
 * passe son client à `fn`.
 */
export async function withStreamLock<R>(
  stream: StreamName,
  workspaceId: string,
  fn: (opts: TxOptions) => Promise<R>,
  opts: TxOptions = {},
): Promise<R> {
  const storage = await getActiveStorage();
  return storage.withStreamLock(workspaceId, stream, fn, opts);
}

function makeRecordId(workspaceId: string, stream: StreamName, sequence: number): string {
  return `${workspaceId}:${stream}:${sequence.toString().padStart(12, '0')}`;
}

// ─── Types ────────────────────────────────────────────────────────────

export type StreamName =
  | 'encaissement'    // Encaissements et corrections
  | 'jet'             // Journal d'Événements Techniques
  | 'closure-day'     // Clôtures journalières
  | 'closure-month'   // Clôtures mensuelles
  | 'closure-year';   // Clôtures annuelles

export interface EventRecord<T> {
  /** Identifiant unique de l'enregistrement (déterministe : workspace:stream:sequence). */
  _id: string;
  /** Nom du flux. */
  stream: StreamName;
  /** Numéro de séquence dans le flux (1, 2, 3, ...). */
  sequence: number;
  /** Identifiant du workspace (multi-tenant). */
  workspaceId: string;
  /** Hash de l'enregistrement précédent dans ce flux (ou GENESIS_HASH). */
  previousHash: string;
  /** Hash propre de cet enregistrement (calculé sur previousHash + payload). */
  hash: string;
  /** Date d'écriture (UTC, ISO 8601). */
  recordedAt: string;
  /** Payload métier. */
  payload: T;
}

export interface ReadOptions {
  /** Read on the caller's connection, inside its transaction. */
  client?: TxOptions['client'];
  from?: Date;
  to?: Date;
  fromSequence?: number;
  toSequence?: number;
  limit?: number;
}
