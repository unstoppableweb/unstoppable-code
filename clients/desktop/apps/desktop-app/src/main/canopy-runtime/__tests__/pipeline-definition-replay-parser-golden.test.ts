import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  createPipelineDefinitionReplayStore,
  type PipelineDefinitionReplayLedger,
  type PipelineDefinitionReplayStore,
} from '@canopy/core-runtime/node/pipeline';

/*
 * CAN-5092 S1b: the receipts parser moved from a zod schema in Electron
 * main to a portable one in core-runtime. Over malformed ledgers it accepts
 * and rejects exactly what the old schema did, and keeps the same fields.
 * A read that fails for another reason now rejects the load and leaves the
 * file, where the old store renamed it to `.unreadable`.
 */

// The schema Electron main parsed the ledger with before CAN-5092.
const operation = z.enum([
  'core.pipeline.definition.upsert',
  'core.pipeline.definition.delete',
  'core.pipeline.definition.duplicate',
  'core.pipeline.definition.setEnabled',
  'core.pipeline.definition.import',
]);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const idSchema = z.string().min(1).max(512);
const revisionSchema = z.number().int().min(0);
const OldLedgerSchema = z.object({
  version: z.literal(1),
  entries: z.array(
    z.object({
      operation,
      key: digestSchema,
      fingerprint: digestSchema,
      receipt: z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('definition'),
          definitionId: idSchema,
          revision: revisionSchema,
          enabled: z.boolean().optional(),
          sourceDefinitionId: idSchema.optional(),
          remoteVersion: z.string().max(256).optional(),
        }),
        z.object({
          kind: z.literal('enablement'),
          definitionId: idSchema,
          revision: revisionSchema,
          enabled: z.boolean(),
        }),
        z.object({
          kind: z.literal('result'),
          result: z.record(z.string(), z.unknown()),
        }),
      ]),
    }),
  ),
  expired: z.array(z.object({ operation, key: digestSchema })),
});

const digest = 'a'.repeat(64);
const upsert = 'core.pipeline.definition.upsert';
type Json = Record<string, unknown>;

const entry = (receipt: unknown, extra: Json = {}): Json => ({
  operation: upsert,
  key: digest,
  fingerprint: digest,
  receipt,
  ...extra,
});
const ledger = (
  entries: unknown,
  expired: unknown = [],
  extra: Json = {},
): Json => ({ version: 1, entries, expired, ...extra });
const definition = (fields: Json = {}): Json => ({
  kind: 'definition',
  definitionId: 'd1',
  revision: 1,
  ...fields,
});

const cases: readonly (readonly [string, unknown])[] = [
  ['an empty ledger', ledger([])],
  [
    'every receipt kind',
    ledger(
      [
        entry(
          definition({
            enabled: true,
            sourceDefinitionId: 's1',
            remoteVersion: 'v1',
          }),
        ),
        entry({
          kind: 'enablement',
          definitionId: 'd1',
          revision: 0,
          enabled: false,
        }),
        entry({ kind: 'result', result: { nested: { value: [1, null] } } }),
      ],
      [{ operation: 'core.pipeline.definition.import', key: digest }],
    ),
  ],
  [
    'the largest safe revision',
    ledger([entry(definition({ revision: 2 ** 53 - 1 }))]),
  ],
  [
    'an unsafe integer revision',
    ledger([entry(definition({ revision: 2 ** 53 }))]),
  ],
  ['a fractional revision', ledger([entry(definition({ revision: 1.5 }))])],
  ['a negative revision', ledger([entry(definition({ revision: -1 }))])],
  ['a string revision', ledger([entry(definition({ revision: '1' }))])],
  ['a null enabled', ledger([entry(definition({ enabled: null }))])],
  [
    'a null source id',
    ledger([entry(definition({ sourceDefinitionId: null }))]),
  ],
  [
    'a null remote version',
    ledger([entry(definition({ remoteVersion: null }))]),
  ],
  ['a ledger that is an array', [ledger([])]],
  ['an entry that is an array', ledger([[upsert, digest, digest]])],
  ['a receipt that is an array', ledger([entry([definition()])])],
  [
    'a result that is an array',
    ledger([entry({ kind: 'result', result: [1] })]),
  ],
  ['a null result', ledger([entry({ kind: 'result', result: null })])],
  ['an expired entry that is an array', ledger([], [[upsert, digest]])],
  ['a string version', { ...ledger([]), version: '1' }],
  ['version 2', { ...ledger([]), version: 2 }],
  ['entries as an object', ledger({})],
  ['a null expired list', ledger([], null)],
  ['a missing expired list', { version: 1, entries: [] }],
  [
    'an unknown operation',
    ledger([entry(definition(), { operation: 'core.other' })]),
  ],
  [
    'an uppercase digest',
    ledger([entry(definition(), { key: 'A'.repeat(64) })]),
  ],
  [
    'a short digest',
    ledger([entry(definition(), { fingerprint: 'a'.repeat(63) })]),
  ],
  ['a missing kind', ledger([entry({ definitionId: 'd1', revision: 1 })])],
  ['an unknown kind', ledger([entry(definition({ kind: 'other' }))])],
  [
    'an enablement without enabled',
    ledger([entry({ kind: 'enablement', definitionId: 'd1', revision: 1 })]),
  ],
  ['a non-boolean enabled', ledger([entry(definition({ enabled: 'yes' }))])],
  ['extra ledger fields', ledger([], [], { note: 'x' })],
  ['extra entry fields', ledger([entry(definition(), { note: 'x' })])],
  ['extra receipt fields', ledger([entry(definition({ note: 'x' }))])],
  [
    'extra expired fields',
    ledger([], [{ operation: upsert, key: digest, note: 'x' }]),
  ],
  ['an empty definition id', ledger([entry(definition({ definitionId: '' }))])],
  [
    'a 512-character id',
    ledger([entry(definition({ definitionId: 'i'.repeat(512) }))]),
  ],
  [
    'a 513-character id',
    ledger([entry(definition({ definitionId: 'i'.repeat(513) }))]),
  ],
  [
    'a 513-character source id',
    ledger([entry(definition({ sourceDefinitionId: 's'.repeat(513) }))]),
  ],
  [
    'a 256-character remote version',
    ledger([entry(definition({ remoteVersion: 'v'.repeat(256) }))]),
  ],
  [
    'a 257-character remote version',
    ledger([entry(definition({ remoteVersion: 'v'.repeat(257) }))]),
  ],
  ['a numeric definition id', ledger([entry(definition({ definitionId: 1 }))])],
];

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'replay-parser-')));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const storeAt = (file: string): PipelineDefinitionReplayStore =>
  createPipelineDefinitionReplayStore({
    filePath: () => file,
    write: (target, contents) => {
      writeFileSync(target, contents);
      return Promise.resolve();
    },
  });

describe('pipeline definition replay parser (CAN-5092 S1b)', () => {
  it.each(cases)('agrees with the old schema on %s', async (_name, value) => {
    const file = join(root, 'pipeline-definition-replays.json');
    writeFileSync(file, JSON.stringify(value));
    const old = OldLedgerSchema.safeParse(value);
    const loaded: PipelineDefinitionReplayLedger = await storeAt(file).load();
    expect(existsSync(`${file}.unreadable`)).toBe(!old.success);
    expect(loaded).toEqual(
      old.success
        ? { entries: old.data.entries, expired: old.data.expired }
        : { entries: [], expired: [] },
    );
  });

  it('rejects a load that cannot read the file and leaves it in place', async () => {
    const file = join(root, 'pipeline-definition-replays.json');
    mkdirSync(file);
    await expect(storeAt(file).load()).rejects.toThrow('EISDIR');
    expect(existsSync(`${file}.unreadable`)).toBe(false);
    expect(existsSync(file)).toBe(true);
  });

  it('keeps text that does not parse as unreadable', async () => {
    const file = join(root, 'pipeline-definition-replays.json');
    writeFileSync(file, '{');
    await expect(storeAt(file).load()).resolves.toEqual({
      entries: [],
      expired: [],
    });
    expect(readFileSync(`${file}.unreadable`, 'utf8')).toBe('{');
  });
});
