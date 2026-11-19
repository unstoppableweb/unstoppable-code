import { randomUUID } from 'node:crypto';
import { CopilotCleanupResultSchema } from '@canopy/protocol/copilot-handoff';
import type { CopilotPilotState } from './repository/copilot-pilot-state';
import type { CopilotRetirementControl } from './repository/copilot-authority-codec';
import type {
  MigrationFamilyPorts,
  MigrationObservation,
  MigrationAttemptContext,
  MigrationDeletionResult,
} from './migration-ports';

/** Core owns authorization/phases; main owns only exact queue-local filesystem effects. */
export function createCopilotMigrationCleanup(options: {
  state: CopilotPilotState;
  admitted(): boolean;
  action(value: unknown): Promise<string>;
  observeClaim(operationId: string): Promise<MigrationObservation>;
  withQueue<T>(run: () => Promise<T>): Promise<T>;
}): NonNullable<MigrationFamilyPorts['deletion']> {
  const { state } = options;
  function authorized(
    context: MigrationAttemptContext & { operationId: string },
  ): void {
    const journal = state.migration.read();
    const attempt = journal.attempts.find((a) => a.id === context.attemptId);
    const b = state.read().binding;
    const retiring =
      !!b &&
      ['cancelling', 'retired'].includes(b.phase) &&
      attempt?.disposition === 'cancelled' &&
      journal.head.epoch > context.epoch &&
      journal.head.attemptId === null;
    if (
      !options.admitted() ||
      !b ||
      (!retiring && b.phase !== 'published') ||
      b.attemptId !== context.attemptId ||
      b.migrationEpoch !== context.epoch ||
      (!retiring &&
        (journal.head.attemptId !== context.attemptId ||
          journal.head.epoch !== context.epoch ||
          journal.head.authority !== 'vault')) ||
      attempt?.state !== 'verified' ||
      attempt.deletion?.id !== context.operationId ||
      attempt.deletion.phase !== 'submitted' ||
      attempt.identity.generation !== context.generation
    )
      throw new Error('Cleanup authorization unavailable.');
  }
  function save(control: CopilotRetirementControl): void {
    const before = state.read();
    const exists = before.controls.some(
      (c) => c.operationId === control.operationId,
    );
    if (
      !state.compareExchange(before.authority.sequence, {
        ...before,
        authority: {
          ...before.authority,
          sequence: before.authority.sequence + 1,
        },
        controls: exists
          ? before.controls.map((c) =>
              c.operationId === control.operationId ? control : c,
            )
          : [...before.controls, control],
      })
    )
      throw new Error('Cleanup phase unconfirmed.');
  }
  async function remove(
    context: MigrationAttemptContext & { operationId: string },
  ): Promise<MigrationDeletionResult> {
    try {
      authorized(context);
      const b = state.read().binding;
      if (!b?.destination) return { kind: 'outcome_unknown' };
      let control = state
        .read()
        .controls.find((c) => c.operationId === context.operationId);
      if (!control) {
        control = {
          kind: 'deletion',
          operationId: context.operationId,
          attemptId: context.attemptId,
          migrationEpoch: context.epoch,
          identity: b.identity,
          accountEpoch: b.accountEpoch,
          destination: b.destination,
          completionId: null,
          phase: 'authorized',
        };
        save(control);
      }
      if (
        control.kind !== 'deletion' ||
        control.attemptId !== context.attemptId ||
        control.identity.generation !== context.generation
      )
        return { kind: 'outcome_unknown' };
      async function host(
        step: 'claim' | 'detach' | 'remove',
      ): Promise<'done' | 'changed' | 'unavailable'> {
        authorized(context);
        const reply = CopilotCleanupResultSchema.parse(
          JSON.parse(
            await options.action({
              kind: 'cleanup',
              operationId: context.operationId,
              generation: context.generation,
              step,
            }),
          ),
        );
        authorized(context);
        return reply;
      }
      if (control.phase === 'authorized') {
        const hostResult = await host('claim');
        if (hostResult !== 'done') return { kind: hostResult };
        const observed = await options.observeClaim(context.operationId);
        authorized(context);
        if (
          observed.kind !== 'present' ||
          observed.generation !== context.generation
        )
          return { kind: 'outcome_unknown' };
        control = { ...control, phase: 'claim_ready' };
        save(control);
      }
      if (control.phase === 'claim_ready') {
        const hostResult = await host('detach');
        if (hostResult !== 'done') return { kind: hostResult };
        control = { ...control, phase: 'source_detached' };
        save(control);
      }
      if (control.phase === 'source_detached') {
        control = { ...control, phase: 'remove_authorized' };
        save(control);
      }
      if (control.phase === 'remove_authorized') {
        const hostResult = await host('remove');
        if (hostResult !== 'done') return { kind: hostResult };
        control = {
          ...control,
          phase: 'completed',
          completionId: randomUUID(),
        };
        save(control);
      }
      if (control.phase !== 'completed' || !control.completionId)
        return { kind: 'outcome_unknown' };
      return {
        kind: 'completed',
        operationId: context.operationId,
        generation: context.generation,
        completionId: control.completionId,
      };
    } catch {
      return { kind: 'outcome_unknown' };
    }
  }
  return {
    remove, // P2 already holds snapshot.withGeneration; never reacquire here
    reconcile: (context) => options.withQueue(() => remove(context)),
  };
}
