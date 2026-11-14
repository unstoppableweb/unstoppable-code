import { create, type StoreApi, type UseBoundStore } from 'zustand';
import {
  OrganizationOperationFailure,
  type CanopyClient,
} from '@canopy/app-core';
import { z } from 'zod';
import {
  PersonalOrganizationPromotionOutcomeSchema,
  OrganizationInviteResultSchema,
  PersonalProjectSchema,
} from '@canopy/protocol/organizations';
import type {
  OrganizationInviteResult,
  OrganizationInviteStatus,
  PersonalOrganizationPromotionOutcome,
  PersonalProject,
  PersonalProjectConversionRequest,
  PersonalProjectOperation,
  SendOrganizationInviteRequest,
  UpgradePersonalOrganizationRequest,
} from '@canopy/protocol/organizations';

/**
 * Promote the Personal organization into a team, bring selected projects, and
 * invite someone (CAN-3706). Each stage is durable on its own: a committed
 * promotion stays committed when projects or the invite fail, and retries
 * reuse the same operation ids so nothing is promoted, created, or emailed
 * twice.
 *
 * Hosts supply a narrow port rather than a whole `CanopyClient`, because the
 * web account menu runs outside any client provider. Hosts that do have a
 * client adapt it with {@link personalOrganizationUpgradePortFromClient}.
 */
export interface PersonalOrganizationUpgradePort {
  readonly desktopSessionId?: string;
  readonly isCurrent?: () => boolean;
  readonly reconcileInvite?: (
    organizationId: string,
    email: string,
  ) => Promise<OrganizationInviteStatus>;
  readonly canPromote: boolean;
  readonly canInvite: boolean;
  /** Personal projects can be listed and brought (desktop, or a paired one). */
  readonly canBringProjects: boolean;
  readonly promote: (
    request: UpgradePersonalOrganizationRequest,
  ) => Promise<PersonalOrganizationPromotionOutcome>;
  readonly invite: (
    organizationId: string,
    invite: SendOrganizationInviteRequest,
  ) => Promise<OrganizationInviteResult>;
  readonly listProjects: () => Promise<readonly PersonalProject[]>;
  readonly convert: (
    request: PersonalProjectConversionRequest,
  ) => Promise<PersonalProjectOperation>;
  readonly status: (
    operationId: string,
  ) => Promise<PersonalProjectOperation | null>;
}

export function personalOrganizationUpgradePortFromClient(
  client: CanopyClient,
): PersonalOrganizationUpgradePort {
  const capabilities = client.capabilities;
  return {
    canPromote: capabilities.personalOrganizationUpgrade === true,
    canInvite: capabilities.organizationInvites === true,
    canBringProjects: capabilities.personalProjectConversion === true,
    reconcileInvite: (organizationId, email) =>
      client.query('organization.inviteStatus', { organizationId, email }),
    promote: (request) =>
      client.command('personalOrganization.upgrade', request),
    invite: (organizationId, invite) =>
      client.command('organization.invite', { organizationId, invite }),
    listProjects: async () =>
      (await client.query('personalOrganization.projects', {})).projects,
    convert: (request) =>
      client.command('personalOrganization.convertProjects', request),
    status: (operationId) =>
      client.query('personalOrganization.operationStatus', { operationId }),
  };
}

/** What survives a closed dialog so reopening reconnects instead of redoing. */
export interface PersonalOrganizationUpgradeRecord {
  readonly accountKey: string;
  readonly personalOrganizationId: string;
  readonly promotionOperationId: string;
  readonly conversionOperationId: string;
  readonly name: string;
  readonly selection: readonly string[];
  readonly inviteEmail: string;
  readonly promotion: PersonalOrganizationPromotionOutcome | null;
  readonly invite: OrganizationInviteResult | null;
  readonly desktopSessionId?: string;
  readonly submittedName?: string;
  readonly projects?: readonly PersonalProject[];
  readonly invitePending?: boolean;
  readonly inviteFailure?: PersonalOrganizationUpgradeFailure;
  readonly conversionFailure?: PersonalOrganizationUpgradeFailure;
  readonly existingOrganizationId?: string;
}

export interface PersonalOrganizationUpgradeRecovery {
  readonly read: () => PersonalOrganizationUpgradeRecord | null;
  readonly write: (record: PersonalOrganizationUpgradeRecord | null) => void;
}

const RECOVERY_KEY_PREFIX = 'canopy.personal-organization-upgrade.v1:';

const RecoveryRecordSchema = z.object({
  accountKey: z.string().min(1),
  personalOrganizationId: z.string().min(1),
  promotionOperationId: z.string().min(1),
  conversionOperationId: z.string().min(1),
  name: z.string(),
  selection: z.array(z.string().min(1)),
  inviteEmail: z.string(),
  promotion: PersonalOrganizationPromotionOutcomeSchema.nullable(),
  invite: OrganizationInviteResultSchema.nullable(),
  desktopSessionId: z.string().optional(),
  submittedName: z.string().optional(),
  projects: z.array(PersonalProjectSchema).optional(),
  invitePending: z.boolean().optional(),
  inviteFailure: z
    .object({ code: z.string().nullable(), message: z.string() })
    .optional(),
  conversionFailure: z
    .object({ code: z.string().nullable(), message: z.string() })
    .optional(),
  existingOrganizationId: z.string().min(1).optional(),
});

/**
 * Account-scoped browser storage for the recovery record. A missing or
 * unreadable record simply starts fresh; the server and desktop journal stay
 * authoritative for what already happened.
 */
export function createBrowserUpgradeRecovery(
  accountKey: string,
  storage: Pick<
    Storage,
    'getItem' | 'setItem' | 'removeItem'
  > | null = typeof globalThis.localStorage === 'undefined'
    ? null
    : globalThis.localStorage,
  scope?: string,
): PersonalOrganizationUpgradeRecovery {
  const key = `${RECOVERY_KEY_PREFIX}${accountKey}${scope ? `:${scope}` : ''}`;
  return {
    read: (): PersonalOrganizationUpgradeRecord | null => {
      try {
        const raw = storage?.getItem(key);
        if (raw === null || raw === undefined) return null;
        const parsed: unknown = JSON.parse(raw);
        const result = RecoveryRecordSchema.safeParse(parsed);
        return result.success && result.data.accountKey === accountKey
          ? result.data
          : null;
      } catch {
        return null;
      }
    },
    write: (record): void => {
      try {
        if (record === null) storage?.removeItem(key);
        else storage?.setItem(key, JSON.stringify(record));
      } catch {
        // Recovery is a convenience; the operation itself is already durable.
      }
    },
  };
}

export type PersonalOrganizationUpgradePhase =
  | 'editing'
  | 'promoting'
  | 'converting'
  | 'inviting'
  | 'pending'
  | 'partial'
  | 'finished';

export interface PersonalProjectListState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly items: readonly PersonalProject[];
}

/** A refusal the dialog explains; `code` is the server's typed code when known. */
export interface PersonalOrganizationUpgradeFailure {
  readonly code: string | null;
  readonly message: string;
}

export interface PersonalOrganizationInviteState {
  readonly status: 'idle' | 'sending' | 'done' | 'failed' | 'pending';
  readonly result: OrganizationInviteResult | null;
  readonly failure: PersonalOrganizationUpgradeFailure | null;
}

/**
 * One more person invited after the team exists. These are not part of the
 * recovery record: each send is idempotent per address on the server, so a
 * retry after a lost reply resends rather than duplicating the invitation.
 */
export interface AdditionalOrganizationInvite {
  readonly id: string;
  readonly email: string;
  readonly status: 'sending' | 'done' | 'failed' | 'pending';
  readonly result: OrganizationInviteResult | null;
  readonly failure: PersonalOrganizationUpgradeFailure | null;
}

interface ChecklistReply {
  readonly isCurrent: () => boolean;
  readonly apply: <T>(write: () => T) => T | undefined;
}

export interface PersonalOrganizationUpgradeState {
  readonly phase: PersonalOrganizationUpgradePhase;
  readonly retired: boolean;
  readonly name: string;
  readonly inviteEmail: string;
  readonly projects: PersonalProjectListState;
  /** Explicit selection. Refreshes never add newly discovered projects. */
  readonly selection: readonly string[];
  /** The user chose to continue after the project list could not load. */
  readonly withoutProjects: boolean;
  readonly promotion: PersonalOrganizationPromotionOutcome | null;
  readonly promotionFailure: PersonalOrganizationUpgradeFailure | null;
  readonly operation: PersonalProjectOperation | null;
  readonly conversionFailure: PersonalOrganizationUpgradeFailure | null;
  readonly invite: PersonalOrganizationInviteState;
  /** People invited after the team exists, in the order they were added. */
  readonly additionalInvites: readonly AdditionalOrganizationInvite[];
  readonly setName: (name: string) => void;
  readonly setInviteEmail: (email: string) => void;
  readonly setProjectSelected: (workspaceId: string, selected: boolean) => void;
  readonly continueWithoutProjects: () => void;
  readonly loadProjects: () => Promise<void>;
  /** Promote (or reconcile a promotion), then bring projects, then invite. */
  readonly submit: (options?: {
    readonly inviteRequired?: boolean;
  }) => Promise<void>;
  /** Retry chosen projects through the same durable operation. */
  readonly retryProjects: (workspaceIds: readonly string[]) => Promise<void>;
  /** Re-read the durable operation, e.g. after reopening. */
  readonly refreshOperation: () => Promise<void>;
  readonly retryInvite: () => Promise<void>;
  readonly reconcileInvite: () => Promise<void>;
  readonly refreshPromotion: () => Promise<void>;
  readonly confirmContext: (organizationId: string) => void;
  /** Invite into an existing team; never promotes anything. */
  readonly inviteExisting: (organizationId: string) => Promise<void>;
  /**
   * Invite one more person into the committed team. Resolves `false` when
   * nothing was sent (no team yet, an invalid address, or that address is
   * already being invited).
   */
  readonly inviteAnother: (email: string) => Promise<boolean>;
  /** Send a failed or unconfirmed additional invite again. */
  readonly retryAnother: (id: string) => Promise<void>;
  /** Restore a previous run for this account, if one was recorded. */
  readonly restore: () => Promise<void>;
  /** Capture the checklist generation before starting work that can reply later. */
  readonly captureChecklistReply: () => ChecklistReply;
  /** Retire the finished checklist and clear its saved record. */
  readonly acknowledge: () => void;
  /** Stop applying late replies (unmount or account change). */
  readonly dispose: () => void;
}

export type PersonalOrganizationUpgradeStore = UseBoundStore<
  StoreApi<PersonalOrganizationUpgradeState>
>;

export interface PersonalOrganizationUpgradeStoreOptions {
  readonly port: PersonalOrganizationUpgradePort;
  readonly accountKey: string;
  readonly personalOrganizationId: string;
  readonly defaultName?: string;
  /**
   * Invite into this existing team rather than promoting Personal: invites
   * go straight to it through `inviteAnother`.
   */
  readonly existingOrganizationId?: string;
  readonly recovery?: PersonalOrganizationUpgradeRecovery;
  readonly createId?: () => string;
  /** Delay between durable status reads while projects are pending. */
  readonly pollIntervalMs?: number;
  readonly maxPolls?: number;
  readonly schedule?: (callback: () => void, delayMs: number) => () => void;
}

/** Shape-only check; the server validates again. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function failureOf(error: unknown): PersonalOrganizationUpgradeFailure {
  if (error instanceof OrganizationOperationFailure) {
    return { code: error.code, message: error.message };
  }
  return {
    code: null,
    message: error instanceof Error ? error.message : String(error),
  };
}

/** A 4xx refusal is final: the invite was not created and a retry is explicit. */
function isDefiniteRefusal(error: unknown): boolean {
  return (
    error instanceof OrganizationOperationFailure &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500
  );
}

/** True while any selected project still waits on durable work. */
export function hasPendingProjects(
  operation: PersonalProjectOperation | null,
): boolean {
  return (
    operation !== null &&
    operation.projects.some((project) => project.outcome === 'pending')
  );
}

/** Outcomes a reopened dialog should still show and offer to retry. */
export function needsAttention(
  operation: PersonalProjectOperation | null,
): boolean {
  return (
    operation !== null &&
    operation.projects.some(
      (project) =>
        project.outcome !== 'moved' || project.refreshWarning === true,
    )
  );
}

const defaultSchedule = (
  callback: () => void,
  delayMs: number,
): (() => void) => {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
};

export function createPersonalOrganizationUpgradeStore({
  port,
  accountKey,
  personalOrganizationId,
  defaultName = '',
  existingOrganizationId: initialExistingOrganizationId,
  recovery,
  createId = (): string => globalThis.crypto.randomUUID(),
  pollIntervalMs = 3000,
  maxPolls = 40,
  schedule = defaultSchedule,
}: PersonalOrganizationUpgradeStoreOptions): PersonalOrganizationUpgradeStore {
  let alive = true;
  let checklistGeneration = 0;
  let busy = false;
  let loadedOnce = false;
  let cancelPoll: (() => void) | null = null;
  let polls = 0;
  let promotionOperationId = createId();
  let conversionOperationId = createId();
  let originalPersonalOrganizationId = personalOrganizationId;
  let submittedName: string | undefined;
  let originalDesktopSessionId = port.desktopSessionId;
  let existingOrganizationId: string | null =
    initialExistingOrganizationId ?? null;
  const contextCurrent = (): boolean => alive && (port.isCurrent?.() ?? true);
  const captureChecklistReply = (): ChecklistReply => {
    const generation = checklistGeneration;
    const isCurrent = (): boolean =>
      generation === checklistGeneration && contextCurrent();
    return {
      isCurrent,
      apply: (write) => (isCurrent() ? write() : undefined),
    };
  };
  const store = create<PersonalOrganizationUpgradeState>((set, get) => {
    const active = (): boolean => !get().retired && contextCurrent();
    const projectsCurrent = (): boolean =>
      active() && port.desktopSessionId === originalDesktopSessionId;

    const persist = (): void => {
      const state = get();
      recovery?.write({
        accountKey,
        personalOrganizationId: originalPersonalOrganizationId,
        promotionOperationId,
        conversionOperationId,
        name: state.name,
        selection: state.selection,
        inviteEmail: state.inviteEmail,
        promotion: state.promotion,
        invite: state.invite.result,
        ...(state.invite.status === 'failed' && state.invite.failure
          ? { inviteFailure: state.invite.failure }
          : {}),
        ...(state.conversionFailure
          ? { conversionFailure: state.conversionFailure }
          : {}),
        ...(existingOrganizationId ? { existingOrganizationId } : {}),
        ...(originalDesktopSessionId
          ? { desktopSessionId: originalDesktopSessionId }
          : {}),
        ...(submittedName ? { submittedName } : {}),
        projects: [...state.projects.items],
        invitePending:
          state.invite.status === 'pending' ||
          state.invite.status === 'sending',
      });
    };

    const teamId = (): string | null =>
      get().promotion?.promotion.organizationId ?? existingOrganizationId;
    const hasUnsentInvite = (): boolean =>
      get().invite.status === 'idle' &&
      EMAIL_SHAPE.test(get().inviteEmail.trim());
    const settledPhase = (): PersonalOrganizationUpgradePhase =>
      hasPendingProjects(get().operation) ||
      get().invite.status === 'pending' ||
      get().invite.status === 'sending'
        ? 'pending'
        : needsAttention(get().operation) ||
            get().conversionFailure !== null ||
            get().invite.status === 'failed' ||
            hasUnsentInvite()
          ? 'partial'
          : 'finished';

    const stopPolling = (): void => {
      cancelPoll?.();
      cancelPoll = null;
    };

    const pollWhilePending = (): void => {
      stopPolling();
      if (
        !active() ||
        (!hasPendingProjects(get().operation) &&
          get().invite.status !== 'pending') ||
        polls >= maxPolls
      )
        return;
      const reply = captureChecklistReply();
      cancelPoll = schedule(() => {
        cancelPoll = null;
        if (!reply.isCurrent()) return;
        polls += 1;
        void get()
          .refreshOperation()
          .then(() => {
            if (reply.isCurrent()) return get().reconcileInvite();
          })
          .then(() => reply.apply(pollWhilePending));
      }, pollIntervalMs);
    };

    const convert = async (
      workspaceIds: readonly string[],
      retry: boolean,
    ): Promise<void> => {
      const organizationId = teamId();
      if (organizationId === null || workspaceIds.length === 0) return;
      if (!projectsCurrent()) {
        set({
          conversionFailure: {
            code: 'offline',
            message:
              'Reconnect the original desktop to continue these projects.',
          },
        });
        return;
      }
      const reply = captureChecklistReply();
      set({ phase: 'converting', conversionFailure: null });
      try {
        const operation = await port.convert({
          operationId: conversionOperationId,
          organizationId,
          workspaceIds: [...get().selection],
          ...(retry ? { retryWorkspaceIds: [...workspaceIds] } : {}),
        });
        reply.apply(() => {
          set({ operation });
          polls = 0;
          pollWhilePending();
        });
      } catch (error) {
        if (!reply.isCurrent()) return;
        reply.apply(() => {
          set({ conversionFailure: failureOf(error) });
          persist();
        });
        // The request may have started work; read what is durable.
        await get().refreshOperation();
      }
    };

    const sendInvite = async (organizationId: string): Promise<void> => {
      const email = get().inviteEmail.trim();
      if (!active() || !port.canInvite || !EMAIL_SHAPE.test(email)) return;
      if (get().invite.status === 'pending') {
        await get().reconcileInvite();
        return;
      }
      const reply = captureChecklistReply();
      set({
        phase: get().promotion === null ? get().phase : 'inviting',
        invite: { status: 'sending', result: null, failure: null },
      });
      persist();
      try {
        const result = await port.invite(organizationId, { email });
        reply.apply(() =>
          set({ invite: { status: 'done', result, failure: null } }),
        );
      } catch (error) {
        if (!reply.isCurrent()) return;
        const definite = isDefiniteRefusal(error);
        reply.apply(() => {
          set({
            invite: {
              status: definite ? 'failed' : 'pending',
              result: null,
              failure: failureOf(error),
            },
          });
        });
        if (!definite) await get().reconcileInvite();
      }
      reply.apply(persist);
    };

    const updateAdditional = (
      id: string,
      patch: Partial<AdditionalOrganizationInvite>,
    ): void => {
      set({
        additionalInvites: get().additionalInvites.map((entry) =>
          entry.id === id ? { ...entry, ...patch } : entry,
        ),
      });
    };

    /**
     * A send whose reply was lost may still have gone out, so read its state
     * before reporting it; a read that also fails leaves it unconfirmed.
     */
    const confirmAdditional = async (
      organizationId: string,
      id: string,
      email: string,
      sendError: unknown,
    ): Promise<void> => {
      if (!port.reconcileInvite) {
        updateAdditional(id, {
          status: 'pending',
          failure: failureOf(sendError),
        });
        return;
      }
      const reply = captureChecklistReply();
      try {
        const status = await port.reconcileInvite(organizationId, email);
        reply.apply(() => {
          if (status.status === 'pending' || status.status === 'not-found')
            updateAdditional(id, {
              status: 'pending',
              failure: failureOf(sendError),
            });
          else updateAdditional(id, { status: 'done', result: status });
        });
      } catch (reconcileError) {
        reply.apply(() =>
          updateAdditional(id, {
            status: 'pending',
            failure: failureOf(reconcileError),
          }),
        );
      }
    };

    const sendAdditional = async (
      organizationId: string,
      id: string,
      email: string,
    ): Promise<void> => {
      const reply = captureChecklistReply();
      updateAdditional(id, { status: 'sending', result: null, failure: null });
      try {
        const result = await port.invite(organizationId, { email });
        reply.apply(() =>
          updateAdditional(id, { status: 'done', result, failure: null }),
        );
      } catch (error) {
        if (!reply.isCurrent()) return;
        if (isDefiniteRefusal(error))
          reply.apply(() =>
            updateAdditional(id, {
              status: 'failed',
              failure: failureOf(error),
            }),
          );
        else await confirmAdditional(organizationId, id, email, error);
      }
    };

    return {
      phase: 'editing',
      retired: false,
      name: defaultName,
      inviteEmail: '',
      projects: { status: 'idle', items: [] },
      selection: [],
      withoutProjects: false,
      promotion: null,
      promotionFailure: null,
      operation: null,
      conversionFailure: null,
      invite: { status: 'idle', result: null, failure: null },
      additionalInvites: [],

      setName: (name): void => {
        if (busy || !active() || get().promotion !== null) return;
        if (
          submittedName !== undefined &&
          get().promotionFailure?.code !== null
        ) {
          const code = get().promotionFailure?.code;
          if (
            code &&
            [
              'invalid_request',
              'creation_disabled',
              'not_found',
              'forbidden',
              'rate_limited',
              'provisioning_failed',
            ].includes(code)
          ) {
            promotionOperationId = createId();
            checklistGeneration += 1;
            submittedName = undefined;
          }
        }
        set({ name, promotionFailure: null });
      },
      setInviteEmail: (inviteEmail): void => {
        if (!active() || busy || get().invite.status === 'pending') return;
        set({
          inviteEmail,
          invite: { status: 'idle', result: null, failure: null },
        });
      },
      setProjectSelected: (workspaceId, selected): void => {
        if (!active() || busy || get().promotion !== null) return;
        const current = get().selection.filter((id) => id !== workspaceId);
        set({ selection: selected ? [...current, workspaceId] : current });
      },
      continueWithoutProjects: (): void =>
        set({ withoutProjects: true, selection: [] }),

      loadProjects: async (): Promise<void> => {
        if (!active() || !port.canBringProjects) return;
        const reply = captureChecklistReply();
        set((state) => ({
          projects: { ...state.projects, status: 'loading' },
        }));
        try {
          const items = await port.listProjects();
          reply.apply(() => {
            const firstLoad = !loadedOnce;
            loadedOnce = true;
            const selection =
              firstLoad && !get().withoutProjects
                ? items.map((item) => item.workspaceId)
                : get().selection;
            set({
              projects: { status: 'ready', items },
              ...(get().promotion === null ? { selection } : {}),
            });
          });
        } catch {
          // Keep the previous list and choices; never read as "no projects".
          reply.apply(() =>
            set((state) => ({
              projects: { ...state.projects, status: 'error' },
            })),
          );
        }
      },

      submit: async (options): Promise<void> => {
        if (!active() || busy || !port.canPromote) return;
        const state = get();
        const name = state.name.trim();
        const email = state.inviteEmail.trim();
        if (name === '') return;
        if (
          options?.inviteRequired === true &&
          (!port.canInvite || !EMAIL_SHAPE.test(email))
        )
          return;
        if (email !== '' && !EMAIL_SHAPE.test(email)) return;
        const reply = captureChecklistReply();
        busy = true;
        try {
          let organizationId = teamId();
          if (organizationId === null) {
            submittedName ??= name;
            set({ phase: 'promoting', promotionFailure: null });
            persist();
            try {
              const promotion = await port.promote({
                organizationId: originalPersonalOrganizationId,
                name: submittedName,
                operationId: promotionOperationId,
              });
              if (!reply.isCurrent()) return;
              reply.apply(() => {
                set({ promotion });
                persist();
              });
              organizationId = promotion.promotion.organizationId;
            } catch (error) {
              reply.apply(() =>
                set({ phase: 'editing', promotionFailure: failureOf(error) }),
              );
              return;
            }
          }
          if (port.canBringProjects && get().operation === null) {
            await convert(get().selection, false);
            if (!reply.isCurrent()) return;
          }
          if (get().invite.status !== 'done') {
            await sendInvite(organizationId);
          }
          reply.apply(() => {
            set({ phase: settledPhase() });
            persist();
          });
        } finally {
          busy = false;
        }
      },

      retryProjects: async (workspaceIds): Promise<void> => {
        if (!active() || busy || workspaceIds.length === 0) return;
        const reply = captureChecklistReply();
        busy = true;
        try {
          await convert(workspaceIds, true);
          reply.apply(() => {
            set({ phase: settledPhase() });
            persist();
          });
        } finally {
          busy = false;
        }
      },

      refreshOperation: async (): Promise<void> => {
        if (
          !projectsCurrent() ||
          !port.canBringProjects ||
          get().selection.length === 0
        )
          return;
        const reply = captureChecklistReply();
        try {
          const operation = await port.status(conversionOperationId);
          if (!projectsCurrent()) return;
          reply.apply(() => {
            // A failed request plus a confirmed absent journal can be retried.
            // Legacy records and unknown status remain pending.
            if (operation === null && get().conversionFailure === null) return;
            set(
              operation === null
                ? { operation }
                : { operation, conversionFailure: null },
            );
            if (!busy) set({ phase: settledPhase() });
            persist();
          });
        } catch {
          // Status stays as last known; the dialog offers Check again.
        }
      },

      retryInvite: async (): Promise<void> => {
        const organizationId = teamId();
        if (!active() || busy || organizationId === null) return;
        const reply = captureChecklistReply();
        busy = true;
        try {
          await sendInvite(organizationId);
        } finally {
          busy = false;
          reply.apply(() => set({ phase: settledPhase() }));
        }
        reply.apply(persist);
      },

      reconcileInvite: async (): Promise<void> => {
        const organizationId = teamId();
        if (
          !active() ||
          organizationId === null ||
          get().invite.status !== 'pending' ||
          !port.reconcileInvite
        )
          return;
        const reply = captureChecklistReply();
        try {
          const result = await port.reconcileInvite(
            organizationId,
            get().inviteEmail.trim(),
          );
          reply.apply(() => {
            if (result.status !== 'pending' && result.status !== 'not-found')
              set({ invite: { status: 'done', result, failure: null } });
            if (!busy) set({ phase: settledPhase() });
            persist();
          });
        } catch (error) {
          if (
            !(error instanceof OrganizationOperationFailure) ||
            error.status === undefined ||
            error.status < 400 ||
            error.status === 429 ||
            error.status >= 500
          )
            return;
          reply.apply(() => {
            set({
              invite: {
                status: 'failed',
                result: null,
                failure: failureOf(error),
              },
            });
            if (!busy) set({ phase: settledPhase() });
            persist();
          });
        }
      },

      refreshPromotion: async (): Promise<void> => {
        if (!active() || busy || get().promotion === null || !submittedName)
          return;
        const reply = captureChecklistReply();
        busy = true;
        try {
          const promotion = await port.promote({
            organizationId: originalPersonalOrganizationId,
            name: submittedName,
            operationId: promotionOperationId,
          });
          reply.apply(() => {
            set({ promotion });
            persist();
          });
        } catch {
          /* Promotion is committed; retain its follow-up warnings. */
        } finally {
          busy = false;
        }
      },

      confirmContext: (organizationId): void => {
        const promotion = get().promotion;
        if (
          !active() ||
          !promotion ||
          promotion.promotion.organizationId !== organizationId
        )
          return;
        set({
          promotion: {
            ...promotion,
            contextSwitched: true,
            warnings: promotion.warnings.filter(
              (warning) =>
                warning !== 'context-switch-failed' &&
                warning !== 'account-refresh-failed',
            ),
          },
        });
        persist();
      },

      inviteExisting: async (organizationId): Promise<void> => {
        if (!active() || busy) return;
        const reply = captureChecklistReply();
        existingOrganizationId = organizationId;
        busy = true;
        try {
          await sendInvite(organizationId);
        } finally {
          busy = false;
          reply.apply(() => set({ phase: settledPhase() }));
        }
      },

      inviteAnother: async (rawEmail): Promise<boolean> => {
        const organizationId = teamId();
        const email = rawEmail.trim();
        if (
          !active() ||
          !port.canInvite ||
          organizationId === null ||
          !EMAIL_SHAPE.test(email)
        )
          return false;
        const key = email.toLowerCase();
        const sameAddress = get().additionalInvites.find(
          (entry) => entry.email.toLowerCase() === key,
        );
        if (sameAddress?.status === 'sending') return false;
        if (sameAddress) {
          await sendAdditional(organizationId, sameAddress.id, email);
          return true;
        }
        const id = createId();
        set({
          additionalInvites: [
            ...get().additionalInvites,
            { id, email, status: 'sending', result: null, failure: null },
          ],
        });
        await sendAdditional(organizationId, id, email);
        return true;
      },

      retryAnother: async (id): Promise<void> => {
        const organizationId = teamId();
        const entry = get().additionalInvites.find((item) => item.id === id);
        if (
          !active() ||
          organizationId === null ||
          entry === undefined ||
          entry.status === 'sending'
        )
          return;
        await sendAdditional(organizationId, id, entry.email);
      },

      restore: async (): Promise<void> => {
        const record = recovery?.read() ?? null;
        // A lost or late reply can leave a submitted record without its
        // replacement id. Restore it for this account so explicit retry can
        // reconcile the original promotion receipt and frozen selection.
        if (
          !active() ||
          record === null ||
          record.accountKey !== accountKey ||
          (record.personalOrganizationId !== personalOrganizationId &&
            record.promotion?.promotion.personalOrganizationId !==
              personalOrganizationId &&
            !(record.promotion === null && record.submittedName !== undefined))
        )
          return;
        if (promotionOperationId !== record.promotionOperationId)
          checklistGeneration += 1;
        const reply = captureChecklistReply();
        promotionOperationId = record.promotionOperationId;
        conversionOperationId = record.conversionOperationId;
        originalPersonalOrganizationId = record.personalOrganizationId;
        existingOrganizationId = record.existingOrganizationId ?? null;
        submittedName =
          record.submittedName ?? (record.promotion ? record.name : undefined);
        originalDesktopSessionId = record.desktopSessionId;
        loadedOnce = true;
        set({
          name: record.name,
          inviteEmail: record.inviteEmail,
          selection: record.selection,
          promotion: record.promotion,
          conversionFailure: record.conversionFailure ?? null,
          projects: { status: 'idle', items: record.projects ?? [] },
          ...(record.selection.length > 0 &&
          (record.promotion !== null || existingOrganizationId !== null)
            ? {
                operation: {
                  operationId: conversionOperationId,
                  organizationId:
                    record.promotion?.promotion.organizationId ??
                    existingOrganizationId ??
                    originalPersonalOrganizationId,
                  accountId: accountKey,
                  ...(originalDesktopSessionId
                    ? { desktopSessionId: originalDesktopSessionId }
                    : {}),
                  selection: [...record.selection],
                  projects: record.selection.map((workspaceId) => ({
                    workspaceId,
                    stage: 'queued' as const,
                    outcome: 'pending' as const,
                  })),
                  updatedAt: new Date().toISOString(),
                },
              }
            : {}),
          ...(record.invite !== null
            ? {
                invite: {
                  status: 'done',
                  result: record.invite,
                  failure: null,
                },
              }
            : {}),
          ...(record.invitePending
            ? { invite: { status: 'pending', result: null, failure: null } }
            : {}),
          ...(record.inviteFailure &&
          !record.invitePending &&
          record.invite === null
            ? {
                invite: {
                  status: 'failed',
                  result: null,
                  failure: record.inviteFailure,
                },
              }
            : {}),
          phase: record.promotion === null ? 'editing' : 'pending',
        });
        if (record.promotion !== null || existingOrganizationId !== null) {
          if (!projectsCurrent() && record.selection.length > 0)
            set({
              conversionFailure: {
                code: 'offline',
                message:
                  'Reconnect the original desktop to continue these projects.',
              },
            });
          if (record.promotion !== null) await get().refreshOperation();
          if (!reply.isCurrent()) return;
          await get().reconcileInvite();
          if (!reply.isCurrent()) return;
          // Closing during conversion can leave the originally requested invite
          // unstarted. Resume only that stage; uncertain delivery stays pending.
          if (hasUnsentInvite()) await get().retryInvite();
          reply.apply(() => {
            set({ phase: settledPhase() });
            polls = 0;
            pollWhilePending();
          });
        }
      },

      captureChecklistReply,

      acknowledge: (): void => {
        const state = get();
        if (
          !state.retired &&
          (state.promotion !== null || existingOrganizationId !== null) &&
          state.phase === 'finished' &&
          !needsAttention(state.operation) &&
          state.conversionFailure === null &&
          (state.promotion === null ||
            (state.promotion.contextSwitched &&
              state.promotion.warnings.length === 0)) &&
          state.invite.status !== 'failed' &&
          state.invite.status !== 'pending' &&
          state.invite.status !== 'sending' &&
          !hasUnsentInvite()
        ) {
          checklistGeneration += 1;
          set({ retired: true });
          stopPolling();
          if (recovery?.read()?.promotionOperationId === promotionOperationId)
            recovery.write(null);
        }
      },

      dispose: (): void => {
        alive = false;
        stopPolling();
      },
    };
  });
  return store;
}
