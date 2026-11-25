import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import {
  createCanopyDispatcher,
  CanopyOperationError,
} from '@canopy/core-runtime';
import {
  PIPELINE_DEFINITION_INSTRUCTION_DEFINITIONS,
  PIPELINE_GRANTS,
  type CanopyCallerDescriptor,
  type PipelineDefinitionImportParams,
  type PipelineDefinitionImportResult,
} from '@canopy/protocol/canopy-core';
import {
  BROWSER_CONTROLLER_CHANNELS,
  REMOTE_COMMAND_CHANNELS,
} from '@canopy/protocol/remote-control/channels';
import type * as ImportModule from '../daemon-pipeline-definition-import';
import type { DaemonPipelineOwnerImportClient } from '../daemon-pipeline-definition-import';
import {
  ELECTRON_DAEMON_DEFINITIONS,
  type ElectronDaemonClient,
} from '../electron-daemon-host';
import { INTERFACE_RELAY_ALLOWLIST } from '../renderer-relay/interface-allowlist.generated';
import {
  ELECTRON_DAEMON_OWNER_DEFINITIONS,
  type ElectronDaemonOwnerClient,
} from '../electron-daemon-owner';
import {
  PIPELINE_DEFINITION_AGENT_CALLER,
  PIPELINE_DEFINITION_DESKTOP_CALLER,
  PIPELINE_DEFINITION_REMOTE_CONTROL_CALLER,
} from '../pipeline-definition-dispatch';

/*
 * CAN-7523: the import's desktop half. Electron main sends it to the daemon
 * only over its owner connection, a refusal there is never applied in the
 * app instead, and Remote Control and Portal installs of a curated workflow
 * still go through main, which imports in process. Mike approved owner proof
 * as the import's grant as a stopgap until E1 (CAN-4729).
 */

const NOT_OWNER = new Error('This app is not the daemon owner.');
jest.mock('../electron-daemon-owner', () => ({
  ...jest.requireActual<object>('../electron-daemon-owner'),
  isDaemonOwnerUnavailable: (error: unknown): boolean => error === NOT_OWNER,
}));

const IMPORT = 'core.pipeline.definition.import';
const MAIN = path.join(__dirname, '..', '..');

function params(idempotencyKey: string): PipelineDefinitionImportParams {
  return {
    remoteDefinitionId: 'curated:review',
    targetScope: {},
    expectedRemoteVersion: 'f'.repeat(64),
    nameOverride: null,
    _meta: { idempotencyKey },
  };
}

async function loadImport(): Promise<typeof ImportModule> {
  return import('../daemon-pipeline-definition-import');
}

describe('the import goes to the daemon only over the owner connection (CAN-7523)', () => {
  it('refuses before sending when no owner session is open, retryable with the same key', async () => {
    const { createDaemonPipelineDefinitionImport } = await loadImport();
    const route = createDaemonPipelineDefinitionImport({
      ownerClient: () => Promise.reject(new Error('No daemon session.')),
    });
    await expect(route.import(params('no-session'))).rejects.toMatchObject({
      payload: {
        kind: 'unavailable',
        code: 'core.pipeline.targetUnavailable',
        retry: { kind: 'same_idempotency_key' },
      },
    });
  });

  it('refuses for good when this app is not the daemon owner', async () => {
    const { createDaemonPipelineDefinitionImport } = await loadImport();
    const route = createDaemonPipelineDefinitionImport({
      ownerClient: () => Promise.reject(NOT_OWNER),
    });
    await expect(route.import(params('not-owner'))).rejects.toMatchObject({
      payload: {
        kind: 'unavailable',
        code: 'core.pipeline.targetUnavailable',
        retry: { kind: 'never' },
      },
    });
  });

  it("passes the daemon's own refusal through, and sends nothing anywhere else", async () => {
    const { createDaemonPipelineDefinitionImport } = await loadImport();
    const refusal = new CanopyOperationError({
      kind: 'permission_denied',
      message: 'Refused.',
      retry: { kind: 'never' },
    });
    const instruction = jest.fn(() => Promise.reject(refusal));
    const route = createDaemonPipelineDefinitionImport({
      ownerClient: () => Promise.resolve({ instruction }),
    });
    await expect(route.import(params('refused'))).rejects.toBe(refusal);
    expect(instruction).toHaveBeenCalledTimes(1);
    expect(instruction).toHaveBeenCalledWith(IMPORT, params('refused'), {});
  });

  it('answers with the daemon result over the owner client', async () => {
    const { createDaemonPipelineDefinitionImport } = await loadImport();
    const result: PipelineDefinitionImportResult = {
      definition: {
        definitionId: 'review-copy',
        scope: {},
        source: 'user',
        owner: null,
        name: 'Review',
        description: '',
        icon: '',
        enabled: true,
        readonly: false,
        format: 'yaml',
        revision: 1,
        checksum: 'c'.repeat(64),
        triggerTypes: [],
        executionScopes: [],
        createdAt: null,
        updatedAt: null,
        document: 'name: Review\n',
        normalized: null,
        diagnostics: [],
      },
      remoteDefinitionId: 'curated:review',
      remoteVersion: 'f'.repeat(64),
    };
    const instruction = jest.fn(() => Promise.resolve(result));
    const route = createDaemonPipelineDefinitionImport({
      ownerClient: () => Promise.resolve({ instruction }),
    });
    const signal = new AbortController().signal;
    await expect(
      route.import(params('owner'), {
        signal,
        metadata: { idempotencyKey: 'owner' },
      }),
    ).resolves.toBe(result);
    expect(instruction).toHaveBeenCalledWith(IMPORT, params('owner'), {
      signal,
      metadata: { idempotencyKey: 'owner' },
    });
  });

  it('keeps the import on the owner client: the leased peer client cannot carry it', () => {
    expect(Object.keys(ELECTRON_DAEMON_DEFINITIONS.instructions)).not.toContain(
      IMPORT,
    );
    expect(
      Object.keys(ELECTRON_DAEMON_OWNER_DEFINITIONS.instructions),
    ).toContain(IMPORT);
    const source = readFileSync(
      path.join(__dirname, '..', 'daemon-pipeline-definition-import.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/\bElectronDaemonClient\b/);
    // Type-checked: the owner client can serve as the import's client, and
    // the leased peer client cannot.
    const fromOwner = (
      client: ElectronDaemonOwnerClient,
    ): DaemonPipelineOwnerImportClient => client;
    const fromPeer = (
      client: ElectronDaemonClient,
      // @ts-expect-error -- the peer definitions do not carry the import.
    ): DaemonPipelineOwnerImportClient => client;
    expect([fromOwner, fromPeer]).toHaveLength(2);
    // Unselected: nothing in main composes it until the ownership switch.
    expect(mainSourcesImporting('daemon-pipeline-definition-import')).toEqual(
      [],
    );
  });

  it('pins every caller of the factory to the owner-session getter', () => {
    const callers = mainSourcesImporting('daemon-pipeline-definition-import');
    expect(callers.length).toBeLessThanOrEqual(1);
    for (const caller of callers)
      expect(
        ownerImportCallViolations(
          readFileSync(path.join(MAIN, caller), 'utf8'),
        ),
      ).toEqual([]);
    // The scan itself: it accepts the owner getter and refuses anything else.
    expect(
      ownerImportCallViolations(
        "import { getDaemonPipelineOwnerClient } from './electron-daemon-owner';\n" +
          'createDaemonPipelineDefinitionImport({ ownerClient: getDaemonPipelineOwnerClient });',
      ),
    ).toEqual([]);
    expect(
      ownerImportCallViolations(
        'createDaemonPipelineDefinitionImport({ ownerClient: () => getElectronDaemonClient() });',
      ),
    ).toEqual([
      'does not import getDaemonPipelineOwnerClient from electron-daemon-owner',
      'a call does not pass ownerClient: getDaemonPipelineOwnerClient',
    ]);
  });
});

describe('only Electron main imports in process (CAN-7523)', () => {
  const dispatcher = createCanopyDispatcher({
    profile: 'core',
    definitions: {
      queries: {},
      instructions: {
        [IMPORT]: PIPELINE_DEFINITION_INSTRUCTION_DEFINITIONS[IMPORT],
      },
      streams: {},
    },
    handlers: {
      queries: {},
      instructions: {
        [IMPORT]: (): Promise<never> =>
          Promise.reject(
            new CanopyOperationError({
              kind: 'not_found',
              code: 'core.pipeline.remoteNotFound',
              message: 'Reached the import handler.',
              retry: { kind: 'never' },
            }),
          ),
      },
      streams: {},
    },
  });
  const run = (caller: CanopyCallerDescriptor): Promise<unknown> =>
    dispatcher.instruction(IMPORT, params(caller.clientInstanceId), {
      caller,
      metadata: { idempotencyKey: caller.clientInstanceId },
    });
  const cliClient: CanopyCallerDescriptor = {
    principalId: 'local-user',
    clientInstanceId: 'cli-in-process',
    authorityId: PIPELINE_DEFINITION_DESKTOP_CALLER.authorityId,
    interfaceKind: 'cli',
    grants: [PIPELINE_GRANTS.read, PIPELINE_GRANTS.write],
  };

  it("lets main's desktop caller reach the import, and refuses Remote Control, agents and the CLI", async () => {
    expect(PIPELINE_DEFINITION_DESKTOP_CALLER.grants).toContain(
      PIPELINE_GRANTS.ownerImport,
    );
    await expect(run(PIPELINE_DEFINITION_DESKTOP_CALLER)).rejects.toMatchObject(
      {
        payload: { code: 'core.pipeline.remoteNotFound' },
      },
    );
    for (const caller of [
      PIPELINE_DEFINITION_REMOTE_CONTROL_CALLER,
      PIPELINE_DEFINITION_AGENT_CALLER,
      cliClient,
    ])
      await expect(run(caller)).rejects.toMatchObject({
        payload: { kind: 'permission_denied' },
      });
  });
});

describe('Remote Control and Portal curated installs go through main (CAN-7523)', () => {
  it("maps the remote install command to main's curated import channel only", () => {
    expect(REMOTE_COMMAND_CHANNELS['pipeline.installCurated']).toEqual({
      invoke: ['pipelines:curated-import'],
    });
    expect(BROWSER_CONTROLLER_CHANNELS).toContain('pipelines:curated-import');
  });

  it("serves that channel in main, importing with main's own caller", () => {
    const handlers = readFileSync(
      path.join(MAIN, 'pipelines', 'curated-pipeline-handlers.ts'),
      'utf8',
    );
    expect(handlers).toMatch(
      /PIPELINE_CHANNELS\.CURATED_IMPORT,[\s\S]{0,200}importCuratedPipeline\(request\)/,
    );
    const catalog = readFileSync(
      path.join(MAIN, 'pipelines', 'curated-pipeline-catalog.ts'),
      'utf8',
    );
    const start = catalog.indexOf(
      'export async function importCuratedPipeline(',
    );
    expect(start).toBeGreaterThan(-1);
    const body = catalog.slice(start, catalog.indexOf('\nexport ', start + 1));
    // One argument: the import runs as main's desktop caller, by default.
    expect(body).toMatch(/importRemotePipeline\(\{[\s\S]*?\}\);/);
    expect(body).not.toMatch(/importRemotePipeline\(\{[\s\S]*?\},\s*\w/);
    const dispatch = readFileSync(
      path.join(__dirname, '..', 'pipeline-definition-dispatch.ts'),
      'utf8',
    );
    expect(dispatch).toMatch(
      /export async function importRemotePipeline\(\s*input: RemotePipelineImport,\s*caller: CanopyCallerDescriptor = PIPELINE_DEFINITION_DESKTOP_CALLER,/,
    );
  });

  it('gives no renderer, Portal or remote session the import itself', () => {
    // The profile layer's own check, for every profile and principal, is the
    // daemon golden's (pipeline-definition-owner-import.test.ts).
    const relay = readFileSync(
      path.join(
        __dirname,
        '..',
        'renderer-relay',
        'interface-allowlist.generated.ts',
      ),
      'utf8',
    );
    expect(relay).not.toContain(`'${IMPORT}'`);
  });
});

describe('the renderer relay never carries the import (CAN-7523)', () => {
  it('lists no import in any mode, and keeps the owner mode empty', () => {
    expect(Object.keys(INTERFACE_RELAY_ALLOWLIST)).toContain('owner');
    for (const [mode, kinds] of Object.entries(INTERFACE_RELAY_ALLOWLIST)) {
      expect({
        mode,
        carriesImport: kinds.instruction.includes(IMPORT),
      }).toEqual({ mode, carriesImport: false });
      if (mode === 'owner')
        expect(kinds).toEqual({ query: [], instruction: [], stream: [] });
    }
  });
});

/** Main's non-test sources that import `module`. */
/** How a source composing the factory strays from the owner-session getter. */
function ownerImportCallViolations(source: string): string[] {
  const violations: string[] = [];
  if (
    !/import\s*\{[^}]*\bgetDaemonPipelineOwnerClient\b[^}]*\}\s*from\s*'[./]*(?:canopy-runtime\/)?electron-daemon-owner'/.test(
      source,
    )
  )
    violations.push(
      'does not import getDaemonPipelineOwnerClient from electron-daemon-owner',
    );
  const calls = source.split('createDaemonPipelineDefinitionImport(').slice(1);
  if (
    calls.length === 0 ||
    calls.some(
      (call) =>
        !/^\s*\{\s*ownerClient:\s*getDaemonPipelineOwnerClient\s*,?\s*\}\s*\)/.test(
          call,
        ),
    )
  )
    violations.push(
      'a call does not pass ownerClient: getDaemonPipelineOwnerClient',
    );
  return violations;
}

function mainSourcesImporting(module: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const full = path.join(directory, entry);
      if (entry === '__tests__' || entry === 'node_modules') continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (
        /\.tsx?$/.test(entry) &&
        !full.endsWith(`${module}.ts`) &&
        readFileSync(full, 'utf8').includes(`/${module}'`)
      )
        found.push(path.relative(MAIN, full));
    }
  };
  walk(MAIN);
  return found;
}
