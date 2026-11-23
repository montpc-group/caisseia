/**
 * Environment variables: `CAISSEIA_<NAME>`, with `NF525_<NAME>` kept as a
 * deprecated fallback (one warning per old name per process). Error codes,
 * the `nf525_event` table and its triggers keep their NF525 names.
 */

export type EnvName =
  | 'DATABASE_URL'
  | 'STORAGE'
  | 'SIGNER'
  | 'SIGNING_KEY_PATH'
  | 'SIGNING_KEY_VERSION'
  | 'KEY_REGISTRY_PATH'
  | 'SKIP_POSTGRES';

const warned = new Set<EnvName>();

export function readEnv(name: EnvName): string | undefined {
  const current = process.env[`CAISSEIA_${name}`];
  if (current !== undefined) return current;
  const old = process.env[`NF525_${name}`];
  if (old !== undefined && !warned.has(name)) {
    warned.add(name);
    process.emitWarning(`NF525_${name} is deprecated: use CAISSEIA_${name}.`, {
      code: 'CAISSEIA_ENV_DEPRECATED',
    });
  }
  return old;
}

/** Sets `CAISSEIA_<NAME>` unless either name is already set. */
export function defaultEnv(name: EnvName, value: string): void {
  if (readEnv(name) === undefined) process.env[`CAISSEIA_${name}`] = value;
}

/** Test helper: deprecation warnings fire again. */
export function _resetEnvWarnings(): void {
  warned.clear();
}
