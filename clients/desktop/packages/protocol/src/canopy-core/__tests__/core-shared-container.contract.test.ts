// CAN-6501 PR 5: the spec-first contract for the shared-container publisher
// scope and recipient state that desktop's shared-containers IPC serves today.
// No composed registry carries these operations, so every runtime answers
// capability_unavailable until a later CAN-6501 PR adds the handlers.
import { CANOPY_INSTRUCTION_DEFINITIONS, CANOPY_QUERY_DEFINITIONS } from '..';
import {
  CORE_PUBLICATION_SHARED_CONTAINER_INSTRUCTION_DEFINITIONS,
  CORE_PUBLICATION_SHARED_CONTAINER_QUERY_DEFINITIONS,
  CORE_SHARED_CONTAINER_QUERY_DEFINITIONS,
} from '../core';

const fileScopeGet =
  CORE_PUBLICATION_SHARED_CONTAINER_QUERY_DEFINITIONS[
    'core.publication.fileScope.get'
  ];
const previewGet =
  CORE_PUBLICATION_SHARED_CONTAINER_QUERY_DEFINITIONS[
    'core.publication.preview.get'
  ];
const fileScopeUpdate =
  CORE_PUBLICATION_SHARED_CONTAINER_INSTRUCTION_DEFINITIONS[
    'core.publication.fileScope.update'
  ];
const acceptanceList =
  CORE_SHARED_CONTAINER_QUERY_DEFINITIONS[
    'core.sharedContainer.acceptance.list'
  ];
const forkProvenanceGet =
  CORE_SHARED_CONTAINER_QUERY_DEFINITIONS[
    'core.sharedContainer.forkProvenance.get'
  ];
const runGet =
  CORE_SHARED_CONTAINER_QUERY_DEFINITIONS['core.sharedContainer.run.get'];

const CONTAINER = '00000000-0000-4000-8000-00000000c001';
const ORGANIZATION = '00000000-0000-4000-8000-00000000a001';
const AT = '2026-11-01T12:00:00.000Z';
const worktree = { projectId: 'golden', worktreeId: 'golden-tree' };

// The answers shared-container-local-state-golden pins for each channel.
const fileScope = {
  excludedNoteIds: ['note-1'],
  excludedPaths: ['draft.txt'],
  includedNoteIds: [],
  includedPaths: [],
  includedPromptIds: [],
  includedRunScripts: [],
  preferredLayout: { enabled: false },
  runSharingDisabled: true,
  runSharingEnabled: false,
};
const preview = {
  approvedFileScope: fileScope,
  artifactBudget: { limit: 200, used: 3 },
  attachmentCount: 0,
  chatCount: 0,
  containerType: 'CODE_WORKTREE',
  defaultIncludedFilePaths: ['notes.txt'],
  dirtyFileCount: 1,
  noteCount: 0,
  notes: [],
  planCount: 0,
  promptCount: 0,
  prompts: [],
  repository: {
    baseCommitSha: '8d787badf6ddea30e8dff0c326380c9a9c332e44',
    remoteUrl: 'https://github.com/example/golden.git',
  },
  startPage: null,
  undisclosedRepositoryCount: 0,
  untrackedCandidateCount: 2,
  untrackedCandidates: ['notes.txt', 'draft.txt'],
};
const runStatus = {
  allowed: true,
  allowedAt: AT,
  hasRunningProcesses: false,
  publisherUserId: '00000000-0000-4000-8000-00000000b001',
  run: {
    commands: [{ command: 'pnpm dev', name: 'dev', repoId: 'app' }],
    requiredEnv: ['API_TOKEN', 'REGION'],
  },
  runCopyNeedsRefresh: true,
  runCopySizeBytes: '4096',
  unsetRequiredEnv: ['REGION'],
  values: [
    {
      key: 'API_TOKEN',
      value: {
        kind: 'stored-secret',
        ref: 'ssr1_YlAzKBJbiNgvIrzZuo2PqyxmiEYOvRKvKDuNJcvX1fU',
      },
    },
  ],
};

describe('core.publication / core.sharedContainer shared-container contract (CAN-6501)', () => {
  it('reuses the existing grants, keys the scope write and composes nothing', () => {
    expect(
      [
        fileScopeGet,
        previewGet,
        fileScopeUpdate,
        acceptanceList,
        forkProvenanceGet,
        runGet,
      ].map(({ kind, idempotency, placement, requiredGrants }) => [
        kind,
        idempotency,
        placement,
        requiredGrants,
      ]),
    ).toEqual([
      ['query', 'inherent', 'core-only', ['core.publication.read']],
      ['query', 'inherent', 'core-only', ['core.publication.read']],
      ['instruction', 'keyed', 'core-only', ['core.publication.write']],
      ['query', 'inherent', 'core-only', ['core.publication.read']],
      ['query', 'inherent', 'core-only', ['core.workspace.read']],
      ['query', 'inherent', 'core-only', ['core.publication.read']],
    ]);
    const composed = [
      ...Object.keys(CANOPY_QUERY_DEFINITIONS),
      ...Object.keys(CANOPY_INSTRUCTION_DEFINITIONS),
    ];
    for (const name of [
      ...Object.keys(CORE_PUBLICATION_SHARED_CONTAINER_QUERY_DEFINITIONS),
      ...Object.keys(CORE_PUBLICATION_SHARED_CONTAINER_INSTRUCTION_DEFINITIONS),
      ...Object.keys(CORE_SHARED_CONTAINER_QUERY_DEFINITIONS),
    ])
      expect(composed).not.toContain(name);
  });

  it('takes a scope save as save-file-scope does and answers the normalized scope', () => {
    const request = {
      ...worktree,
      includedPaths: ['draft.txt'],
      excludedPaths: ['draft.txt'],
      excludedNoteIds: ['note-1'],
      runSharingDisabled: true,
      preferredLayout: 'clear',
    };
    expect(fileScopeUpdate.params.safeParse(request).success).toBe(true);
    for (const refused of [
      { ...request, projectId: 'Golden' },
      { ...request, includedPaths: undefined },
      { ...request, includedPaths: Array(201).fill('a.txt') },
      { ...request, excludedNoteIds: Array(1001).fill('n') },
      { ...request, includedRunScripts: Array(9).fill('dev') },
      { ...request, legacyAllowlist: 'yes' },
      { ...request, preferredLayout: 'pin' },
      { ...request, organizationId: ORGANIZATION },
    ])
      expect(fileScopeUpdate.params.safeParse(refused).success).toBe(false);
    expect(fileScopeUpdate.result.safeParse({ fileScope }).success).toBe(true);
    expect(
      fileScopeUpdate.result.safeParse({
        fileScope: {
          ...fileScope,
          preferredLayout: { enabled: true, pinnedAt: AT },
        },
      }).success,
    ).toBe(true);
    // The pinned layout snapshot holds host paths and never leaves the core.
    expect(
      fileScopeUpdate.result.safeParse({
        fileScope: {
          ...fileScope,
          preferredLayout: { enabled: true, pinnedAt: AT, snapshot: {} },
        },
      }).success,
    ).toBe(false);
    expect(fileScopeGet.params.safeParse(worktree).success).toBe(true);
    expect(fileScopeGet.result.safeParse({ fileScope }).success).toBe(true);
    // An explicit allowlist stays one whatever excludedPaths holds.
    const allowlist = {
      ...fileScope,
      legacyAllowlist: true,
      includedPaths: ['notes.txt'],
      excludedPaths: [],
    };
    expect(fileScopeGet.result.parse({ fileScope: allowlist })).toEqual({
      fileScope: allowlist,
    });
    // The store keeps any id its charset allows, so a saved id reads back.
    const longId = 'n'.repeat(600);
    expect(
      fileScopeUpdate.params.safeParse({
        ...request,
        includedNoteIds: [longId],
      }).success,
    ).toBe(true);
    expect(
      fileScopeGet.result.safeParse({
        fileScope: { ...fileScope, includedNoteIds: [longId] },
      }).success,
    ).toBe(true);
  });

  it('replays a scope save only under its key and refuses reuse as a conflict', () => {
    expect(
      fileScopeUpdate.error.safeParse({
        kind: 'conflict',
        message: 'The idempotency key was used with other params.',
        retry: { kind: 'never' },
      }).success,
    ).toBe(true);
    expect(
      fileScopeUpdate.error.safeParse({
        kind: 'unavailable',
        message: 'Try again.',
        retry: { kind: 'same_idempotency_key' },
      }).success,
    ).toBe(true);
    expect(
      fileScopeUpdate.error.safeParse({
        kind: 'unavailable',
        message: 'Try again.',
        retry: { kind: 'same_request' },
      }).success,
    ).toBe(false);
  });

  it('previews a share target with the pushed repository and no credentials', () => {
    const target = { ...worktree, containerType: 'CODE_WORKTREE' };
    expect(previewGet.params.safeParse(target).success).toBe(true);
    expect(
      previewGet.params.safeParse({
        ...target,
        organizationId: ORGANIZATION,
        audience: 'public',
      }).success,
    ).toBe(true);
    for (const refused of [
      { ...target, containerType: 'GIT_REPO' },
      { ...target, audience: 'everyone' },
      { ...target, worktreeId: 'Golden Tree' },
    ])
      expect(previewGet.params.safeParse(refused).success).toBe(false);
    expect(previewGet.result.safeParse(preview).success).toBe(true);
    // A Cowork preview's picker rows carry raw Markdown stems as desktop
    // passes them through; a file named `.md` gives an empty id.
    expect(
      previewGet.result.safeParse({
        ...preview,
        containerType: 'COWORK_WORK_ENTRY',
        repository: undefined,
        defaultIncludedFilePaths: [],
        dirtyFileCount: 0,
        untrackedCandidateCount: 0,
        untrackedCandidates: [],
        noteCount: 3,
        notes: [
          { id: '', title: '' },
          { id: 'my note', title: 'my note' },
          { id: 'release.v2', title: 'release.v2' },
        ],
        promptCount: 2,
        prompts: [
          { id: '', title: '' },
          { id: 'review (draft)', title: 'review (draft)' },
        ],
      }).success,
    ).toBe(true);
    expect(
      previewGet.result.safeParse({
        ...preview,
        repository: {
          ...preview.repository,
          remoteUrl: 'https://user:token@github.com/example/golden.git',
        },
      }).success,
    ).toBe(false);
  });

  it('lists accepted containers by identity, never their run consent', () => {
    expect(acceptanceList.params.safeParse({}).success).toBe(true);
    const listed = {
      containerIds: [CONTAINER, '00000000-0000-4000-8000-00000000c002'],
      records: {
        [CONTAINER]: {
          acceptedAt: AT,
          access: 'organization',
          organizationId: ORGANIZATION,
        },
        '00000000-0000-4000-8000-00000000c002': {
          acceptedAt: AT,
          access: 'direct',
        },
      },
    };
    expect(acceptanceList.result.safeParse(listed).success).toBe(true);
    expect(
      acceptanceList.result.safeParse({ containerIds: [], records: {} })
        .success,
    ).toBe(true);
    expect(
      acceptanceList.result.safeParse({
        ...listed,
        records: {
          [CONTAINER]: { ...listed.records[CONTAINER], runAllowedAt: AT },
        },
      }).success,
    ).toBe(false);
  });

  it('reads one worktree fork provenance, or null', () => {
    expect(forkProvenanceGet.params.safeParse(worktree).success).toBe(true);
    expect(
      forkProvenanceGet.params.safeParse({ ...worktree, containerId: 'c' })
        .success,
    ).toBe(false);
    expect(
      forkProvenanceGet.result.safeParse({ provenance: null }).success,
    ).toBe(true);
    expect(
      forkProvenanceGet.result.safeParse({
        provenance: {
          forkedAt: AT,
          organizationId: ORGANIZATION,
          sourceContainerId: CONTAINER,
          sourceOwnerDisplayName: 'Example Publisher',
          sourceRevisionCreatedAt: AT,
          sourceRevisionId: '00000000-0000-4000-8000-00000000e001',
        },
      }).success,
    ).toBe(true);
  });

  it('answers run status with stored-secret references, never a run-environment value', () => {
    const request = {
      containerId: CONTAINER,
      revisionId: '00000000-0000-4000-8000-00000000e001',
    };
    expect(runGet.params.safeParse(request).success).toBe(true);
    expect(
      runGet.params.safeParse({ ...request, revisionId: 'Rev 1' }).success,
    ).toBe(false);
    expect(runGet.result.safeParse(runStatus).success).toBe(true);
    expect(
      runGet.result.safeParse({
        ...runStatus,
        values: [{ key: 'REGION', value: '' }],
      }).success,
    ).toBe(true);
    expect(
      runGet.result.safeParse({
        ...runStatus,
        values: [{ key: 'API_TOKEN', value: 'plaintext-secret' }],
      }).success,
    ).toBe(false);
    for (const code of [
      'core.sharedContainer.notAccepted',
      'core.sharedContainer.revisionUnavailable',
    ])
      expect(
        runGet.error.safeParse({
          kind: 'failed_precondition',
          code,
          message: 'Shared-container revision is not available',
          retry: { kind: 'after_refresh', resource: CONTAINER },
        }).success,
      ).toBe(true);
    expect(
      runGet.error.safeParse({
        kind: 'capability_unavailable',
        message: 'Shared-container run is disabled.',
        retry: { kind: 'never' },
      }).success,
    ).toBe(true);
  });
});
