/**
 * docs/INTEGRATION.md examples must run against the SDK's own strict schemas
 * and signatures. Every recordEncaissement / recordCorrection / logTechnicalEvent
 * call in a ```typescript block is extracted:
 *  - the first argument is the workspace id, never an object literal;
 *  - an object-literal payload is evaluated (unknown identifiers become
 *    placeholder strings, e.g. `enc._id` → "enc._id") and parsed with the
 *    strict Zod schema;
 *  - a logTechnicalEvent type literal must be a JET event type.
 * A floor on validated payloads keeps the test from passing on nothing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EncaissementInputSchema, CorrectionInputSchema } from '../schemas/encaissement.schema.js';
import { JetEventTypeSchema } from '../schemas/jet.schema.js';

const DOC = fileURLToPath(new URL('../docs/INTEGRATION.md', import.meta.url));

export function typescriptBlocks(md: string): string[] {
  return [...md.matchAll(/```typescript\n([\s\S]*?)```/g)].map((m) => m[1]!);
}

/** Top-level comma-split argument list of every `fn(` call in `src`. */
export function callArgs(src: string, fn: string): string[][] {
  const out: string[][] = [];
  const re = new RegExp(`\\b${fn}\\(`, 'g');
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 0;
    let quote: string | null = null;
    let cur = '';
    const args: string[] = [];
    for (let i = m.index + m[0].length; i < src.length; i++) {
      const c = src[i]!;
      if (quote) {
        cur += c;
        if (c === quote && src[i - 1] !== '\\') quote = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') quote = c;
      else if (c === '/' && src[i + 1] === '/') {
        while (i < src.length && src[i] !== '\n') i++;
        continue;
      } else if ('({['.includes(c)) depth++;
      else if (')}]'.includes(c)) {
        if (depth === 0) break;
        depth--;
      } else if (c === ',' && depth === 0) {
        args.push(cur.trim());
        cur = '';
        continue;
      }
      cur += c;
    }
    if (cur.trim()) args.push(cur.trim());
    out.push(args);
  }
  return out;
}

/** Evaluate an object literal; `a.b` on an unknown identifier `a` yields the string "a.b". */
export function evalLiteral(lit: string): unknown {
  const ident = (name: string) =>
    new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? `${name}.${k}` : undefined) });
  const scope = new Proxy({}, {
    has: (_t, k) => typeof k === 'string' && !(k in globalThis),
    get: (_t, k) => (typeof k === 'string' ? ident(k) : undefined),
  });
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function('scope', `with (scope) { return (${lit}); }`)(scope);
}

const blocks = typescriptBlocks(readFileSync(DOC, 'utf8'));
const code = blocks.join('\n');

describe('docs/INTEGRATION.md examples', () => {
  it('extracts typescript blocks (positive control)', () => {
    expect(blocks.length).toBeGreaterThan(10);
  });

  it('recordEncaissement / recordCorrection: (workspaceId, input, opts?) and strict payloads', () => {
    const problems: string[] = [];
    let validated = 0;
    for (const [fn, schema] of [
      ['recordEncaissement', EncaissementInputSchema],
      ['recordCorrection', CorrectionInputSchema],
    ] as const) {
      for (const args of callArgs(code, fn)) {
        if (args[0]?.startsWith('{')) {
          problems.push(`${fn}: first argument is an object literal; signature is (workspaceId, input, opts?)`);
          continue;
        }
        if (args.length < 2) {
          problems.push(`${fn}(${args.join(', ')}): missing the input argument`);
          continue;
        }
        if (!args[1]!.startsWith('{')) continue; // a variable: shape shown elsewhere
        const r = schema.safeParse(evalLiteral(args[1]!));
        validated++;
        if (!r.success) problems.push(`${fn}: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
      }
    }
    expect(problems).toEqual([]);
    expect(validated).toBeGreaterThanOrEqual(2);
  });

  it('logTechnicalEvent: (workspaceId, type, details, …) with a real JET event type', () => {
    const problems: string[] = [];
    for (const args of callArgs(code, 'logTechnicalEvent')) {
      if (args[0]?.startsWith('{')) {
        problems.push('logTechnicalEvent: first argument is an object literal; signature is (workspaceId, type, details, context?, opts?)');
        continue;
      }
      const t = args[1]?.match(/^'([^']*)'$/)?.[1];
      if (t !== undefined && !JetEventTypeSchema.safeParse(t).success) problems.push(`logTechnicalEvent: unknown type '${t}'`);
    }
    expect(problems).toEqual([]);
  });

  it('the « Supported event types » list is exactly the JET enum', () => {
    const line = readFileSync(DOC, 'utf8').match(/^Supported event types: (.*)$/m)?.[1] ?? '';
    const listed = [...line.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).sort();
    expect(listed).toEqual([...JetEventTypeSchema.options].sort());
  });
});
