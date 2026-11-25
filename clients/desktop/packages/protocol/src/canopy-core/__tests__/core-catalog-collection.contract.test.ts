import { z } from 'zod';
import {
  CANOPY_INSTRUCTION_DEFINITIONS,
  CANOPY_QUERY_DEFINITIONS,
  CANOPY_STREAM_DEFINITIONS,
  CanopyRequestMetadataSchema,
} from '..';
import {
  CATALOG_COLLECTION_ERROR_CODES,
  CATALOG_GRANTS,
  CORE_CATALOG_COLLECTION_PUBLISH_CODES,
  CORE_CATALOG_COLLECTION_UNPUBLISH_CODES,
  CORE_CATALOG_PUBLISH_CODES,
  CORE_CATALOG_UNPUBLISH_CODES,
  CatalogEntryOrCollectionPublishParamsSchema,
  CatalogEntryOrCollectionPublishResultSchema,
  CatalogEntryOrCollectionUnpublishParamsSchema,
  CatalogEntryOrCollectionUnpublishResultSchema,
  CatalogEntryPublishParamsSchema,
  CatalogEntryPublishResultSchema,
  CatalogEntryUnpublishParamsSchema,
  CatalogEntryUnpublishResultSchema,
  CORE_CATALOG_COLLECTION_INSTRUCTION_DEFINITIONS,
  CORE_CATALOG_COLLECTION_QUERY_DEFINITIONS,
  CORE_CATALOG_INSTRUCTION_DEFINITIONS,
  CORE_CATALOG_PUBLISH_INSTRUCTION_DEFINITIONS,
  CORE_CATALOG_QUERY_DEFINITIONS,
} from '../core';

const QUERIES = ['core.catalog.entry.get'] as const;
const INSTRUCTIONS = [
  'core.catalog.entry.upsert',
  'core.catalog.entry.delete',
  'core.catalog.entry.import',
] as const;

const keyed = { idempotencyKey: 'key-1' };
const entryId = 'collection:0f8e2c1a-1111-4222-8333-944455556666';
const remoteId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const contentHash = 'a'.repeat(64);
const digest = `pp:v1:${'A'.repeat(43)}`;
const members = {
  skills: [{ sourceId: 'custom:app', skillName: 'release-notes' }],
  plugins: [{ marketplaceId: 'claude-plugins', pluginName: 'linter' }],
  mcpServers: [{ serverId: 'a1b2', configId: 'c3d4' }],
};
const entry = {
  kind: 'collection',
  entryId,
  revision: 'rev-1',
  name: 'Release kit',
  description: '',
  members,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-02T10:00:00.000Z',
  sharedSource: null,
  share: null,
  unresolvedMembers: [
    { kind: 'plugin', marketplaceId: 'claude-plugins', pluginName: 'linter' },
  ],
};

const upsert =
  CORE_CATALOG_COLLECTION_INSTRUCTION_DEFINITIONS['core.catalog.entry.upsert'];
const remove =
  CORE_CATALOG_COLLECTION_INSTRUCTION_DEFINITIONS['core.catalog.entry.delete'];
const importing =
  CORE_CATALOG_COLLECTION_INSTRUCTION_DEFINITIONS['core.catalog.entry.import'];
const get = CORE_CATALOG_COLLECTION_QUERY_DEFINITIONS['core.catalog.entry.get'];

describe('core.catalog collection contract (CAN-4170)', () => {
  it('reads with core.catalog.read and writes with core.catalog.write, adding no grant', () => {
    const existing: readonly string[] = Object.values(CATALOG_GRANTS);
    for (const name of QUERIES) {
      const definition = CORE_CATALOG_COLLECTION_QUERY_DEFINITIONS[name];
      expect(definition.requiredGrants).toEqual([CATALOG_GRANTS.read]);
      expect(definition.idempotency).toBe('inherent');
    }
    for (const name of INSTRUCTIONS) {
      const definition = CORE_CATALOG_COLLECTION_INSTRUCTION_DEFINITIONS[name];
      expect(definition.requiredGrants).toEqual([CATALOG_GRANTS.write]);
      expect(definition.idempotency).toBe('keyed');
      for (const grant of definition.requiredGrants)
        expect(existing).toContain(grant);
    }
  });

  it('stays out of every registry until a handler serves it', () => {
    const served = [
      CANOPY_QUERY_DEFINITIONS,
      CANOPY_INSTRUCTION_DEFINITIONS,
      CANOPY_STREAM_DEFINITIONS,
      CORE_CATALOG_QUERY_DEFINITIONS,
      CORE_CATALOG_INSTRUCTION_DEFINITIONS,
      CORE_CATALOG_PUBLISH_INSTRUCTION_DEFINITIONS,
    ].flatMap((registry) => Object.keys(registry));
    for (const name of [...QUERIES, ...INSTRUCTIONS])
      expect(served).not.toContain(name);
  });

  it('creates without a revision and replaces only with the revision it read', () => {
    const create = {
      kind: 'collection',
      entryId: null,
      expectedRevision: null,
      name: 'Release kit',
      description: '',
      members,
      sharedRevision: null,
      _meta: keyed,
    };
    expect(upsert.params.safeParse(create).success).toBe(true);
    const replace = { ...create, entryId, expectedRevision: 'rev-1' };
    expect(upsert.params.safeParse(replace).success).toBe(true);
    expect(
      upsert.params.safeParse({ ...replace, expectedRevision: null }).success,
    ).toBe(false);
    expect(
      upsert.params.safeParse({ ...create, expectedRevision: 'rev-1' }).success,
    ).toBe(false);
    expect(upsert.params.safeParse({ ...create, kind: 'skill' }).success).toBe(
      false,
    );
    expect(upsert.params.safeParse({ ...create, name: '   ' }).success).toBe(
      false,
    );
    expect(upsert.params.safeParse({ ...create, _meta: {} }).success).toBe(
      false,
    );
    expect(
      upsert.params.safeParse({
        ...create,
        members: {
          ...members,
          mcpServers: [{ serverId: '../a', configId: 'c3d4' }],
        },
      }).success,
    ).toBe(false);
    expect(
      upsert.params.safeParse({
        ...create,
        sharedRevision: { remoteId, contentHash, fromPublicShare: false },
      }).success,
    ).toBe(true);
    expect(upsert.result.safeParse({ entry }).success).toBe(true);
  });

  it('keeps an unresolved member and reports it', () => {
    const parsed = get.result.safeParse({ read: 'entry', entry });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({
      entry: {
        members: { plugins: members.plugins },
        unresolvedMembers: [{ kind: 'plugin', pluginName: 'linter' }],
      },
    });
  });

  it('deletes only with the revision it read', () => {
    const withoutRevision = { kind: 'collection', entryId, _meta: keyed };
    const request = { ...withoutRevision, expectedRevision: 'rev-1' };
    expect(remove.params.safeParse(request).success).toBe(true);
    expect(remove.params.safeParse(withoutRevision).success).toBe(false);
    expect(
      remove.params.safeParse({ ...request, kind: 'plugin' }).success,
    ).toBe(false);
    expect(
      remove.params.safeParse({ ...request, entryId: 'skill:custom/x' })
        .success,
    ).toBe(false);
    expect(
      remove.result.safeParse({ kind: 'collection', entryId, deleted: true })
        .success,
    ).toBe(true);
  });

  it('reads an entry or the import readiness of a shared collection', () => {
    expect(
      get.params.safeParse({ kind: 'collection', read: 'entry', entryId })
        .success,
    ).toBe(true);
    expect(
      get.params.safeParse({
        kind: 'collection',
        read: 'importReadiness',
        remoteId,
        fromPublicShare: false,
      }).success,
    ).toBe(true);
    expect(
      get.params.safeParse({ kind: 'model', read: 'entry', entryId }).success,
    ).toBe(false);
    expect(
      get.result.safeParse({
        read: 'importReadiness',
        readiness: {
          remoteId,
          contentHash,
          package: { version: 1, digest },
          requirements: [
            {
              id: 'req-1',
              kind: 'mcp',
              displayName: 'Linear',
              required: true,
              setupHint: 'Connect Linear.',
              status: 'missing',
            },
          ],
        },
      }).success,
    ).toBe(true);
  });

  it('reads the cloud account a share link was made under, and no write sets it', () => {
    const share = {
      remoteId,
      contentHash,
      shareScope: 'organization',
      sharedAt: '2026-11-03T10:00:00.000Z',
    };
    for (const link of [share, { ...share, accountId: 'user-1' }])
      expect(
        get.result.safeParse({
          read: 'entry',
          entry: { ...entry, share: link },
        }).success,
      ).toBe(true);
    expect(
      get.result.safeParse({
        read: 'entry',
        entry: { ...entry, share: { ...share, accountId: '' } },
      }).success,
    ).toBe(false);
    // A pin the share was made under, never a selector a caller writes.
    const create = {
      kind: 'collection',
      entryId: null,
      expectedRevision: null,
      name: 'Release kit',
      description: '',
      members,
      sharedRevision: null,
      _meta: keyed,
    };
    expect(
      upsert.params.safeParse({
        ...create,
        share: { ...share, accountId: 'user-1' },
      }).success,
    ).toBe(false);
  });

  it('reads only the revision a delete needs, or the stored bytes hash of a collection that cannot be read', () => {
    const management = { kind: 'collection', read: 'management', entryId };
    expect(get.params.safeParse(management).success).toBe(true);
    expect(get.params.safeParse({ ...management, remoteId }).success).toBe(
      false,
    );
    const answered = { read: 'management', entryId };
    expect(
      get.result.safeParse({ ...answered, revision: 'rev-1' }).success,
    ).toBe(true);
    expect(
      get.result.safeParse({ ...answered, storedBytesHash: contentHash })
        .success,
    ).toBe(true);
    for (const refused of [
      { ...answered },
      { ...answered, revision: 'rev-1', storedBytesHash: contentHash },
      { ...answered, storedBytesHash: 'rev-1' },
      { ...answered, revision: 'rev-1', sharedSource: null },
      { ...answered, revision: 'rev-1', remoteId },
    ])
      expect(get.result.safeParse(refused).success).toBe(false);
  });

  it('deletes a collection that cannot be read only at its stored bytes hash, and nothing else takes one', () => {
    const request = { kind: 'collection', entryId, _meta: keyed };
    expect(
      remove.params.safeParse({
        ...request,
        expectedStoredBytesHash: contentHash,
      }).success,
    ).toBe(true);
    for (const refused of [
      { ...request, expectedStoredBytesHash: 'rev-1' },
      {
        ...request,
        expectedRevision: 'rev-1',
        expectedStoredBytesHash: contentHash,
      },
    ])
      expect(remove.params.safeParse(refused).success).toBe(false);
    expect(
      upsert.params.safeParse({
        kind: 'collection',
        entryId,
        expectedRevision: 'rev-1',
        expectedStoredBytesHash: contentHash,
        name: 'Release kit',
        description: '',
        members,
        sharedRevision: null,
        _meta: keyed,
      }).success,
    ).toBe(false);
  });

  it('analyzes, commits and installs a collection package', () => {
    const base = { kind: 'collection', _meta: keyed };
    expect(
      importing.params.safeParse({
        ...base,
        mode: 'analyze',
        entryId,
        expectedRevision: 'rev-1',
        dismissedInvocations: [{ provider: 'claude', token: '/deploy' }],
      }).success,
    ).toBe(true);
    expect(
      importing.params.safeParse({
        ...base,
        mode: 'commit',
        entryId,
        expectedRevision: 'rev-1',
        analysisId: 'analysis-1',
        selectedOptionalResourceIds: [],
      }).success,
    ).toBe(true);
    const install = {
      ...base,
      mode: 'install',
      remoteId,
      fromPublicShare: true,
      expectedContentHash: contentHash,
      package: { version: 1, digest },
      target: { create: { name: 'Release kit', description: '' } },
    };
    expect(importing.params.safeParse(install).success).toBe(true);
    expect(
      importing.params.safeParse({
        ...install,
        target: { entryId, expectedRevision: 'rev-1' },
      }).success,
    ).toBe(true);
    expect(
      importing.params.safeParse({ ...install, kind: 'skill' }).success,
    ).toBe(false);
    expect(
      importing.result.safeParse({
        kind: 'collection',
        mode: 'install',
        entry,
        installedSkills: [{ name: 'notes', localName: 'notes-2' }],
        unmetRequirements: [
          {
            id: 'req-1',
            kind: 'mcp',
            displayName: 'Linear',
            required: true,
            setupHint: 'Connect Linear.',
          },
        ],
        uninstalledResourceLabels: ['Deploy hook'],
        keptLocalFiles: ['notes-2/scripts/run.sh'],
      }).success,
    ).toBe(true);
  });

  it('keeps a dismissible invocation blocker and takes its dismissal back on analyze', () => {
    const dismissal = { provider: 'claude', token: '/deploy' };
    const result = importing.result.safeParse({
      kind: 'collection',
      mode: 'analyze',
      analysis: {
        analysisId: 'analysis-1',
        state: 'blocked',
        blockers: [
          {
            code: 'UNRESOLVED_INVOCATION',
            subject: '/deploy',
            message:
              'The release-notes skill invokes /deploy, which no member provides.',
            dismissal,
          },
          {
            code: 'SECRET_IN_MEMBER',
            subject: null,
            message: 'A member holds a value that looks like a secret.',
          },
        ],
        resources: [],
        requirements: [],
        unpackageableMemberLabels: [],
        expiresAt: '2026-11-17T12:00:00.000Z',
      },
    });
    expect(result.success).toBe(true);
    const returned =
      result.success && result.data.mode === 'analyze'
        ? result.data.analysis.blockers.flatMap((blocker) =>
            blocker.dismissal === undefined ? [] : [blocker.dismissal],
          )
        : [];
    expect(returned).toEqual([dismissal]);
    expect(
      importing.params.safeParse({
        kind: 'collection',
        _meta: keyed,
        mode: 'analyze',
        entryId,
        expectedRevision: 'rev-1',
        dismissedInvocations: returned,
      }).success,
    ).toBe(true);
    expect(
      importing.result.safeParse({
        kind: 'collection',
        mode: 'analyze',
        analysis: {
          analysisId: 'analysis-1',
          state: 'blocked',
          blockers: [
            {
              code: 'UNRESOLVED_INVOCATION',
              subject: '/deploy',
              message: 'Unresolved.',
              dismissal: { provider: 'other', token: '/deploy' },
            },
          ],
          resources: [],
          requirements: [],
          unpackageableMemberLabels: [],
          expiresAt: '2026-11-17T12:00:00.000Z',
        },
      }).success,
    ).toBe(false);
  });

  it('refuses an unsafe import before anything is fetched', () => {
    const install = {
      kind: 'collection',
      mode: 'install',
      remoteId,
      fromPublicShare: false,
      expectedContentHash: contentHash,
      package: { version: 1, digest },
      target: { create: { name: 'Release kit', description: '' } },
      _meta: keyed,
    };
    const refused = (change: Record<string, unknown>): boolean =>
      !importing.params.safeParse({ ...install, ...change }).success;
    expect(refused({ remoteId: '../../etc' })).toBe(true);
    expect(refused({ remoteId: 'https://example.com/c' })).toBe(true);
    expect(refused({ package: { version: 1, digest: 'sha256:abc' } })).toBe(
      true,
    );
    expect(refused({ expectedContentHash: undefined })).toBe(true);
    expect(
      refused({
        target: {
          create: { name: 'Release kit', description: '' },
          entryId,
          expectedRevision: 'rev-1',
        },
      }),
    ).toBe(true);
    expect(refused({ target: { entryId } })).toBe(true);
    for (const path of ['/Users/me/x.sh', '..\\x', 'a/../../b', 'C:x'])
      expect(
        importing.result.safeParse({
          kind: 'collection',
          mode: 'install',
          entry,
          installedSkills: [],
          unmetRequirements: [],
          uninstalledResourceLabels: [],
          keptLocalFiles: [path],
        }).success,
      ).toBe(false);
  });

  it('refuses with stable codes and the retry each operation admits', () => {
    const failure = (code: string, retry: string): unknown => ({
      kind: 'conflict',
      message: 'Collection changed. Reload it before saving.',
      code,
      details: { currentRevision: 'rev-2' },
      retry:
        retry === 'after_refresh'
          ? { kind: retry, resource: 'core.catalog.entry' }
          : { kind: retry },
    });
    expect(
      upsert.error.safeParse(
        failure('core.catalog.revisionConflict', 'after_refresh'),
      ).success,
    ).toBe(true);
    expect(
      upsert.error.safeParse(
        failure('core.catalog.revisionConflict', 'same_request'),
      ).success,
    ).toBe(false);
    expect(
      upsert.error.safeParse(failure('core.catalog.nope', 'after_refresh'))
        .success,
    ).toBe(false);
    for (const code of [
      'core.catalog.entryNotFound',
      'core.catalog.entryInvalid',
      'core.catalog.entryUnreadable',
    ])
      expect(
        remove.error.safeParse(failure(code, 'never')).success ||
          upsert.error.safeParse(failure(code, 'never')).success,
      ).toBe(true);
    for (const code of [
      'core.catalog.analysisNotFound',
      'core.catalog.packageBlocked',
      'core.catalog.packageStale',
      'core.catalog.packageInvalid',
      'core.catalog.remoteVersionConflict',
    ])
      expect(importing.error.safeParse(failure(code, 'never')).success).toBe(
        true,
      );
    expect(
      get.error.safeParse(failure('core.catalog.entryNotFound', 'same_request'))
        .success,
    ).toBe(true);
  });
});

// CAN-4170 PR 5a: kind `collection` joins core.catalog.entry.publish and
// unpublish as its own branch (decision K1). The skill and plugin branch is
// the unchanged schema object, pinned by its JSON Schema hash on develop.
const publish =
  CORE_CATALOG_PUBLISH_INSTRUCTION_DEFINITIONS['core.catalog.entry.publish'];
const unpublish =
  CORE_CATALOG_PUBLISH_INSTRUCTION_DEFINITIONS['core.catalog.entry.unpublish'];
const sha256 = async (
  schema: z.ZodType,
  io: 'input' | 'output',
): Promise<string> => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(z.toJSONSchema(schema, { io }))),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
};
const document = {
  rawCollection:
    '{"version":1,"name":"Release kit","description":"","items":[]}',
  customSkills: [
    { clientKey: 'k1', name: 'notes', rawSkill: '---\nname: notes\n---\n' },
  ],
};
const teamAudience = {
  visibility: 'team',
  teamId: 'team-1',
  organizationId: 'org-1',
};
const createShare = {
  kind: 'collection',
  mode: 'create',
  sourceEntryId: entryId,
  document,
  audience: teamAudience,
  _meta: keyed,
};
const updateShare = {
  kind: 'collection',
  mode: 'update',
  publicationId: remoteId,
  sourceEntryId: entryId,
  expectedContentHash: contentHash,
  document,
  audience: {
    visibility: 'organization',
    teamId: null,
    organizationId: 'org-1',
  },
  _meta: keyed,
};
const publicLink = {
  kind: 'collection',
  mode: 'publicLink',
  publicationId: remoteId,
  _meta: keyed,
};
const publicShare = {
  externalId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
  pinnedContentHash: contentHash,
  upToDate: true,
  sharePath:
    '/portal/plugins/collections/shared/f47ac10b-58cc-4372-a567-0e02b2c3d479',
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-02T10:00:00.000Z',
};
const share = {
  id: remoteId,
  name: 'Release kit',
  description: '',
  contentHash,
  itemCounts: { skills: 1, plugins: 1, customSkills: 1 },
  shareScope: 'team',
  owner: {
    type: 'team',
    id: 'team-1',
    name: 'Core',
    organization: { id: 'org-1', name: 'Acme' },
  },
  createdBy: { id: 'user-1', name: 'Ada', email: 'ada@example.com' },
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-02T10:00:00.000Z',
  canUpdate: true,
  canDelete: true,
  publicShare: null,
};
const keyedFailure = (code: string, retry: string): unknown => ({
  kind: 'not_found',
  message: 'Shared collection not found.',
  code,
  retry:
    retry === 'after_refresh'
      ? { kind: retry, resource: 'core.catalog.entry' }
      : { kind: retry },
});

describe('core.catalog collection publish contract (CAN-4170)', () => {
  it('publishes and unpublishes a collection with core.catalog.write, adding no grant', () => {
    for (const definition of [publish, unpublish]) {
      expect(definition.requiredGrants).toEqual([CATALOG_GRANTS.write]);
      expect(definition.idempotency).toBe('keyed');
    }
    expect(publish.params.safeParse(createShare).success).toBe(true);
    expect(
      unpublish.params.safeParse({
        kind: 'collection',
        publicationId: remoteId,
        scope: 'publicLink',
        expectedRemoteVersion: null,
        _meta: keyed,
      }).success,
    ).toBe(true);
  });

  it('carries no share account in the document it publishes', () => {
    expect(
      publish.params.safeParse({
        ...createShare,
        document: { ...document, accountId: 'user-1' },
      }).success,
    ).toBe(false);
  });

  it('keeps skill and plugin publish and unpublish byte-identical', async () => {
    // The hashes were taken on develop before kind collection joined. The
    // params hashes leave out `_meta`, which follows the shared request
    // metadata (checked below), so a metadata-wide field doesn't move them.
    expect(
      await sha256(
        CatalogEntryPublishParamsSchema.omit({ _meta: true }),
        'input',
      ),
    ).toBe('da9b37262b8b035dd7659897a31e5a03d620dc9e1416efc590c3d106c47263cd');
    expect(await sha256(CatalogEntryPublishResultSchema, 'output')).toBe(
      '711735d88dea663c3bc776ea9bf22476637045674f73e1687dfe3119cd69ff58',
    );
    expect(
      await sha256(
        CatalogEntryUnpublishParamsSchema.omit({ _meta: true }),
        'input',
      ),
    ).toBe('fd5742bc53834bd8644245b535c4932ef4fd192c9c17dadbb7ad37d9041c307f');
    const keyedMeta = z.toJSONSchema(
      CanopyRequestMetadataSchema.required({ idempotencyKey: true }),
      { io: 'input' },
    );
    for (const params of [
      CatalogEntryPublishParamsSchema,
      CatalogEntryUnpublishParamsSchema,
    ])
      expect(z.toJSONSchema(params.shape._meta, { io: 'input' })).toEqual(
        keyedMeta,
      );
    expect(await sha256(CatalogEntryUnpublishResultSchema, 'output')).toBe(
      '5304416126e561d39381eb09cbce52b4d2c4e841644b320d074269156ac88eff',
    );
    // The definitions compose that same object as their first branch.
    expect(CatalogEntryOrCollectionPublishParamsSchema.options[0]).toBe(
      CatalogEntryPublishParamsSchema,
    );
    expect(CatalogEntryOrCollectionPublishResultSchema.options[0]).toBe(
      CatalogEntryPublishResultSchema,
    );
    expect(CatalogEntryOrCollectionUnpublishParamsSchema.options[0]).toBe(
      CatalogEntryUnpublishParamsSchema,
    );
    expect(CatalogEntryOrCollectionUnpublishResultSchema.options[0]).toBe(
      CatalogEntryUnpublishResultSchema,
    );
    expect(publish.params).toBe(CatalogEntryOrCollectionPublishParamsSchema);
    expect(publish.result).toBe(CatalogEntryOrCollectionPublishResultSchema);
    expect(unpublish.params).toBe(
      CatalogEntryOrCollectionUnpublishParamsSchema,
    );
    expect(unpublish.result).toBe(
      CatalogEntryOrCollectionUnpublishResultSchema,
    );
    expect(CORE_CATALOG_PUBLISH_CODES).toEqual([
      'core.catalog.accountMismatch',
      'core.catalog.entryNotFound',
      'core.catalog.entryNameTaken',
      'core.catalog.entryReadOnly',
      'core.catalog.packageBlocked',
      'core.catalog.packageStale',
      'core.catalog.audienceWider',
      'core.catalog.revisionConflict',
      'core.catalog.remoteUnavailable',
      'core.catalog.visibilityInvalid',
    ]);
    expect(CORE_CATALOG_UNPUBLISH_CODES).toEqual([
      'core.catalog.publicationNotFound',
      'core.catalog.entryReadOnly',
      'core.catalog.remoteVersionConflict',
      'core.catalog.remoteUnavailable',
    ]);
    const skill = {
      entryId: 'skill:custom/notes',
      kind: 'skill',
      expectedRevision: 3,
      visibility: 'private',
      teamId: null,
      organizationId: null,
      package: {
        analysisId: 'analysis-1',
        selectedOptionalResourceIds: [],
        keepInStep: true,
      },
      _meta: keyed,
    };
    for (const request of [
      skill,
      { ...skill, kind: 'plugin', package: undefined },
    ]) {
      const parsed = publish.params.safeParse(request);
      expect(parsed.success).toBe(true);
      expect(parsed.data).toEqual(
        CatalogEntryPublishParamsSchema.parse(request),
      );
    }
    const result = {
      publicationId: 'pub-1',
      remoteEntryId: 'skill:cloud/notes',
      revision: 'rev-1',
    };
    expect(publish.result.parse(result)).toEqual(result);
  });

  it('takes the create, update and public link modes and refuses an unknown one', () => {
    for (const request of [createShare, updateShare, publicLink])
      expect(publish.params.safeParse(request).success).toBe(true);
    expect(
      publish.params.safeParse({
        ...createShare,
        audience: { visibility: 'private', teamId: null, organizationId: null },
        sourceEntryId: null,
        capabilityPackage: { version: 1, digest },
        committedPackageUploadId: 'upload-1',
        expectedAccountId: 'user-1',
      }).success,
    ).toBe(true);
    const without = (key: string): Record<string, unknown> =>
      Object.fromEntries(
        Object.entries(updateShare).filter(([field]) => field !== key),
      );
    const updateWithoutAudience = without('audience');
    const updateWithoutHash = without('expectedContentHash');
    expect(publish.params.safeParse(updateWithoutAudience).success).toBe(true);
    expect(publish.params.safeParse(updateWithoutHash).success).toBe(true);
    expect(
      publish.params.safeParse({ ...publicLink, mode: 'publish' }).success,
    ).toBe(false);
    expect(
      publish.params.safeParse({ ...publicLink, mode: undefined }).success,
    ).toBe(false);
    // A public link is its own mode, never an audience.
    expect(
      publish.params.safeParse({
        ...createShare,
        audience: {
          visibility: 'public_link',
          teamId: null,
          organizationId: null,
        },
      }).success,
    ).toBe(false);
    expect(publish.params.safeParse({ ...publicLink, document }).success).toBe(
      false,
    );
    expect(
      publish.params.safeParse({ ...createShare, publicationId: remoteId })
        .success,
    ).toBe(false);
    expect(
      publish.params.safeParse({ ...createShare, _meta: {} }).success,
    ).toBe(false);
    for (const scope of ['publicLink', 'share'])
      expect(
        unpublish.params.safeParse({
          kind: 'collection',
          publicationId: remoteId,
          scope,
          expectedRemoteVersion: contentHash,
          _meta: keyed,
        }).success,
      ).toBe(true);
    expect(
      unpublish.params.safeParse({
        kind: 'collection',
        publicationId: remoteId,
        scope: 'everything',
        expectedRemoteVersion: null,
        _meta: keyed,
      }).success,
    ).toBe(false);
  });

  it('refuses an unsafe publication id, hash, team or organization id before anything is sent', () => {
    const refused = (
      base: Record<string, unknown>,
      change: Record<string, unknown>,
    ): boolean => !publish.params.safeParse({ ...base, ...change }).success;
    for (const publicationId of [
      '../../etc',
      'https://example.com/c',
      'a/b',
      '',
    ]) {
      expect(refused(publicLink, { publicationId })).toBe(true);
      expect(refused(updateShare, { publicationId })).toBe(true);
      expect(
        unpublish.params.safeParse({
          kind: 'collection',
          publicationId,
          scope: 'share',
          expectedRemoteVersion: null,
          _meta: keyed,
        }).success,
      ).toBe(false);
    }
    expect(refused(updateShare, { expectedContentHash: 'abc' })).toBe(true);
    expect(refused(createShare, { sourceEntryId: 'skill:custom/x' })).toBe(
      true,
    );
    expect(refused(createShare, { sourceEntryId: '../collection' })).toBe(true);
    // A team share names its team, an organization share its organization
    // (as assertShareScopeTarget does today), and a private one neither.
    for (const audience of [
      { visibility: 'team', teamId: null, organizationId: 'org-1' },
      { visibility: 'team', teamId: '', organizationId: null },
      { visibility: 'organization', teamId: null, organizationId: null },
      { visibility: 'organization', teamId: 'team-1', organizationId: 'org-1' },
      { visibility: 'private', teamId: 'team-1', organizationId: null },
      { visibility: 'private', teamId: null, organizationId: 'org-1' },
    ])
      expect(refused(createShare, { audience })).toBe(true);
    expect(
      refused(createShare, {
        document: { ...document, serverId: 'https://example.com' },
      }),
    ).toBe(true);
    expect(refused(createShare, { document: { rawCollection: '' } })).toBe(
      true,
    );
    expect(
      refused(createShare, {
        capabilityPackage: { version: 1, digest: 'sha256:abc' },
      }),
    ).toBe(true);
    expect(refused(createShare, { serverId: 'canopy' })).toBe(true);
  });

  it('returns the share detail for a create and update, and the public share for a public link', () => {
    for (const mode of ['create', 'update'])
      expect(
        publish.result.safeParse({
          kind: 'collection',
          mode,
          publicationId: remoteId,
          share,
        }).success,
      ).toBe(true);
    expect(
      publish.result.safeParse({
        kind: 'collection',
        mode: 'create',
        publicationId: remoteId,
        share: { ...share, publicShare },
      }).success,
    ).toBe(true);
    expect(
      publish.result.safeParse({
        kind: 'collection',
        mode: 'publicLink',
        publicationId: remoteId,
        publicShare,
      }).success,
    ).toBe(true);
    for (const owner of [
      { type: 'system' },
      { type: 'user', id: 'user-1', name: null },
      { type: 'organization', id: 'org-1', name: 'Acme', slug: 'acme' },
    ])
      expect(
        publish.result.safeParse({
          kind: 'collection',
          mode: 'update',
          publicationId: remoteId,
          share: { ...share, owner },
        }).success,
      ).toBe(true);
    expect(
      publish.result.safeParse({
        kind: 'collection',
        mode: 'publicLink',
        publicationId: remoteId,
        share,
      }).success,
    ).toBe(false);
    expect(
      publish.result.safeParse({
        kind: 'collection',
        mode: 'create',
        publicationId: remoteId,
        share: { ...share, accessToken: 'secret' },
      }).success,
    ).toBe(false);
    for (const sharePath of [
      'https://example.com/portal/plugins/collections/shared/x',
      '/portal/../etc/passwd',
      '//example.com/x',
    ])
      expect(
        publish.result.safeParse({
          kind: 'collection',
          mode: 'publicLink',
          publicationId: remoteId,
          publicShare: { ...publicShare, sharePath },
        }).success,
      ).toBe(false);
    for (const scope of ['publicLink', 'share'])
      expect(
        unpublish.result.safeParse({
          kind: 'collection',
          scope,
          publicationId: remoteId,
        }).success,
      ).toBe(true);
  });

  it('registers the codes and retries for kind collection', () => {
    expect(CORE_CATALOG_COLLECTION_PUBLISH_CODES).toEqual([
      'core.catalog.accountMismatch',
      'core.catalog.entryNotFound',
      'core.catalog.remoteNotFound',
      'core.catalog.remoteAccessDenied',
      'core.catalog.remoteVersionConflict',
      'core.catalog.remoteUnavailable',
      'core.catalog.visibilityInvalid',
    ]);
    expect(CORE_CATALOG_COLLECTION_UNPUBLISH_CODES).toEqual([
      'core.catalog.remoteNotFound',
      'core.catalog.remoteAccessDenied',
      'core.catalog.remoteVersionConflict',
      'core.catalog.remoteUnavailable',
    ]);
    // Every collection code is one the catalog already registers.
    const registered = new Set<string>([
      ...CORE_CATALOG_PUBLISH_CODES,
      ...CORE_CATALOG_UNPUBLISH_CODES,
      ...Object.values(CATALOG_COLLECTION_ERROR_CODES),
    ]);
    for (const code of [
      ...CORE_CATALOG_COLLECTION_PUBLISH_CODES,
      ...CORE_CATALOG_COLLECTION_UNPUBLISH_CODES,
    ])
      expect(registered.has(code)).toBe(true);
    for (const code of CORE_CATALOG_COLLECTION_PUBLISH_CODES)
      expect(publish.error.safeParse(keyedFailure(code, 'never')).success).toBe(
        true,
      );
    for (const code of CORE_CATALOG_COLLECTION_UNPUBLISH_CODES)
      expect(
        unpublish.error.safeParse(keyedFailure(code, 'never')).success,
      ).toBe(true);
    expect(
      publish.error.safeParse(
        keyedFailure('core.catalog.remoteVersionConflict', 'after_refresh'),
      ).success,
    ).toBe(true);
    expect(
      publish.error.safeParse(
        keyedFailure('core.catalog.remoteNotFound', 'same_request'),
      ).success,
    ).toBe(false);
    expect(
      unpublish.error.safeParse(
        keyedFailure('core.catalog.installRollbackIncomplete', 'never'),
      ).success,
    ).toBe(false);
  });

  it('stays out of the composed registries; desktop refuses the collection branch until 5b', () => {
    const composed = Object.keys(CANOPY_INSTRUCTION_DEFINITIONS);
    expect(composed).not.toContain('core.catalog.entry.publish');
    expect(composed).not.toContain('core.catalog.entry.unpublish');
  });
});
