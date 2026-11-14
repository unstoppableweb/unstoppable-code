import { createHash } from 'node:crypto';
import {
  composeCanopyInstructionRegistries,
  CORE_ARCHIVE_COMMAND_INSTRUCTION_DEFINITIONS,
  CORE_WORKSPACE_COMMAND_INSTRUCTION_DEFINITIONS,
  CORE_WORKSPACE_IMPORT_INSTRUCTION_DEFINITIONS,
  type CanopyCallerDescriptor,
  type CanopyWorkspaceScope,
  type CoreWorkspaceCreateParams,
  type CoreWorkspaceCreateResult,
  type CoreWorktreeCommandResult,
  type CoreWorktreeCreateParams,
  type CoreWorktreeCreateResult,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../runtime/errors';
import type {
  CanopyDispatcherInstructionHandlerMap,
  CanopyHandlerContext,
} from '../../runtime/types';
import {
  toCoreLifecycleWireError,
  type CoreLifecycleWireProfile,
} from './lifecycle-wire-errors';

/*
 * The lifecycle commands, over a host port: the creates (W7b-3, CAN-5551)
 * #1 `core.workspace.create`, #2 `core.workspace.import` and #21
 * `core.worktree.create`, and (W7b-2a, CAN-5550) #24 `core.worktree.archive`
 * (inherent), #5 `core.workspace.delete` and #28
 * `core.archive.container.restore`, plus #25 `core.worktree.delete`
 * (W7b-2b, CAN-5575). Core admits the caller (Q8), maps the
 * wire request to what the host can serve (A5), refuses params the desktop
 * cannot honour before the host runs, derives the operation references
 * (DP-3) and answers the pages' results; the host resolves addressing, runs
 * the typed desktop boundaries and derives every owner, kind, path, source
 * and receipt scope (B7). Params never carry an owner, organization or host
 * path.
 */

/** Existing web-owned commands, plus #2 (W7b-3) and #28 (W7b-2a). */
export const CORE_WORKSPACE_LIFECYCLE_COMMAND_DEFINITIONS =
  composeCanopyInstructionRegistries(
    {
      'core.workspace.create':
        CORE_WORKSPACE_COMMAND_INSTRUCTION_DEFINITIONS['core.workspace.create'],
      'core.worktree.create':
        CORE_WORKSPACE_COMMAND_INSTRUCTION_DEFINITIONS['core.worktree.create'],
      'core.worktree.archive':
        CORE_WORKSPACE_COMMAND_INSTRUCTION_DEFINITIONS['core.worktree.archive'],
      'core.worktree.delete':
        CORE_WORKSPACE_COMMAND_INSTRUCTION_DEFINITIONS['core.worktree.delete'],
      'core.workspace.delete':
        CORE_WORKSPACE_COMMAND_INSTRUCTION_DEFINITIONS['core.workspace.delete'],
    },
    CORE_WORKSPACE_IMPORT_INSTRUCTION_DEFINITIONS,
    CORE_ARCHIVE_COMMAND_INSTRUCTION_DEFINITIONS,
  );

type Definitions = typeof CORE_WORKSPACE_LIFECYCLE_COMMAND_DEFINITIONS;
export type CoreWorkspaceLifecycleCommandName = Extract<
  keyof Definitions,
  string
>;
export type CoreWorkspaceLifecycleHandlers =
  CanopyDispatcherInstructionHandlerMap<Definitions>;

/** One keyed wire call: the authenticated caller and the request's key. */
export interface CoreWorkspaceLifecycleCall {
  readonly caller: CanopyCallerDescriptor;
  readonly idempotencyKey: string;
}

/** One call of the inherent archive, which carries no key. */
export type CoreWorkspaceLifecycleInherentCall = Pick<
  CoreWorkspaceLifecycleCall,
  'caller'
>;

/**
 * A request this host does not serve: the host answers `refusal` unless the
 * call is an in-process projection, which carries its own host request.
 */
export interface CoreLifecycleUnserved {
  readonly kind: 'unserved';
  readonly refusal: CanopyOperationError;
}

export type CoreWorkspaceCreateRequest =
  | {
      readonly kind: 'empty';
      readonly workspaceKind: 'single_repo' | 'multi_repo';
      readonly name: string;
    }
  | CoreLifecycleUnserved;

/** No import form is served until a selection service and a named clone exist. */
export type CoreWorkspaceImportRequest = CoreLifecycleUnserved;

export interface CoreWorktreeCreateRequest {
  readonly kind: 'worktree';
  readonly workspaceId: string;
  readonly branch?: string;
  readonly existingBranch?: string;
  readonly suggestedBranch?: string;
  readonly baseBranch?: string;
  readonly baseWorktreeId?: string;
  readonly includedRepositoryIds?: readonly string[];
  readonly sidebarItemGroupId?: string;
}

export interface CoreWorkspaceCreated {
  readonly workspaceId: string;
  readonly name: string;
  readonly kind: 'single_repo' | 'multi_repo' | 'cowork';
}

export interface CoreWorktreeCreated {
  readonly workspaceId: string;
  readonly worktreeId: string;
  readonly branchName: string;
  readonly setupPhase: 'git-pending' | 'git-ready';
  /** `failed` when the workspace root needs repair before the worktree is usable. */
  readonly status: 'completed' | 'failed';
}

export interface CoreWorkspaceLifecycleHost {
  createWorkspace(
    request: CoreWorkspaceCreateRequest,
    call: CoreWorkspaceLifecycleCall,
  ): Promise<CoreWorkspaceCreated>;
  importWorkspace(
    request: CoreWorkspaceImportRequest,
    call: CoreWorkspaceLifecycleCall,
  ): Promise<{ readonly workspaceId: string }>;
  createWorktree(
    request: CoreWorktreeCreateRequest | CoreLifecycleUnserved,
    call: CoreWorkspaceLifecycleCall,
  ): Promise<CoreWorktreeCreated>;
  /**
   * The archived worktree, projected from the row read before the effect
   * with `state: 'archived'`, or from the retained container on a repeat.
   */
  archiveWorktree(
    input: {
      worktreeId: string;
      scope?: CanopyWorkspaceScope;
      expectedRevision: number;
      expectedCreatedAt?: string;
    },
    call: CoreWorkspaceLifecycleInherentCall,
  ): Promise<CoreWorktreeCommandResult>;
  deleteWorkspace(
    input: { workspaceId: string; expectedRevision: number },
    call: CoreWorkspaceLifecycleCall,
  ): Promise<void>;
  /** P-1(i): the desktop Delete button's retained, unlocked lifecycle. */
  deleteWorktree(
    input: {
      worktreeId: string;
      scope?: CanopyWorkspaceScope;
      expectedRevision: number;
      expectedCreatedAt?: string;
    },
    call: CoreWorkspaceLifecycleCall,
  ): Promise<void>;
  /** Restores into the archive's own workspace, named by `workspaceId`. */
  restoreArchive(
    input: { archiveId: string; workspaceId: string; expectedRevision: number },
    call: CoreWorkspaceLifecycleCall,
  ): Promise<{ restoredScope: CanopyWorkspaceScope }>;
}

/**
 * Who may run the lifecycle commands (OD-4, Q8): the trusted core, and
 * desktop IPC callers (the local desktop user, and a paired controller whose
 * calls the IPC bridge tunnels, B5). Renderer relay surfaces
 * (`local-desktop-renderer:*`), Portal sessions and every other principal are
 * refused until W9, whatever their grants.
 */
export function isCoreWorkspaceLifecycleCaller(
  caller: Pick<
    CanopyCallerDescriptor,
    'principalId' | 'interfaceKind' | 'clientInstanceId'
  >,
): boolean {
  if (caller.principalId === 'core') return true;
  return (
    caller.interfaceKind === 'desktop' &&
    !caller.clientInstanceId.startsWith('portal-session:') &&
    (caller.principalId === 'local-desktop-user' ||
      caller.principalId.startsWith('remote-device:'))
  );
}

export const CORE_WORKSPACE_LIFECYCLE_CALLER_REFUSED_MESSAGE =
  'Projects and worktrees can be created only from the desktop app on this machine.';

/** The refusal of archive, archive restore and workspace delete. */
export const CORE_LIFECYCLE_ARCHIVE_CALLER_REFUSED_MESSAGE =
  'This caller cannot archive, restore or delete here.';

interface CoreLifecyclePage extends CoreLifecycleWireProfile {
  readonly callerRefusedMessage: string;
}

const CREATES = {
  callerRefusedMessage: CORE_WORKSPACE_LIFECYCLE_CALLER_REFUSED_MESSAGE,
};
const ARCHIVES = {
  callerRefusedMessage: CORE_LIFECYCLE_ARCHIVE_CALLER_REFUSED_MESSAGE,
  withholdStoredRevision: true,
};

/** Each operation's A7 page (`lifecycle-wire-errors.ts`) and caller refusal. */
const PAGES: Readonly<
  Record<CoreWorkspaceLifecycleCommandName, CoreLifecyclePage>
> = {
  'core.workspace.create': { ...CREATES, namespace: 'core.workspace' },
  'core.workspace.import': { ...CREATES, namespace: 'core.workspace' },
  'core.worktree.create': { ...CREATES, namespace: 'core.worktree' },
  'core.worktree.archive': {
    ...ARCHIVES,
    namespace: 'core.worktree',
    refreshResource: 'core.worktree.get',
    oneRecoveryReason: true,
  },
  'core.workspace.delete': {
    ...ARCHIVES,
    namespace: 'core.workspace',
    refreshResource: 'core.workspace.get',
  },
  'core.worktree.delete': {
    ...ARCHIVES,
    namespace: 'core.worktree',
    refreshResource: 'core.worktree.get',
  },
  // The destination worktrees collection carries the checked revision.
  'core.archive.container.restore': {
    ...ARCHIVES,
    namespace: 'core.archive',
    refreshResource: 'core.worktree.list',
  },
};

/**
 * The operation id of a keyed create, from the principal, the operation and
 * the key, shaped as the web core derives its own (a version-5 UUID), so a
 * retry answers the same reference (DP-3).
 */
export function deriveCoreLifecycleOperationId(
  principalId: string,
  operation: string,
  idempotencyKey: string,
): string {
  const hex = createHash('sha256')
    .update(
      JSON.stringify([principalId, operation, idempotencyKey, 'operation']),
    )
    .digest('hex');
  const variant = ((parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function refused(
  kind: 'invalid_argument' | 'capability_unavailable' | 'permission_denied',
  message: string,
  reason: string,
): CanopyOperationError {
  return new CanopyOperationError({
    kind,
    message,
    details: { reason },
    retry: { kind: 'never' },
  });
}

/** The only destination this host restores into: the archive's workspace. */
function destinationWorkspace(
  scope: CanopyWorkspaceScope,
  caller: CanopyCallerDescriptor,
): string {
  const { workspaceId, authorityId, ...others } = scope;
  if (
    Object.values(others).some((value) => value !== undefined) ||
    (authorityId !== undefined && authorityId !== caller.authorityId)
  )
    throw refused(
      'capability_unavailable',
      'This host restores an archive only into its own project.',
      'destination-unavailable',
    );
  if (workspaceId === undefined)
    throw refused(
      'invalid_argument',
      "Name the archive's project in destinationScope.workspaceId.",
      'destination-workspace-required',
    );
  return workspaceId;
}

function unserved(
  fields: readonly string[],
  message: string,
): CoreLifecycleUnserved {
  return {
    kind: 'unserved',
    refusal: new CanopyOperationError({
      kind: 'capability_unavailable',
      message,
      details: { reason: 'unserved', fields: [...fields] },
      retry: { kind: 'never' },
    }),
  };
}

/** A5 for #1: only an empty single- or multi-repository project is served. */
function createRequest(
  params: CoreWorkspaceCreateParams,
): CoreWorkspaceCreateRequest {
  if (params.temporary)
    return unserved(
      ['temporary'],
      'Temporary projects are unavailable on this host.',
    );
  // The web core's REST fields (CAN-6114): a desktop project is personal.
  if (params.ownerOrganizationId !== undefined)
    return unserved(
      ['ownerOrganizationId'],
      'An organization-owned project is unavailable on this host.',
    );
  if (params.firstWorkspaceOnly === true)
    return unserved(
      ['firstWorkspaceOnly'],
      'The first-project create is unavailable on this host.',
    );
  // Revision 2's project id claim (CAN-6093): a desktop project's id is
  // derived, so neither the revision nor the claim is served.
  const claimFields = (['workspaceId', 'revision'] as const).filter(
    (field) => params[field] !== undefined,
  );
  if (claimFields.length > 0)
    return unserved(
      claimFields,
      'Choosing the project id is unavailable on this host.',
    );
  // The web core's project template seed (CAN-6111).
  const blueprintFields = (
    ['blueprintExternalId', 'blueprintContentHash', 'blueprintSeed'] as const
  ).filter((field) => params[field] !== undefined);
  if (blueprintFields.length > 0)
    return unserved(
      blueprintFields,
      'A project created from a project template is unavailable on this host.',
    );
  const { source } = params;
  switch (source.kind) {
    case 'empty':
      return source.workspaceKind === 'cowork'
        ? unserved(
            ['source.workspaceKind'],
            'Creating a Cowork project is unavailable on this host.',
          )
        : {
            kind: 'empty',
            workspaceKind: source.workspaceKind,
            name: params.name,
          };
    case 'local_repository':
      // No portable-root grant service exists yet (CAN-5487).
      return unserved(
        ['source.rootGrantId'],
        'Choosing a local folder is unavailable on this host.',
      );
    case 'remote_repositories':
      // The desktop clone names the project after its repository.
      return unserved(
        ['source.repositories'],
        'Cloning a project under a chosen name is unavailable on this host.',
      );
    case 'integration_resources':
      return unserved(
        ['source.integrationId'],
        'Creating a project from an integration is unavailable on this host.',
      );
  }
}

/** A5 for #2: no source kind is served yet. */
function importRequest(
  params: Parameters<
    CoreWorkspaceLifecycleHandlers['core.workspace.import']
  >[0],
): CoreWorkspaceImportRequest {
  if (params.targetId != null)
    return unserved(
      ['targetId'],
      'Choosing a target is unavailable on this host.',
    );
  switch (params.source.kind) {
    case 'local_picker_selection':
      return unserved(
        ['source.selectionId'],
        'Choosing a local folder is unavailable on this host.',
      );
    case 'git_url':
      return unserved(
        ['source.value'],
        'Cloning a project under a chosen name is unavailable on this host.',
      );
    case 'provider_project':
      return unserved(
        ['source.value'],
        'Importing a provider project is unavailable on this host.',
      );
  }
}

/** A5 for #21: an exact base head and a target are not served (B6). */
function worktreeRequest(
  params: CoreWorktreeCreateParams,
): CoreWorktreeCreateRequest | CoreLifecycleUnserved {
  const fields = [
    ...(params.baseHeadSha == null ? [] : ['baseHeadSha']),
    ...(params.targetId == null ? [] : ['targetId']),
  ];
  if (fields.length > 0)
    return unserved(
      fields,
      'An exact base commit or a target is unavailable on this host.',
    );
  // The web core's REST fields (CAN-6114): this host names its own worktree
  // and starts no chat with it.
  const web = (['worktreeId', 'firstChat', 'firstMessage'] as const).filter(
    (field) => params[field] !== undefined,
  );
  if (web.length > 0)
    return unserved(
      web,
      'A first chat or a caller-named worktree is unavailable on this host.',
    );
  return {
    kind: 'worktree',
    workspaceId: params.workspaceId,
    ...(params.branch !== undefined && { branch: params.branch }),
    ...(params.existingBranch !== undefined && {
      existingBranch: params.existingBranch,
    }),
    ...(params.suggestedBranch !== undefined && {
      suggestedBranch: params.suggestedBranch,
    }),
    ...(params.baseBranch !== undefined && { baseBranch: params.baseBranch }),
    ...(params.baseWorktreeId !== undefined && {
      baseWorktreeId: params.baseWorktreeId,
    }),
    ...(params.includedRepositoryIds !== undefined && {
      includedRepositoryIds: params.includedRepositoryIds,
    }),
    ...(params.sidebarItemGroupId !== undefined && {
      sidebarItemGroupId: params.sidebarItemGroupId,
    }),
  };
}

function call(context: CanopyHandlerContext): CoreWorkspaceLifecycleCall {
  const key = context.metadata.idempotencyKey;
  // The dispatcher refuses a keyed instruction without a key first.
  if (!key) throw new Error('An idempotency key is required.');
  return { caller: context.caller, idempotencyKey: key };
}

/** The lifecycle handlers over `host`; register them only where `host` runs. */
export function createCoreWorkspaceLifecycleHandlers(
  host: CoreWorkspaceLifecycleHost,
): CoreWorkspaceLifecycleHandlers {
  const admitted = async <Result>(
    operation: CoreWorkspaceLifecycleCommandName,
    context: CanopyHandlerContext,
    command: () => Promise<Result>,
  ): Promise<Result> => {
    const page = PAGES[operation];
    if (!isCoreWorkspaceLifecycleCaller(context.caller))
      throw refused(
        'permission_denied',
        page.callerRefusedMessage,
        'caller-refused',
      );
    try {
      return await command();
    } catch (error) {
      throw toCoreLifecycleWireError(
        CORE_WORKSPACE_LIFECYCLE_COMMAND_DEFINITIONS[operation],
        page,
        error,
      );
    }
  };
  const run = <Result>(
    operation: CoreWorkspaceLifecycleCommandName,
    context: CanopyHandlerContext,
    command: (call: CoreWorkspaceLifecycleCall) => Promise<Result>,
  ): Promise<Result> =>
    admitted(operation, context, () => command(call(context)));
  const reference = <Operation extends CoreWorkspaceLifecycleCommandName>(
    operation: Operation,
    wireCall: CoreWorkspaceLifecycleCall,
    status: 'completed' | 'failed',
  ): {
    operationId: string;
    kind: Operation;
    status: 'completed' | 'failed';
  } => ({
    operationId: deriveCoreLifecycleOperationId(
      wireCall.caller.principalId,
      operation,
      wireCall.idempotencyKey,
    ),
    kind: operation,
    status,
  });
  return {
    'core.workspace.create': (params, context) =>
      run(
        'core.workspace.create',
        context,
        async (wireCall): Promise<CoreWorkspaceCreateResult> => {
          const created = await host.createWorkspace(
            createRequest(params),
            wireCall,
          );
          // Revisions and times follow the read, which has none here (D-2);
          // a new desktop project records no remote, so it lists none.
          return {
            workspace: {
              workspaceId: created.workspaceId,
              name: created.name,
              kind: created.kind,
              temporary: false,
              repositories: [],
            },
            operation: null,
          };
        },
      ),
    'core.workspace.import': (params, context) =>
      run('core.workspace.import', context, async (wireCall) => {
        const { workspaceId } = await host.importWorkspace(
          importRequest(params),
          wireCall,
        );
        return {
          ...reference('core.workspace.import', wireCall, 'completed'),
          workspaceId,
        };
      }),
    'core.worktree.create': (params, context) =>
      run(
        'core.worktree.create',
        context,
        async (wireCall): Promise<CoreWorktreeCreateResult> => {
          const created = await host.createWorktree(
            worktreeRequest(params),
            wireCall,
          );
          return {
            ...reference('core.worktree.create', wireCall, created.status),
            workspaceId: created.workspaceId,
            worktreeId: created.worktreeId,
            branchName: created.branchName,
            setupPhase: created.setupPhase,
          };
        },
      ),
    'core.worktree.archive': (params, context) =>
      admitted('core.worktree.archive', context, () => {
        // The cloud lifecycle route's archive bodies are the web core's (CAN-6110).
        if (
          [
            params.wake,
            params.cancelProvisioning,
            params.choice,
            params.continueArchive,
            params.expectedArchiveAttempt,
          ].some((value) => value !== undefined)
        )
          throw refused(
            'capability_unavailable',
            "This host can't wake, cancel or continue a cloud archive.",
            'cloud-lifecycle-unavailable',
          );
        // D-6(1): the desktop restores through the keyed container restore.
        if (!params.archived)
          throw refused(
            'invalid_argument',
            'Restore an archived worktree with core.archive.container.restore.',
            'use-container-restore',
          );
        return host.archiveWorktree(
          {
            worktreeId: params.worktreeId,
            expectedRevision: params.expectedRevision,
            ...(params.scope !== undefined && { scope: params.scope }),
            ...(params.expectedCreatedAt !== undefined && {
              expectedCreatedAt: params.expectedCreatedAt,
            }),
          },
          { caller: context.caller },
        );
      }),
    'core.worktree.delete': (params, context) =>
      admitted('core.worktree.delete', context, async () => {
        if (params.force)
          throw refused(
            'capability_unavailable',
            "This host can't force a worktree deletion.",
            'force-unavailable',
          );
        const wireCall = call(context);
        await host.deleteWorktree(
          {
            worktreeId: params.worktreeId,
            expectedRevision: params.expectedRevision,
            ...(params.scope !== undefined && { scope: params.scope }),
            ...(params.expectedCreatedAt !== undefined && {
              expectedCreatedAt: params.expectedCreatedAt,
            }),
          },
          wireCall,
        );
        return reference('core.worktree.delete', wireCall, 'completed');
      }),
    'core.workspace.delete': (params, context) =>
      admitted('core.workspace.delete', context, async () => {
        // B6: `false` is a no-op; the desktop keeps every remote branch.
        if (params.deleteRemoteBranches === true)
          throw refused(
            'capability_unavailable',
            "This host can't delete remote branches.",
            'delete-remote-branches-unavailable',
          );
        // CAN-6109: only the web core keeps a whole project archived.
        if (params.mode === 'archive')
          throw refused(
            'capability_unavailable',
            "This host can't keep a project archived.",
            'archive-mode-unavailable',
          );
        const wireCall = call(context);
        await host.deleteWorkspace(
          {
            workspaceId: params.workspaceId,
            expectedRevision: params.expectedRevision,
          },
          wireCall,
        );
        return reference('core.workspace.delete', wireCall, 'completed');
      }),
    'core.archive.container.restore': (params, context) =>
      admitted('core.archive.container.restore', context, async () => {
        const workspaceId = destinationWorkspace(
          params.destinationScope,
          context.caller,
        );
        // The desktop never merges into or renames over an existing worktree.
        if (params.conflictPolicy !== 'fail')
          throw refused(
            'capability_unavailable',
            'This host restores an archive only with the fail conflict policy.',
            'conflict-policy-unavailable',
          );
        const wireCall = call(context);
        const { restoredScope } = await host.restoreArchive(
          {
            archiveId: params.archiveId,
            workspaceId,
            expectedRevision: params.expectedRevision,
          },
          wireCall,
        );
        return {
          operation: reference(
            'core.archive.container.restore',
            wireCall,
            'completed',
          ),
          restoredScope,
        };
      }),
  };
}
