import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoreCatalogHost } from '@canopy/core-runtime/node/catalog';
import {
  CatalogEntryOrCollectionPublishParamsSchema,
  CatalogEntryOrCollectionUnpublishParamsSchema,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { RENDERER_RELAY_GRANTS } from '../../ipc/canopy-core-relay';
import { createCoreOperationAdapter } from '../core-operation-adapter';
import { createDesktopRuntime } from '../desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../desktop-runtime-identity';
import { createInterimInMemoryBindingProvider } from '../renderer-relay/interim-in-memory-binding';
import {
  createRendererRelay,
  type RendererRelayEvent,
} from '../renderer-relay/relay';

// CAN-4170 PR 5a: kind `collection` joins core.catalog.entry.publish and
// unpublish as a contract only. Both are already composed on the desktop
// dispatcher and reachable through the main window's renderer relay, so the
// desktop answers `capability_unavailable` for the collection branch before
// any catalog read, cloud request or operation ledger write, until 5b.

const remoteId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const entryId = 'collection:0f8e2c1a-1111-4222-8333-944455556666';
const document = {
  rawCollection:
    '{"version":1,"name":"Release kit","description":"","items":[]}',
};

const publishes: readonly [string, Record<string, unknown>][] = [
  [
    'create a team share',
    {
      kind: 'collection',
      mode: 'create',
      sourceEntryId: entryId,
      document,
      audience: { visibility: 'team', teamId: 'team-1', organizationId: null },
    },
  ],
  [
    'update a share',
    {
      kind: 'collection',
      mode: 'update',
      publicationId: remoteId,
      sourceEntryId: entryId,
      document,
    },
  ],
  [
    'publish a public link',
    { kind: 'collection', mode: 'publicLink', publicationId: remoteId },
  ],
  [
    'publish in the entry shape',
    {
      entryId,
      kind: 'collection',
      expectedRevision: 0,
      visibility: 'private',
      teamId: null,
      organizationId: null,
    },
  ],
];
const unpublishes: readonly [string, Record<string, unknown>][] = [
  [
    'revoke a public link',
    {
      kind: 'collection',
      publicationId: remoteId,
      scope: 'publicLink',
      expectedRemoteVersion: null,
    },
  ],
  [
    'delete a share',
    {
      kind: 'collection',
      publicationId: remoteId,
      scope: 'share',
      expectedRemoteVersion: null,
    },
  ],
  [
    'unpublish in the entry shape',
    {
      kind: 'collection',
      publicationId: remoteId,
      expectedRemoteVersion: null,
    },
  ],
];
const requests = [
  ...publishes.map(([name, params]) => ({
    name,
    method: 'core.catalog.entry.publish' as const,
    params,
  })),
  ...unpublishes.map(([name, params]) => ({
    name,
    method: 'core.catalog.entry.unpublish' as const,
    params,
  })),
];

const caller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-renderer:main',
  clientInstanceId: 'electron-web-contents:7',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'desktop',
  grants: [...RENDERER_RELAY_GRANTS, 'core.operation.read'],
};

/** Every catalog host call, the hosted cloud catalog's only way out. */
function recordingHost(calls: string[]): CoreCatalogHost {
  return new Proxy({} as CoreCatalogHost, {
    get: (_target, property) =>
      typeof property === 'string'
        ? (...args: unknown[]): Promise<never> => {
            calls.push(property);
            return Promise.reject(
              new Error(
                `unexpected catalog host call ${property}(${args.length})`,
              ),
            );
          }
        : undefined,
  });
}

let root: string;
let calls: string[];
let fetches: jest.SpyInstance;
let runtime: ReturnType<typeof createDesktopRuntime>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'can-4170-5a-'));
  calls = [];
  fetches = jest
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('no hosted request is expected'));
  runtime = createDesktopRuntime({
    operationAdapter: createCoreOperationAdapter({
      ledgerPath: () => join(root, 'ledger.sqlite'),
    }),
    catalogHost: recordingHost(calls),
    shutdownTimeoutMs: 25,
  });
});
afterEach(async () => {
  await runtime.shutdown();
  fetches.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

async function recordedOperations(): Promise<unknown[]> {
  const listed = await runtime.query(
    'core.operation.list',
    {
      kinds: ['core.catalog.entry.publish', 'core.catalog.entry.unpublish'],
    },
    { caller },
  );
  return listed.items;
}

/**
 * Sends a request through the dispatcher after parsing it with the
 * operation's own params schema, so each refused request is contract-valid.
 */
function dispatch(
  method: (typeof requests)[number]['method'],
  params: Record<string, unknown>,
  key: string,
): Promise<unknown> {
  const metadata = { idempotencyKey: key };
  return method === 'core.catalog.entry.publish'
    ? runtime.instruction(
        method,
        CatalogEntryOrCollectionPublishParamsSchema.parse({
          ...params,
          _meta: metadata,
        }),
        { caller, metadata },
      )
    : runtime.instruction(
        method,
        CatalogEntryOrCollectionUnpublishParamsSchema.parse({
          ...params,
          _meta: metadata,
        }),
        { caller, metadata },
      );
}

function errorOf(error: unknown): unknown {
  return error instanceof Error && 'payload' in error ? error.payload : error;
}

describe('core.catalog collection publish refusal on desktop (CAN-4170)', () => {
  it.each(requests)(
    'the desktop dispatcher refuses $method to $name with capability_unavailable before any read, request or write',
    async ({ method, params }) => {
      const key = `dispatcher-${method}-${JSON.stringify(params).length}`;
      const outcome = await dispatch(method, params, key).then(
        (value: unknown) => ({ ok: true, value }),
        (error: unknown) => ({ ok: false, error: errorOf(error) }),
      );
      expect(outcome).toMatchObject({
        ok: false,
        error: { kind: 'capability_unavailable' },
      });
      expect(calls).toEqual([]);
      expect(fetches).not.toHaveBeenCalled();
      expect(await recordedOperations()).toEqual([]);
    },
  );

  it.each(requests)(
    'the main window renderer relay refuses $method to $name with capability_unavailable before any read, request or write',
    async ({ method, params }) => {
      const frame = {
        url: 'canopy://app',
        detached: false,
        isDestroyed: (): boolean => false,
      };
      const event: RendererRelayEvent = {
        sender: {
          id: 7,
          mainFrame: frame,
          getURL: (): string => frame.url,
          isDestroyed: (): boolean => false,
          on: () => undefined,
          removeListener: () => undefined,
        },
        senderFrame: frame,
      };
      const relay = createRendererRelay({
        bindingProvider: createInterimInMemoryBindingProvider(runtime),
        resolveSurface: () => ({ surface: 'main', caller }),
      });
      try {
        const reply = await relay.invoke(event, {
          kind: 'request',
          method,
          params: {
            ...params,
            _meta: { idempotencyKey: `relay-${method}` },
          },
        });
        expect(reply).toMatchObject({
          ok: false,
          error: { kind: 'capability_unavailable' },
        });
      } finally {
        relay.dispose();
      }
      expect(calls).toEqual([]);
      expect(fetches).not.toHaveBeenCalled();
      expect(await recordedOperations()).toEqual([]);
    },
  );

  it('a skill publish the handler refuses is still recorded, so the ledger check above is live', async () => {
    await expect(
      runtime.instruction(
        'core.catalog.entry.publish',
        {
          entryId: 'skill:custom/notes',
          kind: 'skill',
          expectedRevision: 0,
          visibility: 'private',
          teamId: null,
          organizationId: null,
          _meta: { idempotencyKey: 'skill-without-package' },
        },
        { caller, metadata: { idempotencyKey: 'skill-without-package' } },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    expect(calls).toEqual([]);
    expect(await recordedOperations()).toHaveLength(1);
  });
});
