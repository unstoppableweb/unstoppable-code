// CAN-8015: the spec-first core.sharedArtifact contract. CAN-8016 serves it
// from the web core only; until then no composed registry carries it.
import { CANOPY_INSTRUCTION_DEFINITIONS, CANOPY_QUERY_DEFINITIONS } from '..';
import {
  CORE_ARTIFACT_QUERY_DEFINITIONS,
  CORE_SHARED_ARTIFACT_INSTRUCTIONS,
  CORE_SHARED_ARTIFACT_QUERIES,
  SHARED_ARTIFACT_ERROR_CODES,
  SHARED_ARTIFACT_GRANTS,
  SharedArtifactKindSchema,
  SharedArtifactReportReasonSchema,
  SharedArtifactRevisionSchema,
  SharedArtifactSchema,
  SharedArtifactShareScopeSchema,
} from '../core';
import {
  MAX_SHARED_ARTIFACT_AUTOMATION_ID_LENGTH,
  MAX_SHARED_ARTIFACT_AUTOMATION_LABEL_LENGTH,
  MAX_SHARED_ARTIFACT_BYTES,
  MAX_SHARED_ARTIFACT_REPORT_DETAIL_LENGTH,
  MAX_SHARED_ARTIFACT_RETAINED_REVISIONS,
  MAX_SHARED_ARTIFACT_TITLE_LENGTH,
  SHARED_ARTIFACT_KINDS,
  SHARED_ARTIFACT_LIST_DEFAULT_LIMIT,
  SHARED_ARTIFACT_LIST_MAX_LIMIT,
  SHARED_ARTIFACT_MEDIA_TYPES,
  SHARED_ARTIFACT_ORGANIZATION_QUOTA_BYTES,
  SHARED_ARTIFACT_PERSONAL_QUOTA_BYTES,
  SHARED_ARTIFACT_REPORT_REASONS,
  SHARED_ARTIFACT_SHARE_SCOPES,
  isSharedArtifactMediaTypeForKind,
  sharedArtifactContentPath,
  sharedArtifactSharePath,
  sharedArtifactUploadPath,
} from '../../shared-artifacts';

const queries = CORE_SHARED_ARTIFACT_QUERIES;
const instructions = CORE_SHARED_ARTIFACT_INSTRUCTIONS;
const all = { ...queries, ...instructions };
type OperationName = keyof typeof all;

const ARTIFACT = '7b0c3a52-1f7e-4a54-9a59-1f3c9d1e2b40';
const REVISION = '1c9e2f4a-3b5d-4e6f-8a7b-9c0d1e2f3a4b';
const UPLOAD = '2d0f3a5b-4c6e-4f70-9b8c-0d1e2f3a4b5c';
const GRANT = '3e1a4b6c-5d7f-4081-8c9d-1e2f3a4b5c6d';
const USER = '4f2b5c7d-6e80-4192-9dae-2f3a4b5c6d7e';
const TEAM = 'b4d6f0a2-6c1e-4b0e-8f3d-2a9c7e5d1f60';
const ORG = '0d9a8c7b-6e5f-4a3b-9c2d-1e0f9a8b7c6d';
const REPORT = '5a3c6d8e-7f91-42a3-8ebf-3a4b5c6d7e8f';
const AT = '2026-11-26T09:00:00.000Z';
const HASH = 'a'.repeat(64);
const meta = { _meta: { idempotencyKey: 'key-1' } };

const actor = { userId: USER, name: 'Ada' };
const revision = {
  id: REVISION,
  revisionNumber: 1,
  sha256: HASH,
  byteLength: 1024,
  mediaType: 'text/html',
  author: actor,
  createdAt: AT,
};
const artifact = {
  id: ARTIFACT,
  kind: 'html',
  mediaType: 'text/html',
  title: 'Launch notes',
  shareScope: 'team',
  owner: {
    type: 'team',
    teamId: TEAM,
    name: 'Platform',
    organization: { id: ORG, name: 'Acme' },
  },
  createdBy: actor,
  createdAt: AT,
  updatedAt: AT,
  public: { enabled: false, publishedAt: null, unpublishedAt: null },
  latestRevision: revision,
  revisionCount: 1,
  takedown: null,
  viewCounts: { total: 3, unique: 2 },
  permissions: {
    canEdit: true,
    canChangeAudience: true,
    canSetPublic: true,
    canUnshare: true,
    canViewAnalytics: true,
  },
  publicSharingAllowed: true,
};
const grant = {
  id: GRANT,
  artifactId: ARTIFACT,
  grantedBy: actor,
  automation: { id: 'automation-1', label: 'Nightly report' },
  createdAt: AT,
  lastUsedAt: null,
  revokedAt: null,
};
const upload = {
  id: UPLOAD,
  uploadPath: `/api/v1/shared-artifacts/uploads/${UPLOAD}`,
  expiresAt: AT,
  maxBytes: 1024,
};

const stageRequest = {
  target: { type: 'new' },
  kind: 'html',
  mediaType: 'text/html',
  byteLength: 1024,
  sha256: HASH,
  ...meta,
};
const commitRequest = {
  uploadId: UPLOAD,
  mode: {
    type: 'create',
    title: 'Launch notes',
    audience: { scope: 'team', teamId: TEAM },
  },
  ...meta,
};

const REQUESTS: Record<OperationName, Record<string, unknown>> = {
  'core.sharedArtifact.get': { artifactId: ARTIFACT },
  'core.sharedArtifact.list': { view: 'mine' },
  'core.sharedArtifact.stage': stageRequest,
  'core.sharedArtifact.commit': commitRequest,
  'core.sharedArtifact.republish': {
    artifactId: ARTIFACT,
    grantId: GRANT,
    uploadId: UPLOAD,
    automationId: 'automation-1',
    ...meta,
  },
  'core.sharedArtifact.updateAudience': {
    artifactId: ARTIFACT,
    audience: { scope: 'organization', organizationId: ORG },
    ...meta,
  },
  'core.sharedArtifact.setPublic': {
    artifactId: ARTIFACT,
    public: true,
    ...meta,
  },
  'core.sharedArtifact.unshare': { artifactId: ARTIFACT, ...meta },
  'core.sharedArtifact.report': {
    artifactId: ARTIFACT,
    reason: 'spam',
    detail: 'Advertising.',
    ...meta,
  },
  'core.sharedArtifact.takedown': {
    artifactId: ARTIFACT,
    action: { type: 'take_down', reason: 'malware_or_phishing' },
    ...meta,
  },
  'core.sharedArtifact.grant.create': {
    artifactId: ARTIFACT,
    automation: { id: 'automation-1', label: 'Nightly report' },
    ...meta,
  },
  'core.sharedArtifact.grant.revoke': {
    artifactId: ARTIFACT,
    grantId: GRANT,
    ...meta,
  },
};

const C = SHARED_ARTIFACT_ERROR_CODES;
const DECLARED_CODES: Record<OperationName, readonly string[]> = {
  'core.sharedArtifact.get': [C.storageUnavailable],
  'core.sharedArtifact.list': [C.storageUnavailable],
  'core.sharedArtifact.stage': [
    C.tooLarge,
    C.quotaExceeded,
    C.publicationDisabled,
    C.grantRequired,
    C.unsupportedContent,
    C.takenDown,
    C.storageUnavailable,
  ],
  'core.sharedArtifact.commit': [
    C.tooLarge,
    C.quotaExceeded,
    C.publicationDisabled,
    C.uploadNotReady,
    C.unsupportedContent,
    C.takenDown,
    C.storageUnavailable,
  ],
  'core.sharedArtifact.republish': [
    C.tooLarge,
    C.quotaExceeded,
    C.publicationDisabled,
    C.grantRequired,
    C.uploadNotReady,
    C.unsupportedContent,
    C.takenDown,
    C.storageUnavailable,
  ],
  'core.sharedArtifact.updateAudience': [
    C.quotaExceeded,
    C.publicSharingDisabled,
    C.takenDown,
    C.storageUnavailable,
  ],
  'core.sharedArtifact.setPublic': [
    C.publicSharingDisabled,
    C.takenDown,
    C.storageUnavailable,
  ],
  'core.sharedArtifact.unshare': [C.storageUnavailable],
  'core.sharedArtifact.report': [C.storageUnavailable],
  'core.sharedArtifact.takedown': [C.storageUnavailable],
  'core.sharedArtifact.grant.create': [C.storageUnavailable],
  'core.sharedArtifact.grant.revoke': [C.storageUnavailable],
};

const SECRETS = [
  'objectKey',
  'encryptedDataKey',
  'encryptionKeyVersion',
  'storageKey',
  'url',
  'signedUrl',
  'downloadUrl',
];

const params = (name: OperationName, value: unknown): boolean =>
  all[name].params.safeParse(value).success;

describe('core.sharedArtifact contract (CAN-8015)', () => {
  it('defines twelve operations with their kinds, idempotency and grants', () => {
    expect(Object.keys(queries).sort()).toEqual([
      'core.sharedArtifact.get',
      'core.sharedArtifact.list',
    ]);
    expect(Object.keys(instructions).sort()).toEqual(
      [
        'core.sharedArtifact.commit',
        'core.sharedArtifact.grant.create',
        'core.sharedArtifact.grant.revoke',
        'core.sharedArtifact.report',
        'core.sharedArtifact.republish',
        'core.sharedArtifact.setPublic',
        'core.sharedArtifact.stage',
        'core.sharedArtifact.takedown',
        'core.sharedArtifact.unshare',
        'core.sharedArtifact.updateAudience',
      ].sort(),
    );
    expect(SHARED_ARTIFACT_GRANTS).toEqual({
      read: 'core.sharedArtifact.read',
      write: 'core.sharedArtifact.write',
      moderate: 'core.sharedArtifact.moderate',
    });
    for (const definition of Object.values(queries)) {
      expect(definition.kind).toBe('query');
      expect(definition.idempotency).toBe('inherent');
      expect(definition.requiredGrants).toEqual([SHARED_ARTIFACT_GRANTS.read]);
    }
    for (const [name, definition] of Object.entries(instructions)) {
      expect(definition.kind).toBe('instruction');
      expect(definition.idempotency).toBe('keyed');
      expect(definition.requiredGrants).toEqual([
        name === 'core.sharedArtifact.takedown'
          ? SHARED_ARTIFACT_GRANTS.moderate
          : SHARED_ARTIFACT_GRANTS.write,
      ]);
    }
    for (const definition of Object.values(all)) {
      expect(definition.domain).toBe('sharedArtifact');
      expect(definition.placement).toBe('core-only');
      expect(definition.version).toBe(1);
    }
  });

  it('requires an idempotency key on every instruction and none on a query', () => {
    for (const [name, request] of Object.entries(REQUESTS) as [
      OperationName,
      Record<string, unknown>,
    ][]) {
      expect(params(name, request)).toBe(true);
      if (name in instructions) {
        const unkeyed = Object.fromEntries(
          Object.entries(request).filter(([key]) => key !== '_meta'),
        );
        expect(params(name, unkeyed)).toBe(false);
        expect(params(name, { ...request, _meta: {} })).toBe(false);
      } else {
        expect(params(name, { ...request, ...meta })).toBe(false);
      }
      expect(params(name, { ...request, unknown: true })).toBe(false);
    }
  });

  it('is spec-first: no composed registry serves it, and core.artifact is unchanged', () => {
    for (const name of Object.keys(queries))
      expect(Object.hasOwn(CANOPY_QUERY_DEFINITIONS, name)).toBe(false);
    for (const name of Object.keys(instructions))
      expect(Object.hasOwn(CANOPY_INSTRUCTION_DEFINITIONS, name)).toBe(false);
    expect(Object.keys(CORE_ARTIFACT_QUERY_DEFINITIONS).sort()).toEqual([
      'core.artifact.get',
      'core.artifact.list',
    ]);
  });

  it('pins the limits, kinds, media types, scopes and report reasons', () => {
    expect(MAX_SHARED_ARTIFACT_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_SHARED_ARTIFACT_RETAINED_REVISIONS).toBe(20);
    expect(SHARED_ARTIFACT_ORGANIZATION_QUOTA_BYTES).toBe(1024 * 1024 * 1024);
    expect(SHARED_ARTIFACT_PERSONAL_QUOTA_BYTES).toBe(100 * 1024 * 1024);
    expect(MAX_SHARED_ARTIFACT_TITLE_LENGTH).toBe(256);
    expect(SHARED_ARTIFACT_LIST_DEFAULT_LIMIT).toBe(20);
    expect(SHARED_ARTIFACT_LIST_MAX_LIMIT).toBe(50);
    expect(MAX_SHARED_ARTIFACT_REPORT_DETAIL_LENGTH).toBe(1000);
    expect(MAX_SHARED_ARTIFACT_AUTOMATION_ID_LENGTH).toBe(128);
    expect(MAX_SHARED_ARTIFACT_AUTOMATION_LABEL_LENGTH).toBe(256);
    expect(SHARED_ARTIFACT_MEDIA_TYPES).toEqual({
      html: ['text/html'],
      markdown: ['text/markdown'],
      image: [
        'image/png',
        'image/jpeg',
        'image/gif',
        'image/webp',
        'image/svg+xml',
      ],
      pdf: ['application/pdf'],
    });
    expect([...SHARED_ARTIFACT_KINDS]).toEqual(
      SharedArtifactKindSchema.options,
    );
    expect([...SHARED_ARTIFACT_KINDS]).toEqual([
      'html',
      'markdown',
      'image',
      'pdf',
    ]);
    expect([...SHARED_ARTIFACT_REPORT_REASONS]).toEqual(
      SharedArtifactReportReasonSchema.options,
    );
    expect([...SHARED_ARTIFACT_REPORT_REASONS]).toEqual([
      'malware_or_phishing',
      'illegal_content',
      'harassment',
      'private_information',
      'spam',
      'other',
    ]);
    expect([...SHARED_ARTIFACT_SHARE_SCOPES]).toEqual([
      'private',
      'team',
      'organization',
    ]);
    expect(SharedArtifactShareScopeSchema.options).toEqual([
      'private',
      'team',
      'organization',
    ]);
  });

  it('matches media types exactly against their kind', () => {
    for (const kind of SHARED_ARTIFACT_KINDS)
      for (const mediaType of SHARED_ARTIFACT_MEDIA_TYPES[kind])
        expect(isSharedArtifactMediaTypeForKind(kind, mediaType)).toBe(true);
    expect(isSharedArtifactMediaTypeForKind('html', 'text/markdown')).toBe(
      false,
    );
    expect(isSharedArtifactMediaTypeForKind('pdf', 'image/png')).toBe(false);
    expect(isSharedArtifactMediaTypeForKind('html', 'TEXT/HTML')).toBe(false);
    expect(
      isSharedArtifactMediaTypeForKind('html', 'text/html; charset=utf-8'),
    ).toBe(false);
    expect(isSharedArtifactMediaTypeForKind('image', 'image/svg+xml')).toBe(
      true,
    );
    for (const kind of ['html', 'markdown', 'pdf'] as const)
      expect(isSharedArtifactMediaTypeForKind(kind, 'image/svg+xml')).toBe(
        false,
      );
  });

  it('stages any positive byte length so the server answers tooLarge', () => {
    const stage = (overrides: Record<string, unknown>): boolean =>
      params('core.sharedArtifact.stage', { ...stageRequest, ...overrides });
    expect(stage({ byteLength: MAX_SHARED_ARTIFACT_BYTES })).toBe(true);
    expect(stage({ byteLength: MAX_SHARED_ARTIFACT_BYTES + 1 })).toBe(true);
    for (const byteLength of [0, -1, 1.5])
      expect(stage({ byteLength })).toBe(false);
    expect(stage({ sha256: 'A'.repeat(64) })).toBe(false);
    expect(stage({ sha256: 'a'.repeat(63) })).toBe(false);
    expect(stage({ target: { type: 'revision', artifactId: ARTIFACT } })).toBe(
      true,
    );
    expect(
      stage({
        target: { type: 'revision', artifactId: ARTIFACT, grantId: GRANT },
      }),
    ).toBe(true);
    expect(stage({ target: { type: 'revision' } })).toBe(false);
    expect(stage({ target: { type: 'new', artifactId: ARTIFACT } })).toBe(
      false,
    );
  });

  it('bounds revision byte length and number', () => {
    const parse = (overrides: Record<string, unknown>): boolean =>
      SharedArtifactRevisionSchema.safeParse({ ...revision, ...overrides })
        .success;
    expect(parse({})).toBe(true);
    expect(parse({ byteLength: MAX_SHARED_ARTIFACT_BYTES })).toBe(true);
    expect(parse({ byteLength: MAX_SHARED_ARTIFACT_BYTES + 1 })).toBe(false);
    expect(parse({ byteLength: 0 })).toBe(false);
    expect(parse({ revisionNumber: 0 })).toBe(false);
    expect(
      parse({ republish: { grantId: null, automationLabel: 'Nightly' } }),
    ).toBe(true);
    expect(parse({ author: { userId: null, name: null } })).toBe(true);
  });

  it('never carries a storage key, a wrapped key or a URL to a client', () => {
    const stage = instructions['core.sharedArtifact.stage'];
    for (const secret of SECRETS) {
      expect(
        SharedArtifactSchema.safeParse({ ...artifact, [secret]: 'x' }).success,
      ).toBe(false);
      expect(
        SharedArtifactRevisionSchema.safeParse({ ...revision, [secret]: 'x' })
          .success,
      ).toBe(false);
      expect(
        stage.result.safeParse({ upload: { ...upload, [secret]: 'x' } })
          .success,
      ).toBe(false);
    }
    expect(stage.result.safeParse({ upload }).success).toBe(true);
    expect(sharedArtifactUploadPath(UPLOAD)).toBe(upload.uploadPath);
    for (const uploadPath of [
      `https://canopy.example/api/v1/shared-artifacts/uploads/${UPLOAD}`,
      `//canopy.example/api/v1/shared-artifacts/uploads/${UPLOAD}`,
      `https://storage.googleapis.com/bucket/artifacts/${UPLOAD}?X-Goog-Signature=x`,
      `/api/v1/shared-artifacts/${UPLOAD}/content`,
      `/api/v1/shared-artifacts/uploads/${UPLOAD}?token=x`,
      `/api/v1/shared-artifacts/uploads/not-an-id`,
    ])
      expect(
        stage.result.safeParse({ upload: { ...upload, uploadPath } }).success,
      ).toBe(false);
  });

  it('keeps analytics, revisions and grants optional', () => {
    const withoutCounts = Object.fromEntries(
      Object.entries(artifact).filter(([key]) => key !== 'viewCounts'),
    );
    expect(SharedArtifactSchema.safeParse(withoutCounts).success).toBe(true);
    for (const revisionCount of [0, 21])
      expect(
        SharedArtifactSchema.safeParse({ ...artifact, revisionCount }).success,
      ).toBe(false);
    expect(
      SharedArtifactSchema.safeParse({ ...artifact, revisionCount: 20 })
        .success,
    ).toBe(true);
    expect(
      SharedArtifactSchema.safeParse({
        ...artifact,
        createdBy: { userId: null, name: null },
        public: { enabled: true, publishedAt: AT, unpublishedAt: null },
        takedown: { takenDownAt: AT, reason: 'spam' },
        publicSharingAllowed: false,
      }).success,
    ).toBe(true);
    for (const owner of [
      { type: 'user', userId: USER, name: null },
      { type: 'organization', organizationId: ORG, name: 'Acme' },
    ])
      expect(
        SharedArtifactSchema.safeParse({ ...artifact, owner }).success,
      ).toBe(true);
    expect(
      SharedArtifactSchema.safeParse({
        ...artifact,
        owner: { type: 'system', name: 'Canopy' },
      }).success,
    ).toBe(false);
    const get = queries['core.sharedArtifact.get'];
    expect(get.result.safeParse({ artifact }).success).toBe(true);
    expect(
      get.result.safeParse({
        artifact,
        revisions: [revision],
        republishGrants: [grant],
      }).success,
    ).toBe(true);
    expect(
      get.result.safeParse({
        artifact,
        revisions: Array.from({ length: 21 }, () => revision),
      }).success,
    ).toBe(false);
  });

  it('requires the audience id for team and organization only', () => {
    const update = (audience: unknown): boolean =>
      params('core.sharedArtifact.updateAudience', {
        artifactId: ARTIFACT,
        audience,
        ...meta,
      });
    expect(update({ scope: 'private' })).toBe(true);
    expect(update({ scope: 'team', teamId: TEAM })).toBe(true);
    expect(update({ scope: 'organization', organizationId: ORG })).toBe(true);
    expect(update({ scope: 'team' })).toBe(false);
    expect(update({ scope: 'organization' })).toBe(false);
    expect(update({ scope: 'private', teamId: TEAM })).toBe(false);
    expect(update({ scope: 'private', organizationId: ORG })).toBe(false);
    expect(update({ scope: 'public' })).toBe(false);
  });

  it('shapes the commit mode and takedown action unions', () => {
    const commit = (mode: unknown): boolean =>
      params('core.sharedArtifact.commit', { ...commitRequest, mode });
    expect(commit({ type: 'revise' })).toBe(true);
    expect(commit({ type: 'revise', title: 'New title' })).toBe(true);
    expect(commit({ type: 'create', audience: { scope: 'private' } })).toBe(
      false,
    );
    expect(commit({ type: 'create', title: 'Launch notes' })).toBe(false);
    const takedown = (action: unknown): boolean =>
      params('core.sharedArtifact.takedown', {
        artifactId: ARTIFACT,
        action,
        ...meta,
      });
    expect(takedown({ type: 'take_down', reason: 'spam', note: 'n' })).toBe(
      true,
    );
    expect(takedown({ type: 'take_down' })).toBe(false);
    expect(takedown({ type: 'restore' })).toBe(true);
    expect(takedown({ type: 'restore', note: 'Reviewed.' })).toBe(true);
    expect(takedown({ type: 'restore', reason: 'spam' })).toBe(false);
  });

  it('bounds titles, page sizes, notes and automation fields', () => {
    const create = (title: string): boolean =>
      params('core.sharedArtifact.commit', {
        ...commitRequest,
        mode: { ...commitRequest.mode, title },
      });
    expect(create('x'.repeat(MAX_SHARED_ARTIFACT_TITLE_LENGTH))).toBe(true);
    for (const title of ['', '   ', 'x'.repeat(257)])
      expect(create(title)).toBe(false);

    const list = (limit: number): boolean =>
      params('core.sharedArtifact.list', { view: 'mine', limit });
    expect(list(1)).toBe(true);
    expect(list(50)).toBe(true);
    expect(list(0)).toBe(false);
    expect(list(51)).toBe(false);
    expect(
      params('core.sharedArtifact.list', {
        view: 'organizationPublic',
        organizationId: ORG,
        cursor: 'next',
      }),
    ).toBe(true);
    expect(params('core.sharedArtifact.list', { view: 'everything' })).toBe(
      false,
    );

    const long = 'x'.repeat(MAX_SHARED_ARTIFACT_REPORT_DETAIL_LENGTH + 1);
    const ok = 'x'.repeat(MAX_SHARED_ARTIFACT_REPORT_DETAIL_LENGTH);
    const report = (detail: string): boolean =>
      params('core.sharedArtifact.report', {
        ...REQUESTS['core.sharedArtifact.report'],
        detail,
      });
    expect(report(ok)).toBe(true);
    expect(report(long)).toBe(false);
    const note = (value: string): boolean =>
      params('core.sharedArtifact.takedown', {
        artifactId: ARTIFACT,
        action: { type: 'restore', note: value },
        ...meta,
      });
    expect(note(ok)).toBe(true);
    expect(note(long)).toBe(false);

    const automation = (id: string, label: string): boolean =>
      params('core.sharedArtifact.grant.create', {
        artifactId: ARTIFACT,
        automation: { id, label },
        ...meta,
      });
    const id = 'i'.repeat(MAX_SHARED_ARTIFACT_AUTOMATION_ID_LENGTH);
    const label = 'l'.repeat(MAX_SHARED_ARTIFACT_AUTOMATION_LABEL_LENGTH);
    expect(automation(id, label)).toBe(true);
    expect(automation(`${id}i`, label)).toBe(false);
    expect(automation(id, `${label}l`)).toBe(false);
    expect(
      params('core.sharedArtifact.republish', {
        ...REQUESTS['core.sharedArtifact.republish'],
        automationId: `${id}i`,
      }),
    ).toBe(false);
  });

  it('declares exactly its typed refusal codes on each operation', () => {
    const allCodes = Object.values(SHARED_ARTIFACT_ERROR_CODES);
    expect(allCodes).toHaveLength(9);
    for (const [name, definition] of Object.entries(all) as [
      OperationName,
      (typeof all)[OperationName],
    ][]) {
      const declared = DECLARED_CODES[name];
      for (const code of allCodes)
        expect({
          name,
          code,
          accepted: definition.error.safeParse({
            kind: 'failed_precondition',
            message: 'Refused.',
            code,
            retry: { kind: 'never' },
          }).success,
        }).toEqual({ name, code, accepted: declared.includes(code) });
      expect(
        definition.error.safeParse({
          kind: 'not_found',
          message: 'Not found.',
          code: 'core.artifact.notFound',
          retry: { kind: 'never' },
        }).success,
      ).toBe(false);
      expect(
        definition.error.safeParse({
          kind: 'not_found',
          message: 'Not found.',
          retry: { kind: 'never' },
        }).success,
      ).toBe(true);
    }
  });

  it('builds the share, content and upload paths with encoded ids', () => {
    expect(sharedArtifactSharePath(ARTIFACT)).toBe(
      `/share/artifacts/${ARTIFACT}`,
    );
    expect(sharedArtifactContentPath(ARTIFACT)).toBe(
      `/api/v1/shared-artifacts/${ARTIFACT}/content`,
    );
    expect(sharedArtifactUploadPath(UPLOAD)).toBe(
      `/api/v1/shared-artifacts/uploads/${UPLOAD}`,
    );
    expect(sharedArtifactSharePath('a/b')).toBe('/share/artifacts/a%2Fb');
    expect(sharedArtifactContentPath('a/b')).toBe(
      '/api/v1/shared-artifacts/a%2Fb/content',
    );
    expect(sharedArtifactUploadPath('a/b')).toBe(
      '/api/v1/shared-artifacts/uploads/a%2Fb',
    );
  });

  it('returns grants and reports in their DTO shapes', () => {
    expect(
      instructions['core.sharedArtifact.grant.create'].result.safeParse({
        grant,
      }).success,
    ).toBe(true);
    expect(
      instructions['core.sharedArtifact.grant.revoke'].result.safeParse({
        grant: {
          ...grant,
          grantedBy: { userId: null, name: null },
          revokedAt: AT,
        },
      }).success,
    ).toBe(true);
    expect(
      instructions['core.sharedArtifact.report'].result.safeParse({
        report: {
          id: REPORT,
          artifactId: ARTIFACT,
          reason: 'other',
          createdAt: AT,
        },
      }).success,
    ).toBe(true);
    expect(
      instructions['core.sharedArtifact.unshare'].result.safeParse({
        unshared: false,
      }).success,
    ).toBe(true);
  });
});
