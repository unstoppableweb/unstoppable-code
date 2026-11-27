import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateApproval } from '@canopy/desktop-shared/lib/approval-engine';
import type { ApprovalMode } from '@canopy/desktop-shared/types';
import { protectedApprovalFileWritePaths } from '../approval-rule-sources';

interface Write {
  name: string;
  path: () => string;
  resolvedPath?: () => string;
}

let root = '';
let protectedPaths: string[] = [];
const previousDataDir = process.env.CANOPY_DATA_DIR;

const under = (...segments: string[]): string => join(root, ...segments);

const protectedWrites: Write[] = [
  {
    name: 'the operation ledger’s owner record',
    path: () => under('storage-records', 'operation_ledger', 'owner-flip.json'),
  },
  {
    name: 'the operation ledger’s owner record’s temporary file',
    path: () =>
      under(
        'storage-records',
        'operation_ledger',
        `owner-flip.json.${randomUUID()}.tmp`,
      ),
  },
  {
    name: 'the operation ledger’s records folder',
    path: () => under('storage-records', 'operation_ledger'),
  },
  {
    name: 'the operation ledger’s records folder through a link',
    path: () => under('link-elsewhere'),
    resolvedPath: () => realpathSync(under('link-elsewhere')),
  },
  {
    name: 'a file directly in backups',
    path: () => under('backups', 'stray.json'),
  },
  {
    name: 'a backup copy five levels down',
    path: () =>
      under(
        'backups',
        'work-entries',
        'b1',
        'workspaces',
        'ws-1',
        'work-entries.json',
      ),
  },
  {
    name: 'the pipeline definitions row’s owner record',
    path: () =>
      under('storage-records', 'pipeline_definitions', 'owner-flip.json'),
  },
];

const preferencesRecord: Write = {
  name: 'the preferences owner record',
  path: () => under('storage-records', 'preferences', 'owner-flip.json'),
};

const plainFile: Write = {
  name: 'an unprotected file',
  path: () => under('notes', 'plain.txt'),
};

function outcome(write: Write, mode: ApprovalMode): string {
  return evaluateApproval(
    {
      kind: 'file-write',
      path: write.path(),
      resolvedPath: (write.resolvedPath ?? write.path)(),
    },
    {
      mode,
      rules: { session: [], project: [], global: [] },
      workspaceRoot: root,
      protectedFileWritePaths: protectedPaths,
    },
  ).outcome;
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'protected-storage-')));
  process.env.CANOPY_DATA_DIR = root;
  for (const folder of [
    ['storage-records', 'operation_ledger'],
    ['storage-records', 'pipeline_definitions'],
    ['storage-records', 'preferences'],
    ['backups', 'preferences'],
    ['backups', 'work-entries', 'b1', 'workspaces', 'ws-1'],
    ['notes'],
  ]) {
    mkdirSync(under(...folder), { recursive: true });
  }
  symlinkSync(
    under('storage-records', 'operation_ledger'),
    under('link-elsewhere'),
  );
  protectedPaths = await protectedApprovalFileWritePaths('ws-1', root);
});

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = previousDataDir;
  rmSync(root, { recursive: true, force: true });
});

describe('agent protected paths cover every row’s records and backups (CAN-7984)', () => {
  it.each(protectedWrites)('Auto asks before writing $name', (write) => {
    expect(outcome(write, 'auto')).toBe('prompt');
  });

  it('Auto still asks for the preferences owner record and allows an unprotected file', () => {
    expect(outcome(preferencesRecord, 'auto')).toBe('prompt');
    expect(outcome(plainFile, 'auto')).toBe('allow');
  });

  it('Full Access allows every one of them', () => {
    for (const write of [...protectedWrites, preferencesRecord, plainFile]) {
      expect(outcome(write, 'full-access')).toBe('allow');
    }
  });
});
