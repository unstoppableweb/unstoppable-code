import type { CopilotLocalHostOptions } from '@canopy/copilot-recipient/local-host';
import {
  createCopilotVaultGrantAuthority,
  copilotGrantLifetime,
  type CopilotGrantAuthorityOptions,
  type CopilotVaultGrant,
  type CopilotGrantResult,
  type CopilotVaultGrantAuthority,
  CopilotAuthorityRecordSchema,
  type CopilotAuthorityRecord,
} from '@canopy/core-runtime/node/vault';
import {
  createCopilotLocalRecipientHost,
  type CopilotLocalRuntime,
  type CopilotRecipientBinding,
  type CopilotProcessOwner,
} from '@canopy/copilot-recipient/local-host';
import { openCopilotLocalChannel } from '@canopy/copilot-recipient/local-channel';
import {
  CopilotLocalFrameSchema,
  type CopilotRecipientAudience,
  type CopilotRecipientPurpose,
  type CopilotRecipientOutcome,
  type CopilotRecipientResult,
} from '@canopy/protocol/copilot-recipient';
import type { CopilotSelectionIdentity } from '@canopy/protocol/copilot-selection';

const owners = new WeakSet<object>();
type Selection = CopilotGrantAuthorityOptions['selection'] & {
  abandon(identity: CopilotSelectionIdentity): Promise<void>;
  prepare(
    identity: CopilotSelectionIdentity,
    expectedGeneration: string | null,
  ): Promise<boolean>;
};
export type CopilotProbeFailure = 'network' | 'policy' | 'no-access';
export interface CopilotVaultPilotOptions extends Omit<
  CopilotGrantAuthorityOptions,
  'probe' | 'recipient' | 'selection'
> {
  platform: 'darwin' | 'win32' | 'linux';
  completed?: CopilotLocalHostOptions['completed'];
  capable(): boolean;
  /** Trusted boot recovery; the existing receipt reaper, never a credential recovery port. */
  recoverRuntimeReceipts?(): Promise<void>;
  /** Stable trusted receipt-directory owner across wrappers/families; absent uses the host's default namespace. */
  runtimeReceiptOwner?: object;
  /** Qualification handoff's synchronous P1/binding/host/publication agreement; absent for P6 setup. */
  qualificationAdmission?(): boolean;
  selection: Selection;
  /** Forward this setup override, or the projected launch owner, to the runtime spawner. */
  start(
    policyKey: string | undefined,
    signal: AbortSignal,
    owner?: CopilotProcessOwner,
  ): Promise<CopilotLocalRuntime>;
  classifyProbeFailure(error: unknown): CopilotProbeFailure;
}
type CopilotPilotSetupResult = (
  | CopilotGrantResult
  | { kind: 'probe-failed'; reason: CopilotProbeFailure }
) & { readonly setupOperationId?: string };
export interface CopilotVaultPilot {
  readonly authority: CopilotVaultGrantAuthority;
  recoverRuntimeReceipts(): Promise<void>;
  demand(): Promise<CopilotGrantResult>;
  removePending(operationId: string): Promise<CopilotGrantResult>;
  setup(
    grant: CopilotVaultGrant,
    expectedPinGeneration: string | null,
    signal?: AbortSignal,
  ): Promise<CopilotPilotSetupResult>;
  open(
    purpose: CopilotRecipientPurpose,
    audience: CopilotRecipientAudience,
    policyKey: string | undefined,
    write: (encoded: string) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<{
    opened: CopilotRecipientOutcome;
    receive(encoded: string): Promise<void>;
    disconnect(): void;
  }>;
  revoke(): void;
  reopen(): void;
  quiesce(): Promise<void>;
  close(): void;
}
/** Internal trusted composition. No daemon entrypoint or grant is selected by this factory. */
export function createCopilotVaultPilot(
  options: CopilotVaultPilotOptions,
): CopilotVaultPilot {
  if (owners.has(options.journal))
    throw new Error('Copilot authority is already composed.');
  owners.add(options.journal);
  const hosts = new Set<ReturnType<typeof createCopilotLocalRecipientHost>>();
  let publication = 0;
  let closed = false;
  let expectedSelection: string | null = null;
  let settingUp = false;
  let revoked = false;
  let setupExpiry = 0;
  let setupSignal: AbortSignal | undefined;
  let probeFailure: CopilotProbeFailure | undefined;
  const lifetime = copilotGrantLifetime(options);
  function recoverRuntimeReceipts(): Promise<void> {
    if (closed || lifetime.closed())
      return Promise.reject(new Error('Copilot runtime is unavailable.'));
    return lifetime.recoverReceipts(
      options.runtimeReceiptOwner,
      options.recoverRuntimeReceipts?.bind(options),
    );
  }
  function revoke(): void {
    publication++;
    for (const host of hosts) host.recipient.revoke();
  }
  let observed: CopilotAuthorityRecord | undefined;
  let observedSequence = -1;
  function observe(record: CopilotAuthorityRecord): void {
    const validated = CopilotAuthorityRecordSchema.parse(record);
    if (validated.sequence >= observedSequence) {
      observed = validated;
      observedSequence = validated.sequence;
    }
  }
  const authority = createCopilotVaultGrantAuthority({
    ...options,
    familyLifetime:
      options.familyLifetime ??
      (options.journal.lifetime?.familyId ? undefined : options.journal),
    journal: {
      ...options.journal,
      async read() {
        try {
          const record = await options.journal.read();
          observe(record);
          return record;
        } catch (error) {
          observed = undefined;
          throw error;
        }
      },
      async compareExchange(sequence, next) {
        const committed = await options.journal.compareExchange(sequence, next);
        if (committed) observe(next);
        return committed;
      },
    },
    recipient: {
      admitted: (handle, head, generation) =>
        [...hosts].some((host) =>
          host.recipient.admitted(handle, head, generation),
        ),
      deliver(handle, access, expiresAt) {
        // Delivery is synchronous; a handle belongs to exactly one private host.
        let delivered = false;
        for (const host of hosts) {
          const binding = snapshot();
          if (
            binding &&
            host.recipient.admitted(handle, binding.head, binding.generation)
          ) {
            host.recipient.deliver(handle, access, expiresAt);
            delivered = true;
            break;
          }
        }
        if (!delivered) throw new Error('Copilot recipient unavailable.');
      },
      revoke,
    },
    probe: async (access, account, signal) => {
      signal = AbortSignal.any([signal, ...(setupSignal ? [setupSignal] : [])]);
      const state = await options.journal.read();
      const mutation = state.mutation;
      if (
        !mutation ||
        mutation.kind !== 'create' ||
        mutation.origin !== 'setup' ||
        closed
      )
        throw new Error('Copilot setup is unavailable.');
      const setupIdentity: CopilotSelectionIdentity = {
        operationId: mutation.operationId,
        epoch: mutation.epoch,
        account,
        origin: 'setup',
      };
      const ownedSignal = lifetime.setupSignal(setupIdentity);
      if (!ownedSignal) throw new Error('Copilot setup is unavailable.');
      signal = AbortSignal.any([signal, ownedSignal]);
      if (!(await options.selection.prepare(setupIdentity, expectedSelection)))
        throw new Error('Copilot setup was superseded.');
      if (
        lifetime.closed() ||
        signal.aborted ||
        lifetime.setupSignal(setupIdentity) !== ownedSignal
      )
        throw new Error('Copilot setup was superseded.');
      const captured = publication;
      const head = {
        ...mutation,
        pin: {
          ref: { vaultId: 'setup', entryId: mutation.operationId },
          revision: 1,
        },
      };
      const host = createCopilotLocalRecipientHost({
        platform: options.platform,
        capable: () => options.capable(),
        current: () =>
          !closed &&
          !lifetime.closed() &&
          !signal.aborted &&
          publication === captured &&
          lifetime.setupSignal(setupIdentity) === ownedSignal,
        start: async (runtimeSignal) => {
          await recoverRuntimeReceipts();
          runtimeSignal.throwIfAborted();
          if (
            closed ||
            lifetime.closed() ||
            signal.aborted ||
            publication !== captured ||
            lifetime.setupSignal(setupIdentity) !== ownedSignal
          )
            throw new Error('Copilot runtime is unavailable.');
          const runtime = await options.start(undefined, runtimeSignal, {
            kind: 'discovery',
            id: 'copilot-setup-probe',
          });
          return {
            ...runtime,
            async execute(purpose, context): Promise<CopilotRecipientResult> {
              try {
                return await runtime.execute(purpose, context);
              } catch (error) {
                probeFailure = options.classifyProbeFailure(error);
                throw new Error('Copilot entitlement probe failed.');
              }
            },
          };
        },
        present: (handle) => {
          host.recipient.deliver(
            handle,
            access,
            Math.min(setupExpiry, (options.now ?? Date.now)() + 30_000),
          );
          return Promise.resolve();
        },
      });
      hosts.add(host);
      const abortHost = (): void => host.recipient.revoke();
      signal.addEventListener('abort', abortHost, { once: true });
      if (signal.aborted) abortHost();
      let outcome: unknown;
      const channel = await openCopilotLocalChannel(
        host,
        {
          head,
          authorityGeneration: 0,
          publicationGeneration: captured,
          purpose: 'setup-probe',
          audience: { kind: 'create', operationId: mutation.operationId },
          deadline: performance.now() + 30_000,
        },
        (encoded) => {
          const frame = CopilotLocalFrameSchema.parse(JSON.parse(encoded));
          if (frame.kind === 'response') outcome = frame.outcome;
          return Promise.resolve();
        },
      );
      const abort = (): void => channel.disconnect();
      signal.addEventListener('abort', abort, { once: true });
      try {
        signal.throwIfAborted();
        if (channel.opened.kind !== 'opened')
          throw new Error('Copilot setup is unavailable.');
        await channel.receive(
          JSON.stringify({
            requestId: 1,
            command: {
              version: 1,
              kind: 'run',
              handle: channel.opened.handle,
              generation: captured,
              purpose: 'setup-probe',
              audience: { kind: 'create', operationId: mutation.operationId },
            },
          }),
        );
        const frame = CopilotLocalFrameSchema.parse({
          kind: 'response',
          requestId: 1,
          outcome,
        });
        if (
          frame.kind !== 'response' ||
          frame.outcome.kind !== 'completed' ||
          frame.outcome.result.kind !== 'setup-probe'
        )
          throw new Error('Copilot entitlement probe failed.');
      } finally {
        signal.removeEventListener('abort', abort);
        signal.removeEventListener('abort', abortHost);
        channel.disconnect();
        host.close();
        hosts.delete(host);
      }
    },
  });
  lifetime.onQuiesce(() => {
    closed = true;
    revoke(); // Reuse local-host cancellation for active work and pending starts.
  });
  function snapshot():
    | { head: NonNullable<CopilotAuthorityRecord['head']>; generation: number }
    | undefined {
    if (options.qualificationAdmission && !options.qualificationAdmission())
      return undefined;
    const generation = authority.recipientGeneration();
    return generation !== undefined && observed?.head && !observed.removal
      ? { head: observed.head, generation }
      : undefined;
  }
  return Object.freeze({
    authority,
    recoverRuntimeReceipts,
    demand: () => authority.demand(),
    removePending: (operationId: string) =>
      authority.removePending(operationId),
    async setup(
      grant: CopilotVaultGrant,
      expectedPinGeneration: string | null,
      signal: AbortSignal = new AbortController().signal,
    ): Promise<CopilotPilotSetupResult> {
      if (closed || lifetime.closed() || settingUp)
        return { kind: 'blocked', reason: 'busy' };
      settingUp = true;
      setupExpiry = Date.parse(grant.accessTokenExpiresAt);
      setupSignal = signal;
      let setupOperationId: string | undefined;
      expectedSelection = expectedPinGeneration;
      probeFailure = undefined;
      try {
        const result = await authority.create(
          grant,
          'setup',
          (operationId) => {
            setupOperationId = operationId;
          },
          signal,
        );
        const outcome: CopilotPilotSetupResult = probeFailure
          ? { kind: 'probe-failed', reason: probeFailure }
          : result;
        return setupOperationId &&
          (outcome.kind === 'blocked' || outcome.kind === 'probe-failed')
          ? { ...outcome, setupOperationId }
          : outcome;
      } catch {
        return { kind: 'blocked', reason: 'unavailable', setupOperationId };
      } finally {
        settingUp = false;
        setupSignal = undefined;
      }
    },
    async open(
      purpose: CopilotRecipientPurpose,
      audience: CopilotRecipientAudience,
      policyKey: string | undefined,
      write: (encoded: string) => Promise<void>,
      signal?: AbortSignal,
    ) {
      signal?.throwIfAborted();
      if (closed || purpose === 'setup-probe' || hosts.size >= 32)
        throw new Error('Copilot runtime is unavailable.');
      await authority.status();
      signal?.throwIfAborted();
      const admittedSnapshot = snapshot();
      if (!admittedSnapshot) throw new Error('Copilot runtime is unavailable.');
      const captured = publication;
      const binding: CopilotRecipientBinding = {
        head: admittedSnapshot.head,
        authorityGeneration: admittedSnapshot.generation,
        publicationGeneration: captured,
        audience,
        purpose,
        deadline: performance.now() + 120_000,
      };
      const host = createCopilotLocalRecipientHost({
        platform: options.platform,
        capable: () => options.capable(),
        start: async (signal) => {
          await recoverRuntimeReceipts();
          signal.throwIfAborted();
          const live = snapshot();
          if (
            closed ||
            publication !== captured ||
            !live ||
            live.generation !== binding.authorityGeneration ||
            live.head.epoch !== binding.head.epoch
          )
            throw new Error('Copilot runtime is unavailable.');
          return options.start(policyKey, signal);
        },
        current: (candidate) => {
          const live = snapshot();
          return (
            !closed &&
            !!live &&
            candidate.authorityGeneration === live.generation &&
            captured === publication &&
            candidate.head.epoch === live.head.epoch &&
            candidate.head.account.id === live.head.account.id &&
            candidate.head.account.host === live.head.account.host &&
            candidate.head.pin.ref.vaultId === live.head.pin.ref.vaultId &&
            candidate.head.pin.ref.entryId === live.head.pin.ref.entryId
          );
        },
        present: (handle, epoch) => authority.present(handle, epoch),
        completed: options.completed,
      });
      hosts.add(host);
      const cancel = (): void => host.close();
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      try {
        const channel = await openCopilotLocalChannel(host, binding, write);
        return {
          ...channel,
          disconnect(): void {
            signal?.removeEventListener('abort', cancel);
            channel.disconnect();
            host.close();
            hosts.delete(host);
          },
        };
      } catch {
        signal?.removeEventListener('abort', cancel);
        host.close();
        hosts.delete(host);
        throw new Error('Copilot runtime is unavailable.');
      }
    },
    revoke(): void {
      revoked = true;
      authority.revoke();
    },
    reopen(): void {
      if (!closed && revoked) {
        revoked = false;
        authority.reopen();
      }
    },
    close(): void {
      closed = true;
      void authority.quiesce();
      for (const host of hosts) host.close();
      hosts.clear();
    },
    quiesce(): Promise<void> {
      closed = true;
      return authority.quiesce();
    },
  });
}
