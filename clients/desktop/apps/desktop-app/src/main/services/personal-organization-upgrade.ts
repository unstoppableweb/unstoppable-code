import { createHash } from 'node:crypto';
import { withPersonalProjectPreviewDeadline } from './personal-project-preview';
import { InvalidCanopyJsonError } from '../lib/canopy-json';
import type { CanopyCloudCredentialContext } from '../canopy-cloud/client';
import type { PersonalOrganizationUpgradeJournal } from '../lib/personal-organization-upgrade-journal';
import type { OrgMemberCreationOptions } from '../lib/org-member-code-create';
import type {
  CreateOrgMemberCodeProjectResult,
  CreateOrgMemberMultiRepoProjectResult,
} from '@canopy/desktop-shared/types';
import {
  PersonalProjectConversionRequestSchema,
  type PersonalProject,
  type PersonalProjectOutcome,
  type PersonalProjectOperation,
  type PersonalProjectConversionRequest,
  type PersonalOrganizationPromotionOutcome,
  type UpgradePersonalOrganizationRequest,
  type UpgradePersonalOrganizationResult,
  type SendOrganizationInviteRequest,
  type OrganizationInviteResult,
  type OrganizationInviteStatus,
} from '@canopy/protocol/organizations';

export interface UpgradeWorkspace extends PersonalProject {
  path: string;
  owner?: { organizationId: string; projectId: string };
}
export interface UpgradeIdentity {
  accountId: string;
  epoch: number;
  credentials: CanopyCloudCredentialContext;
}
export interface PersonalOrganizationUpgradeDeps {
  onPromotion?(this: void, result: UpgradePersonalOrganizationResult): void;
  onInvite?(this: void, result: OrganizationInviteResult): void;
  identity(this: void): Promise<UpgradeIdentity>;
  sessionCurrent(this: void, sessionId: string): boolean;
  destination(
    this: void,
    organizationId: string,
    identity: UpgradeIdentity,
  ): Promise<boolean>;
  workspaces(
    this: void,
    selected?: {
      workspaceIds: readonly string[];
      reportInvalidConfig: (workspaceId: string) => void;
    },
  ): Promise<UpgradeWorkspace[]>;
  previewProjects(this: void, signal?: AbortSignal): Promise<PersonalProject[]>;
  promote(
    this: void,
    request: UpgradePersonalOrganizationRequest,
    identity: UpgradeIdentity,
  ): Promise<UpgradePersonalOrganizationResult>;
  suppress(this: void, organizationId: string): Promise<void>;
  refreshAccount(
    this: void,
    identity: UpgradeIdentity,
  ): Promise<UpgradeIdentity>;
  switchContext(this: void, organizationId: string): Promise<void>;
  invite(
    this: void,
    organizationId: string,
    request: SendOrganizationInviteRequest,
    identity: UpgradeIdentity,
  ): Promise<OrganizationInviteResult>;
  inviteStatus(
    this: void,
    organizationId: string,
    email: string,
    identity: UpgradeIdentity,
  ): Promise<OrganizationInviteStatus>;
  createSingle(
    this: void,
    workspace: UpgradeWorkspace,
    organizationId: string,
    creationKey: string,
    projectId: string | undefined,
    options: OrgMemberCreationOptions,
  ): Promise<CreateOrgMemberCodeProjectResult>;
  createMulti(
    this: void,
    workspace: UpgradeWorkspace,
    organizationId: string,
    options: OrgMemberCreationOptions,
  ): Promise<CreateOrgMemberMultiRepoProjectResult>;
  share(
    this: void,
    organizationId: string,
    projectId: string,
    identity: UpgradeIdentity,
  ): Promise<void>;
  refreshCatalog(this: void, organizationId: string): Promise<void>;
  journal: PersonalOrganizationUpgradeJournal;
  now(this: void): string;
}

/** One mutation lane serializes overlapping batches, including Portal deliveries. */
export interface PersonalOrganizationUpgradeService {
  inviteStatus(
    this: void,
    organizationId: string,
    email: string,
  ): Promise<OrganizationInviteStatus>;
  status(
    this: void,
    operationId: string,
    sessionId?: string,
    acknowledgeTerminal?: true,
  ): Promise<PersonalProjectOperation | null>;
  convert(
    this: void,
    request: PersonalProjectConversionRequest,
    sessionId?: string,
    retry?: boolean,
  ): Promise<PersonalProjectOperation>;
  list(
    this: void,
    signal?: AbortSignal,
    bounded?: boolean,
  ): Promise<{ projects: PersonalProject[] }>;
  promote(
    this: void,
    request: UpgradePersonalOrganizationRequest,
  ): Promise<PersonalOrganizationPromotionOutcome>;
  invite(
    this: void,
    organizationId: string,
    request: SendOrganizationInviteRequest,
  ): Promise<OrganizationInviteResult>;
  resume(this: void): Promise<void>;
}
class ObsoleteProjectResumeError extends Error {}

export function createPersonalOrganizationUpgradeService(
  deps: PersonalOrganizationUpgradeDeps,
): PersonalOrganizationUpgradeService {
  let pending: Promise<void> = Promise.resolve();
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const result = pending.then(run);
    pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  async function guard(
    identity: UpgradeIdentity,
    sessionId?: string,
  ): Promise<void> {
    const current = await deps.identity();
    if (
      current.accountId !== identity.accountId ||
      current.epoch !== identity.epoch ||
      (sessionId !== undefined && !deps.sessionCurrent(sessionId))
    )
      throw new Error('account-changed');
  }
  function status(
    operationId: string,
    sessionId?: string,
    acknowledgeTerminal?: true,
  ): Promise<PersonalProjectOperation | null> {
    const read = async (): Promise<PersonalProjectOperation | null> => {
      const identity = await deps.identity();
      const operation = (await deps.journal.read()).find(
        (entry) =>
          entry.accountId === identity.accountId &&
          entry.operationId === operationId,
      );
      await guard(identity, sessionId);
      if (!operation || operation.desktopSessionId !== sessionId) return null;
      if (acknowledgeTerminal && operation.terminalReason) {
        await deps.journal.remove(operation);
        return null;
      }
      return operation;
    };
    return acknowledgeTerminal ? serial(read) : read();
  }
  async function convert(
    request: PersonalProjectConversionRequest,
    sessionId?: string,
    retry = false,
    expectedIdentity?: UpgradeIdentity,
  ): Promise<PersonalProjectOperation> {
    const input = PersonalProjectConversionRequestSchema.parse(request);
    const initiatingIdentity = expectedIdentity ?? (await deps.identity());
    return serial(async () => {
      let identity = initiatingIdentity;
      await guard(identity, sessionId);
      if (!(await deps.destination(input.organizationId, identity)))
        throw new Error('Destination unavailable');
      await guard(identity, sessionId);
      const selection = Array.from(new Set(input.workspaceIds));
      if (input.retryWorkspaceIds?.some((id) => !selection.includes(id)))
        throw new Error('Retry project was not selected');
      if (input.workspaceId && !selection.includes(input.workspaceId))
        throw new Error('Project was not selected');
      const recordedOperations = await deps.journal.read();
      const existing = recordedOperations.find(
        (entry) =>
          entry.accountId === identity.accountId &&
          entry.operationId === input.operationId,
      );
      if (expectedIdentity && !existing) throw new ObsoleteProjectResumeError();
      if (existing && existing.desktopSessionId !== sessionId)
        throw new Error('Desktop session changed');
      if (
        existing &&
        (existing.organizationId !== input.organizationId ||
          JSON.stringify(existing.selection) !== JSON.stringify(selection))
      )
        throw new Error('Operation payload changed');
      if (existing?.terminalReason) return existing;
      const previouslyStarted = new Set(
        existing?.projects
          .filter(({ creationStarted }) => creationStarted !== false)
          .map(({ workspaceId }) => workspaceId),
      );
      let operation: PersonalProjectOperation = existing ?? {
        operationId: input.operationId,
        accountId: identity.accountId,
        organizationId: input.organizationId,
        ...(sessionId ? { desktopSessionId: sessionId } : {}),
        selection,
        projects: selection.map((workspaceId) => ({
          workspaceId,
          stage: 'queued',
          outcome: 'pending',
          creationStarted: false,
        })),
        updatedAt: deps.now(),
      };
      await deps.journal.update(operation);
      async function save(): Promise<void> {
        operation = { ...operation, updatedAt: deps.now() };
        await deps.journal.update(operation);
      }
      async function endInvalidConfig(
        entries: readonly PersonalProjectOutcome[] = [],
      ): Promise<PersonalProjectOperation> {
        const invalid = new Set(entries);
        for (const entry of entries) {
          entry.reasonCode = 'invalid-canopy-json';
          delete entry.reason;
        }
        // A file can change after preflight. Preserve any unfinished hosted
        // creation or share from that earlier, successful validation.
        const hasUnfinishedEffects = operation.projects.some(
          (project) =>
            project.stage === 'member-created' ||
            project.stage === 'converted' ||
            (project.outcome === 'pending' &&
              project.creationStarted !== false &&
              (!invalid.has(project) ||
                previouslyStarted.has(project.workspaceId))),
        );
        if (hasUnfinishedEffects) {
          for (const entry of entries) {
            if (entry.stage === 'queued' && entry.creationStarted === false)
              entry.outcome = 'failed';
          }
          await save();
          return operation;
        }
        for (const project of operation.projects) {
          if (project.outcome === 'pending') project.outcome = 'failed';
        }
        operation.terminalReason = 'invalid-canopy-json';
        await save();
        return operation;
      }
      try {
        identity = await deps.refreshAccount(identity);
        await guard(identity, sessionId);
        await deps.switchContext(input.organizationId);
        await guard(identity, sessionId);
      } catch (error) {
        if (error instanceof InvalidCanopyJsonError) return endInvalidConfig();
        for (const entry of operation.projects) {
          if (
            entry.outcome !== 'pending' &&
            entry.outcome !== 'converted-private'
          )
            continue;
          if (error instanceof Error && error.message === 'account-changed')
            entry.outcome = 'account-changed';
          entry.reason = 'Account refresh unavailable';
        }
        await save();
        return operation;
      }
      // Every entry point, including recovery and one-project Portal commands,
      // validates the whole selection before entering the mutation loop.
      const invalidConfigs = new Set<string>();
      let initial: UpgradeWorkspace[];
      try {
        initial = await deps.workspaces({
          workspaceIds: selection,
          reportInvalidConfig: (id): void => {
            invalidConfigs.add(id);
          },
        });
      } catch (error) {
        if (error instanceof InvalidCanopyJsonError) return endInvalidConfig();
        throw error;
      }
      const invalidProjects = operation.projects.filter((entry) =>
        invalidConfigs.has(entry.workspaceId),
      );
      if (invalidProjects.length > 0) return endInvalidConfig(invalidProjects);
      const ordered = [...operation.projects].sort(
        (a, b) =>
          Number(
            initial.find((w) => w.workspaceId === a.workspaceId)?.kind ===
              'multi-repo',
          ) -
          Number(
            initial.find((w) => w.workspaceId === b.workspaceId)?.kind ===
              'multi-repo',
          ),
      );
      let prerequisiteFailed = false;
      for (const entry of ordered) {
        if (input.workspaceId && entry.workspaceId !== input.workspaceId)
          continue;
        if (entry.outcome === 'moved') {
          if (
            entry.refreshWarning &&
            input.retryWorkspaceIds?.includes(entry.workspaceId)
          ) {
            try {
              await guard(identity, sessionId);
              await deps.refreshCatalog(operation.organizationId);
              await guard(identity, sessionId);
              entry.refreshWarning = false;
              await save();
            } catch {
              prerequisiteFailed = true;
            }
          }
          continue;
        }
        if (
          !retry &&
          !input.retryWorkspaceIds?.includes(entry.workspaceId) &&
          !['pending', 'converted-private'].includes(entry.outcome)
        )
          continue;
        delete entry.reasonCode;
        try {
          await guard(identity, sessionId);
          let invalidConfig = false;
          const workspaces = await deps.workspaces({
            workspaceIds: [entry.workspaceId],
            reportInvalidConfig: () => {
              invalidConfig = true;
            },
          });
          const workspace = workspaces.find(
            (w) => w.workspaceId === entry.workspaceId,
          );
          if (!workspace) {
            if (invalidConfig) return endInvalidConfig([entry]);
            entry.outcome = 'workspace-not-found';
            delete entry.reason;
            await save();
            continue;
          }
          const unresolved = recordedOperations.find(
            (other) =>
              other.accountId === identity.accountId &&
              other.operationId !== operation.operationId &&
              !other.terminalReason &&
              other.projects.some(
                (project) =>
                  project.workspaceId === entry.workspaceId &&
                  ((project.creationStarted !== false &&
                    (project.outcome === 'pending' ||
                      project.outcome === 'converted-private')) ||
                    project.stage === 'member-created' ||
                    project.stage === 'converted'),
              ),
          );
          if (!workspace.owner && unresolved) {
            entry.outcome = 'pending';
            entry.reason = `Reconcile pending conversion ${unresolved.operationId} before starting another operation`;
            await save();
            continue;
          }
          if (
            workspace.owner &&
            (entry.projectId === undefined ||
              workspace.owner.organizationId !== operation.organizationId ||
              (entry.projectId !== undefined &&
                workspace.owner.projectId !== entry.projectId))
          ) {
            entry.outcome = 'not-personal';
            await save();
            continue;
          }
          if (workspace.owner) {
            entry.projectId = workspace.owner.projectId;
            entry.stage = 'converted';
          }
          const beforeMutation = async (): Promise<void> => {
            await guard(identity, sessionId);
            if (!(await deps.destination(operation.organizationId, identity)))
              throw new Error('Destination unavailable');
            await guard(identity, sessionId);
          };
          const onMemberCreated = async (projectId: string): Promise<void> => {
            entry.projectId = projectId;
            entry.stage = 'member-created';
            await save();
          };
          if (workspace.kind === 'multi-repo' && !workspace.owner) {
            const singlePending = operation.projects.some(
              (p) =>
                initial.find((w) => w.workspaceId === p.workspaceId)?.kind ===
                  'single-repo' && p.outcome === 'pending',
            );
            if (singlePending || prerequisiteFailed) {
              entry.outcome = 'pending';
              entry.reason =
                'Waiting for single-repository projects and catalog refresh';
              await save();
              continue;
            }
            await deps.refreshCatalog(operation.organizationId);
            await guard(identity, sessionId);
          }
          if (!workspace.owner) {
            await beforeMutation();
            entry.name ??= workspace.name;
            entry.kind ??= workspace.kind;
            entry.creationStarted = true;
            await save();
            const options: OrgMemberCreationOptions = {
              propagateErrors: true,
              beforeMutation,
              onMemberCreated,
              credentialContext: identity.credentials,
            };
            const creationKey = createHash('sha256')
              .update(`${operation.operationId}:${workspace.workspaceId}`)
              .digest('hex');
            const creationWorkspace =
              workspace.name === entry.name
                ? workspace
                : { ...workspace, name: entry.name };
            const result =
              workspace.kind === 'single-repo'
                ? await deps.createSingle(
                    creationWorkspace,
                    operation.organizationId,
                    creationKey,
                    entry.projectId,
                    options,
                  )
                : await deps.createMulti(
                    creationWorkspace,
                    operation.organizationId,
                    options,
                  );
            await guard(identity, sessionId);
            if (!result.ok) {
              entry.outcome =
                result.code === 'limit-reached'
                  ? 'limit-reached'
                  : result.code === 'refused'
                    ? 'repositories-not-in-team'
                    : result.code === 'unavailable'
                      ? 'offline'
                      : result.code === 'setup-failed'
                        ? 'pending'
                        : 'failed';
              entry.reason =
                result.code === 'refused'
                  ? `${result.reason}${'repositories' in result && Array.isArray(result.repositories) ? `: ${result.repositories.join(', ')}` : ''}`
                  : result.code;
              await save();
              continue;
            }
            entry.projectId = result.organizationProjectId;
            entry.stage = 'converted';
            entry.outcome = 'converted-private';
            await save();
          }
          if (!entry.projectId) throw new Error('Missing converted project');
          await beforeMutation();
          await deps.share(operation.organizationId, entry.projectId, identity);
          entry.stage = 'shared';
          entry.outcome = 'moved';
          await save();
          await guard(identity, sessionId);
          try {
            await deps.refreshCatalog(operation.organizationId);
          } catch {
            entry.refreshWarning = true;
            prerequisiteFailed = true;
          }
          entry.stage = 'complete';
          await save();
        } catch (error) {
          if (error instanceof InvalidCanopyJsonError)
            return endInvalidConfig([entry]);
          const changed =
            error instanceof Error && error.message === 'account-changed';
          entry.outcome =
            entry.stage === 'shared' || entry.stage === 'complete'
              ? 'moved'
              : changed
                ? 'account-changed'
                : entry.stage === 'converted'
                  ? 'converted-private'
                  : 'pending';
          entry.reason = 'Unknown outcome';
          await save();
          if (changed) {
            for (const remaining of operation.projects)
              if (remaining.outcome === 'pending')
                remaining.outcome = 'account-changed';
            await save();
            break;
          }
          if (entry.stage === 'queued' || entry.stage === 'member-created')
            prerequisiteFailed = true;
        }
      }
      return operation;
    });
  }
  return {
    status,
    convert,
    async list(
      signal?: AbortSignal,
      bounded = true,
    ): Promise<{ projects: PersonalProject[] }> {
      const discover = async (
        active?: AbortSignal,
      ): Promise<{ projects: PersonalProject[] }> => {
        active?.throwIfAborted();
        const identity = await deps.identity();
        active?.throwIfAborted();
        const projects = await deps.previewProjects(active);
        active?.throwIfAborted();
        await guard(identity);
        active?.throwIfAborted();
        return { projects };
      };
      // The original inline Portal request retains its broker window.
      return bounded || signal
        ? withPersonalProjectPreviewDeadline(discover, signal)
        : discover();
    },
    async promote(
      request: UpgradePersonalOrganizationRequest,
    ): Promise<PersonalOrganizationPromotionOutcome> {
      let identity = await deps.identity();
      await guard(identity);
      const promotion = await deps.promote(request, identity);
      try {
        deps.onPromotion?.(promotion);
      } catch {
        /* Confirmed creation survives observers. */
      }
      const warnings: PersonalOrganizationPromotionOutcome['warnings'] = [];
      let contextSwitched = false;
      try {
        await deps.suppress(promotion.organizationId);
      } catch {
        warnings.push('local-suppression-failed');
      }
      try {
        await guard(identity);
        identity = await deps.refreshAccount(identity);
      } catch {
        warnings.push('account-refresh-failed');
      }
      try {
        await guard(identity);
        await deps.switchContext(promotion.organizationId);
        await guard(identity);
        contextSwitched = true;
      } catch {
        warnings.push('context-switch-failed');
      }
      return { promotion, warnings, contextSwitched };
    },
    async invite(
      organizationId: string,
      request: SendOrganizationInviteRequest,
    ): Promise<OrganizationInviteResult> {
      const identity = await deps.identity();
      await guard(identity);
      const result = await deps.invite(organizationId, request, identity);
      try {
        deps.onInvite?.(result);
      } catch {
        /* Confirmed send survives observers. */
      }
      return result;
    },
    async inviteStatus(
      organizationId,
      email,
    ): Promise<OrganizationInviteStatus> {
      const identity = await deps.identity();
      const result = await deps.inviteStatus(organizationId, email, identity);
      await guard(identity);
      return result;
    },
    async resume(): Promise<void> {
      const identity = await deps.identity();
      for (const entry of await deps.journal.read()) {
        if (
          entry.accountId !== identity.accountId ||
          entry.terminalReason !== undefined ||
          (entry.desktopSessionId &&
            !deps.sessionCurrent(entry.desktopSessionId)) ||
          !entry.projects.some(
            (p) => p.outcome === 'pending' || p.outcome === 'converted-private',
          )
        )
          continue;
        await convert(
          {
            operationId: entry.operationId,
            organizationId: entry.organizationId,
            workspaceIds: entry.selection,
          },
          entry.desktopSessionId,
          false,
          identity,
        ).catch((error: unknown) => {
          if (!(error instanceof ObsoleteProjectResumeError)) throw error;
        });
      }
    },
  };
}
