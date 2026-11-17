import { randomUUID } from 'node:crypto';
import type { CopilotPilotState } from './repository/copilot-pilot-state';
import { canonicalCopilotJson as canonical } from './repository/copilot-authority-codec';
import type {
  CopilotAuthorityBundle,
  CopilotImportBinding,
} from './repository/copilot-authority-codec';
import {
  CopilotVaultGrantSchema,
  type CopilotGrantHead,
  type CopilotSelectionPort,
  type CopilotSelectionReceipt,
  type CopilotVaultAccount,
} from './copilot-grant-contracts';
import type { MigrationAttemptContext } from './migration-ports';

export interface CopilotImportControls {
  close(): void;
  cancelAdmission(): void;
  current(): boolean;
  begin(
    context: MigrationAttemptContext & {
      idempotencyKey: string;
      account: CopilotVaultAccount;
      predecessorGeneration: string | null;
    },
  ): Promise<void>;
  import(
    context: MigrationAttemptContext & {
      idempotencyKey: string;
      value: Uint8Array;
      isCurrent?: () => boolean;
    },
  ): Promise<void>;
  finalize(
    context: MigrationAttemptContext,
    isCurrent?: () => boolean,
  ): Promise<void>;
  recover(): Promise<'resupply' | 'published' | 'unresolved'>;
  beginCancellation(operationId: string): void;
  cancel(operationId: string): Promise<void>;
  stop(): void;
}
/** Qualification-only controls. Supply commits; only finalize can publish. */
export function createCopilotImportControls(options: {
  state: CopilotPilotState;
  admitted(): boolean;
  epoch?(): number;
  selection: CopilotSelectionPort & {
    prepare(
      identity: {
        operationId: string;
        epoch: string;
        account: CopilotVaultAccount;
        origin: 'import';
      },
      predecessor: string | null,
    ): Promise<boolean>;
  };
  closeAdmission(): void;
  published(head: CopilotGrantHead): void;
}): CopilotImportControls {
  const { state } = options;
  let active: Promise<void> | undefined;
  let closed = false;
  let cancellation = false;
  let publication = 0;
  let mirror:
    | {
        head: CopilotGrantHead;
        receipt: CopilotSelectionReceipt;
        publication: number;
      }
    | undefined;
  function close(): void {
    mirror = undefined;
    publication++;
    options.closeAdmission();
  }
  function update(
    before: CopilotAuthorityBundle,
    patch: Partial<CopilotAuthorityBundle>,
  ): void {
    if (
      !state.compareExchange(before.authority.sequence, {
        ...before,
        ...patch,
        authority: {
          ...(patch.authority ?? before.authority),
          sequence: before.authority.sequence + 1,
        },
      })
    )
      throw new Error('Import checkpoint unconfirmed.');
  }
  function binding(context?: MigrationAttemptContext): CopilotImportBinding {
    const before = state.read();
    const b = before.binding;
    const journal = state.migration.read();
    const attempt = journal.attempts.find((a) => a.id === b?.attemptId);
    if (
      !b ||
      !attempt ||
      attempt.disposition === 'cancelled' ||
      b.phase === 'cancelling' ||
      b.phase === 'retired' ||
      closed ||
      !options.admitted() ||
      cancellation ||
      (options.epoch && options.epoch() !== b.migrationEpoch) ||
      journal.head.attemptId !== b.attemptId ||
      journal.head.epoch !== b.migrationEpoch ||
      (context &&
        (context.attemptId !== b.attemptId ||
          context.epoch !== b.migrationEpoch ||
          context.generation !== b.identity.generation ||
          context.source.flavorId !== b.identity.sourceFlavor ||
          context.source.secureMode !== b.identity.sourceMode))
    )
      throw new Error('Import binding unavailable.');
    return b;
  }
  async function reconcile(): Promise<'committed' | 'resupply' | 'unresolved'> {
    const b = binding();
    const result = await state.journal.reconcile(b.operationId);
    binding();
    if (result.kind === 'committed') {
      const before = state.read();
      if (before.binding?.phase !== 'published')
        update(before, {
          binding: { ...b, phase: 'committed', destination: result.pin },
          authority: {
            ...before.authority,
            mutation: before.authority.mutation && {
              ...before.authority.mutation,
              committed: result.pin,
            },
          },
        });
      return 'committed';
    }
    return result.kind === 'not_accepted' || result.kind === 'retryable'
      ? 'resupply'
      : 'unresolved';
  }
  async function finalize(
    context: MigrationAttemptContext,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    close();
    const b = binding(context);
    if (!isCurrent()) throw new Error('Import release expired.');
    if ((await reconcile()) !== 'committed')
      throw new Error('Import unresolved.');
    if (!isCurrent()) throw new Error('Import release expired.');
    const current = binding(context);
    const p1 = state.migration.read().head;
    if (
      p1.authority !== 'vault' ||
      p1.attemptId !== b.attemptId ||
      p1.epoch !== b.migrationEpoch ||
      !current.destination
    )
      throw new Error('Import not selected.');
    const request = {
      operationId: b.operationId,
      epoch: b.accountEpoch,
      account: b.account,
      origin: 'import' as const,
      pin: current.destination,
    };
    const confirmed = await options.selection.confirm(request);
    const latest = binding(context);
    if (!isCurrent()) throw new Error('Import release expired.');
    if (
      confirmed.kind !== 'confirmed' ||
      !confirmed.receipt.pinGeneration ||
      canonical({
        operationId: confirmed.receipt.operationId,
        epoch: confirmed.receipt.epoch,
        account: confirmed.receipt.account,
        origin: confirmed.receipt.origin,
        pin: confirmed.receipt.pin,
      }) !== canonical(request)
    )
      throw new Error('Host receipt unconfirmed.');
    const before = state.read();
    // The binding and host receipt retain the import pin. A normal P4 refresh
    // advances only the authority head; reconcile it without relabelling old use.
    const resolved = state.migration.resolve(b.attemptId);
    const head =
      latest.phase === 'published'
        ? before.authority.head
        : { ...request, pinGeneration: confirmed.receipt.pinGeneration };
    if (
      !head ||
      (latest.phase === 'published' && before.authority.mutation) ||
      (latest.phase === 'published' &&
        head.pinGeneration !== confirmed.receipt.pinGeneration) ||
      before.authority.removal ||
      resolved.kind !== 'committed' ||
      canonical(head.pin) !== canonical(resolved.pin) ||
      canonical({
        ...head,
        pin: request.pin,
        pinGeneration: confirmed.receipt.pinGeneration,
      }) !==
        canonical({
          ...request,
          pinGeneration: confirmed.receipt.pinGeneration,
        })
    )
      throw new Error('Published lineage unresolved.');
    if (latest.phase !== 'published')
      update(before, {
        binding: { ...latest, phase: 'published' },
        authority: { ...before.authority, head, mutation: null },
      });
    const final = state.read();
    if (canonical(final.authority.head) !== canonical(head))
      throw new Error('Publication changed.');
    mirror = {
      head: structuredClone(head),
      receipt: confirmed.receipt,
      publication,
    };
    options.published(head);
  }
  function beginCancellation(operationId: string): void {
    cancellation = true;
    close();
    const before = state.read();
    const b = before.binding;
    if (!b || b.operationId !== operationId)
      throw new Error('Import cancellation identity unavailable.');
    if (b.phase === 'retired') return;
    if (b.phase !== 'cancelling')
      update(before, {
        binding: { ...b, phase: 'cancelling' },
        authority: {
          ...before.authority,
          mutation: before.authority.mutation && {
            ...before.authority.mutation,
            cancelling: true,
          },
        },
      });
    // P1 and P4 writes are separate commits. Recovery always finishes this fence first.
    const migrationHead = state.migration.read().head;
    if (migrationHead.attemptId === b.attemptId)
      state.migration.supersede(
        Math.max(migrationHead.epoch, options.epoch?.() ?? 0) + 1,
        'qualification-import-cancelled',
      );
  }
  return {
    close,
    cancelAdmission(): void {
      cancellation = true;
      close();
    },
    current(): boolean {
      try {
        const b = binding();
        const before = state.read();
        const p1 = state.migration.read().head;
        return (
          !!mirror &&
          mirror.publication === publication &&
          b.phase === 'published' &&
          p1.authority === 'vault' &&
          p1.attemptId === b.attemptId &&
          p1.epoch === b.migrationEpoch &&
          canonical(before.authority.head) === canonical(mirror.head) &&
          canonical({ ...mirror.head, pin: mirror.receipt.pin }) ===
            canonical(mirror.receipt) &&
          (!before.authority.mutation ||
            (['refresh', 'replace'].includes(before.authority.mutation.kind) &&
              !before.authority.mutation.cancelling &&
              before.authority.mutation.epoch === mirror.head.epoch &&
              before.authority.mutation.origin === mirror.head.origin &&
              canonical(before.authority.mutation.account) ===
                canonical(mirror.head.account) &&
              canonical(before.authority.mutation.from) ===
                canonical(mirror.head.pin))) &&
          !before.authority.removal
        );
      } catch {
        return false;
      }
    },
    begin(
      context: MigrationAttemptContext & {
        idempotencyKey: string;
        account: CopilotVaultAccount;
        predecessorGeneration: string | null;
      },
    ): Promise<void> {
      close();
      const before = state.read();
      if (before.binding) {
        const b = binding(context);
        if (
          b.operationId !== context.idempotencyKey ||
          canonical(b.account) !== canonical(context.account) ||
          b.predecessorGeneration !== context.predecessorGeneration
        )
          return Promise.reject(new Error('Import checkpoint disagrees.'));
        return Promise.resolve();
      }
      if (
        closed ||
        before.authority.head ||
        before.authority.mutation ||
        before.authority.removal
      )
        return Promise.reject(new Error('Import busy.'));
      const attempt = state.migration
        .read()
        .attempts.find((a) => a.id === context.attemptId);
      if (
        !attempt ||
        attempt.epoch !== context.epoch ||
        attempt.identity.generation !== context.generation ||
        state.migration.importKey(attempt.id) !== context.idempotencyKey
      )
        return Promise.reject(new Error('Import identity unavailable.'));
      const b: CopilotImportBinding = {
        attemptId: attempt.id,
        migrationEpoch: attempt.epoch,
        identity: attempt.identity,
        operationId: context.idempotencyKey,
        accountEpoch: randomUUID(),
        account: context.account,
        predecessorGeneration: context.predecessorGeneration,
        phase: 'pre_ingress',
        destination: null,
      };
      update(before, {
        migrationEpoch: attempt.epoch,
        binding: b,
        authority: {
          ...before.authority,
          mutation: {
            operationId: b.operationId,
            epoch: b.accountEpoch,
            account: b.account,
            origin: 'import',
            kind: 'create',
            from: null,
            committed: null,
            probeConfirmed: false,
            cancelling: false,
          },
        },
      });
      return Promise.resolve();
    },
    import(
      context: MigrationAttemptContext & {
        idempotencyKey: string;
        value: Uint8Array;
        isCurrent?: () => boolean;
      },
    ): Promise<void> {
      close();
      if (active)
        return Promise.reject(new Error('Import submission still running.'));
      const task = (async (): Promise<void> => {
        const b = binding(context);
        if (b.operationId !== context.idempotencyKey)
          throw new Error('Import key changed.');
        const parsed = CopilotVaultGrantSchema.parse(
          JSON.parse(
            Buffer.from(
              context.value.buffer,
              context.value.byteOffset,
              context.value.byteLength,
            ).toString('utf8'),
          ),
        );
        const { host, login, id } = parsed;
        if (canonical({ host, login, id }) !== canonical(b.account))
          throw new Error('Import account changed.');
        const outcome = await reconcile();
        if (outcome === 'committed') return;
        if (outcome !== 'resupply')
          throw new Error('Import submission unresolved.');
        const before = state.read();
        if (!before.authority.mutation)
          throw new Error('Import mutation missing.');
        if (before.binding?.phase === 'pre_ingress')
          update(before, {
            binding: { ...b, phase: 'ingress_accepted' },
            authority: {
              ...before.authority,
              mutation: { ...before.authority.mutation, probeConfirmed: true },
            },
          });
        if (context.isCurrent && !context.isCurrent())
          throw new Error('Import release expired.');
        if (
          !(await options.selection.prepare(
            {
              operationId: b.operationId,
              epoch: b.accountEpoch,
              account: b.account,
              origin: 'import',
            },
            b.predecessorGeneration,
          ))
        )
          throw new Error('Host preparation unconfirmed.');
        binding(context);
        const bytes = Buffer.from(JSON.stringify(parsed));
        try {
          binding(context);
          if (context.isCurrent && !context.isCurrent())
            throw new Error('Import release expired.');
          await state.writer.put({
            family: 'copilot-account',
            entryId: null,
            expectedRevision: null,
            label: 'Copilot',
            material: bytes,
            expiresAt: null,
            idempotencyKey: b.operationId,
          });
          binding(context);
          if ((await reconcile()) !== 'committed')
            throw new Error('Import commit unconfirmed.');
        } finally {
          bytes.fill(0);
        }
      })();
      active = task;
      void task
        .finally(() => {
          if (active === task) active = undefined;
        })
        .catch(() => undefined);
      return task;
    },
    finalize,
    async recover(): Promise<'resupply' | 'published' | 'unresolved'> {
      close();
      if (active) return 'unresolved';
      const b = binding();
      const result = await reconcile();
      if (result !== 'committed') return result;
      state.migration.reconcile(b.attemptId, b.migrationEpoch);
      state.migration.select(b.attemptId, b.migrationEpoch);
      await finalize({
        attemptId: b.attemptId,
        epoch: b.migrationEpoch,
        source: {
          flavorId: b.identity.sourceFlavor,
          secureMode: b.identity.sourceMode,
        },
        generation: b.identity.generation,
      });
      return 'published';
    },
    beginCancellation,
    async cancel(operationId): Promise<void> {
      beginCancellation(operationId);
      let before = state.read();
      const b = before.binding;
      if (!b || b.operationId !== operationId)
        throw new Error('Import cancellation identity unavailable.');
      if (b.phase === 'retired') return;
      await active?.catch(() => undefined); // actual settlement, never a session timeout
      await state.journal.reconcile(operationId);
      before = state.read();
      let control = before.controls.find((c) => c.operationId === operationId);
      if (!control) {
        const exact = state.migration.resolveExact(b.attemptId);
        if (
          !['committed', 'not_accepted', 'not_committed'].includes(exact.kind)
        )
          throw new Error('Import cancellation unresolved.');
        control = {
          kind: 'retirement',
          operationId,
          attemptId: b.attemptId,
          migrationEpoch: b.migrationEpoch,
          identity: b.identity,
          accountEpoch: b.accountEpoch,
          destination: exact.kind === 'committed' ? exact.pin : null,
          completionId: null,
          phase: 'cancelling',
        };
        update(before, { controls: [...before.controls, control] });
      }
      if (control.destination) {
        const deleted = await state.writer.delete({
          ref: control.destination.ref,
          expectedRevision: control.destination.revision,
          idempotencyKey: `copilot-import-retirement:${b.attemptId}`,
        });
        if (deleted.kind !== 'committed')
          throw new Error('Import retirement unconfirmed.');
      }
      if (!options.selection.abandon)
        throw new Error('Host retirement unavailable.');
      await options.selection.abandon({
        operationId,
        epoch: b.accountEpoch,
        account: b.account,
        origin: 'import',
      });
      before = state.read();
      update(before, {
        migrationEpoch: state.migration.read().head.epoch,
        binding: { ...b, phase: 'retired' },
        controls: before.controls.map((c) =>
          c.operationId === operationId ? { ...c, phase: 'retired' } : c,
        ),
        authority: { ...before.authority, head: null, mutation: null },
      });
    },
    stop(): void {
      closed = true;
      close();
    },
  };
}
