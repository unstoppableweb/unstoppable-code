import type { CopilotHandoffPhase } from '@canopy/protocol/copilot-handoff';
import { createCopilotMigrationCleanup } from './copilot-cleanup';
import { CopilotCleanupFreezeSchema } from '@canopy/protocol/copilot-handoff';
import {
  CopilotHandoffPreparedSchema,
  CopilotHandoffSuccessSchema,
  CopilotHandoffCommandSchema,
  type CopilotFreezeResult,
} from '@canopy/protocol/copilot-handoff';
import { createCopilotImportControls } from './copilot-import';
import {
  createCopilotHandoffPump,
  COPILOT_HANDOFF_PROTOCOL,
  parseCopilotHandoffFrame,
  type CopilotHandoffHost,
  type CopilotHandoffCorrelation,
} from './copilot-handoff-bridge';
import {
  CopilotFreezeResultSchema,
  CopilotConfirmResultSchema,
  CopilotSelectionReadSchema,
} from '@canopy/protocol/copilot-handoff';
import {
  createResumableMigrationModule,
  type MigrationModuleOptions,
} from './migration-module';
import {
  encodeMigrationFrame,
  parseMigrationLauncherFrame,
  migrationOfferFrame,
  migrationResultFrame,
  migrationRefusedFrame,
  type MigrationWireFrame,
} from './migration-protocol';
import type { CopilotPilotState } from './repository/copilot-pilot-state';
import type {
  CopilotAuthorityRecord,
  CopilotGrantHead,
  CopilotGrantResult,
} from './copilot-grant-contracts';
import type {
  MigrationObservation,
  MigrationSourceIdentity,
  MigrationFamilyPorts,
} from './migration-ports';

/** Private qualification endpoint. Production startup never constructs this factory. */
export interface CopilotHandoffCore {
  close(): void;
  cancelAdmission(): void;
  current(): boolean;
  unused(): boolean;
  retiredBinding(): CopilotHandoffCorrelation['binding'];
  ordinaryAuthority(): CopilotAuthorityRecord | null;
  phase(): CopilotHandoffPhase;
  exchange(
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<{ frames: MigrationWireFrame[] }>;
}
export function createCopilotHandoffCore(options: {
  state: CopilotPilotState;
  migration: Omit<MigrationModuleOptions, 'storage' | 'families'>;
  channel: object;
  observe(): Promise<MigrationObservation>;
  closeAdmission(): void;
  published(head: CopilotGrantHead): void;
  /** Shared P4 owner only; unpublished compensation never uses this port. */
  removePublished?(accountEpoch: string): Promise<CopilotGrantResult>;
  /** Same lazy P4 owner; reconcile local state before rebuilding the publication mirror. */
  recoverPublished?(): Promise<CopilotGrantResult>;
  observeClaim?(operationId: string): Promise<MigrationObservation>;
  use?: MigrationFamilyPorts['use'];
  deletion?: MigrationFamilyPorts['deletion'];
}): CopilotHandoffCore {
  let closed = false;
  const admittedAtStart = options.migration.admission.channel(options.channel);
  function admitted(checkEpoch = true): boolean {
    try {
      if (closed) return false;
      const b = options.state.read().binding;
      const epoch = options.migration.epoch();
      if (
        !Number.isSafeInteger(epoch) ||
        epoch < 0 ||
        (b &&
          b.phase !== 'cancelling' &&
          b.phase !== 'retired' &&
          !retiring &&
          checkEpoch &&
          b.migrationEpoch !== epoch)
      )
        return false;
      if (
        b &&
        (b.identity.brand !== options.migration.brand ||
          b.identity.build !== options.migration.build ||
          b.identity.sourceFlavor !== options.migration.source.flavorId ||
          b.identity.sourceMode !== options.migration.source.secureMode ||
          b.identity.slot !== 'copilot-account')
      )
        return false;
      const facts = options.migration.admission.channel(options.channel);
      return (
        !!facts &&
        !!admittedAtStart &&
        JSON.stringify(facts) === JSON.stringify(admittedAtStart) &&
        JSON.stringify(options.migration.admission.host()) ===
          JSON.stringify(admittedAtStart.admittedHost) &&
        !closed &&
        options.migration.epoch() === epoch
      );
    } catch {
      return false;
    }
  }
  let host: CopilotHandoffHost | undefined;
  let frozen: CopilotFreezeResult | undefined;
  let greeted = false;
  let commandId = 0;
  let retiring = false;
  function action(value: unknown): Promise<string> {
    if (!host) return Promise.reject(new Error('Handoff host unavailable.'));
    if (!admitted())
      return Promise.reject(new Error('Handoff admission lost.'));
    return host.action(JSON.stringify(value)).then((reply) => {
      if (!admitted()) throw new Error('Handoff admission lost.');
      return reply;
    });
  }
  const controls = createCopilotImportControls({
    state: options.state,
    admitted,
    epoch: options.migration.epoch,
    closeAdmission: () => options.closeAdmission(),
    published: (head) => options.published(head),
    selection: {
      prepare: async (identity, predecessorGeneration): Promise<boolean> =>
        CopilotHandoffPreparedSchema.parse(
          JSON.parse(
            await action({ kind: 'prepare', identity, predecessorGeneration }),
          ),
        ),
      confirm: async (request) => {
        const b = options.state.read().binding;
        if (!b) throw new Error('Import binding missing.');
        return CopilotConfirmResultSchema.parse(
          JSON.parse(
            await action({
              kind: 'confirm',
              generation: b.identity.generation,
              predecessorGeneration: b.predecessorGeneration,
              request,
            }),
          ),
        );
      },
      abandon: async (identity): Promise<void> => {
        CopilotHandoffSuccessSchema.parse(
          JSON.parse(
            await action({
              kind: 'abandon',
              identity,
              published: options.state.read().authority.head !== null,
              destination:
                options.state
                  .read()
                  .controls.find((c) => c.operationId === identity.operationId)
                  ?.destination ?? null,
            }),
          ),
        );
      },
      disable: () => Promise.resolve({ kind: 'unconfirmed' }),
    },
  });
  async function withCleanupQueue<T>(run: () => Promise<T>): Promise<T> {
    if (frozen) throw new Error('Recursive source queue acquisition.');
    const b = options.state.read().binding;
    if (!b || !['published', 'cancelling', 'retired'].includes(b.phase))
      throw new Error('Cleanup binding unavailable.');
    const held = CopilotCleanupFreezeSchema.parse(
      JSON.parse(await action({ kind: 'freeze-cleanup' })),
    );
    frozen = {
      ...held,
      generation: b.identity.generation,
      account: b.account,
      predecessorGeneration: b.predecessorGeneration,
    };
    try {
      return await run();
    } finally {
      await action({
        kind: 'release',
        disposition: retiring ? 'cancelling' : 'selected',
      });
      frozen = undefined;
    }
  }
  const cleanup = createCopilotMigrationCleanup({
    state: options.state,
    admitted: () =>
      admitted() &&
      ['published', 'cancelling', 'retired'].includes(
        options.state.read().binding?.phase ?? '',
      ),
    action,
    observeClaim: (id) =>
      options.observeClaim?.(id) ??
      Promise.resolve({ kind: 'outcome_unknown' }),
    withQueue: withCleanupQueue,
  });
  let cleanupOperation = false;
  const sessions = createResumableMigrationModule({
    ...options.migration,
    storage: options.state.migration,
    families: [
      {
        slot: 'copilot-account',
        importer: controls,
        snapshot: {
          observe: (): Promise<MigrationObservation> => options.observe(),
          async withGeneration<T>(
            _source: MigrationSourceIdentity,
            run: (observation: MigrationObservation) => Promise<T>,
          ): Promise<T> {
            const invoke = async (): Promise<T> => {
              if (!frozen) throw new Error('Source queue not held.');
              const observed = await options.observe();
              if (
                observed.kind !== 'present' ||
                observed.generation !== frozen.generation
              )
                throw new Error('Source generation changed.');
              return run(observed);
            };
            return cleanupOperation ? withCleanupQueue(invoke) : invoke();
          },
        },
        use: options.use ?? {
          use: (): Promise<{ kind: 'unavailable' }> =>
            Promise.resolve({ kind: 'unavailable' }),
        },
        deletion:
          options.deletion ??
          (options.observeClaim
            ? cleanup
            : {
                remove: (): Promise<{ kind: 'unavailable' }> =>
                  Promise.resolve({ kind: 'unavailable' }),
                reconcile: (): Promise<{ kind: 'unavailable' }> =>
                  Promise.resolve({ kind: 'unavailable' }),
              }),
      },
    ],
  });
  function bindingFacts(): CopilotHandoffCorrelation['binding'] {
    const b = options.state.read().binding;
    return (
      b && {
        attemptId: b.attemptId,
        migrationEpoch: b.migrationEpoch,
        operationId: b.operationId,
        accountEpoch: b.accountEpoch,
      }
    );
  }
  const pump = createCopilotHandoffPump({
    sourceFlavor: options.migration.source.flavorId,
    sourceMode: options.migration.source.secureMode,
    binding: bindingFacts,
    freezeId: () => frozen?.freezeId ?? null,
    lost: () => {
      closed = true;
      controls.stop();
      sessions.close();
      host = undefined;
      frozen = undefined;
      options.closeAdmission();
    },
  });
  async function freeze(): Promise<void> {
    controls.close();
    frozen = CopilotFreezeResultSchema.parse(
      JSON.parse(await action({ kind: 'freeze' })),
    );
    const observed = await options.observe();
    if (
      observed.kind !== 'present' ||
      observed.generation !== frozen.generation
    )
      throw new Error('Independent source observation disagrees.');
    const b = options.state.read().binding;
    if (
      b &&
      (b.identity.generation !== frozen.generation ||
        JSON.stringify(b.account) !== JSON.stringify(frozen.account))
    )
      throw new Error('Frozen binding disagrees.');
  }
  async function checkpoint(): Promise<void> {
    const b = options.state.read().binding;
    if (!b) throw new Error('Import binding missing.');
    CopilotHandoffSuccessSchema.parse(
      JSON.parse(
        await action({
          kind: 'checkpoint',
          binding: {
            attemptId: b.attemptId,
            migrationEpoch: b.migrationEpoch,
            operationId: b.operationId,
            accountEpoch: b.accountEpoch,
          },
        }),
      ),
    );
  }

  function retiredBinding(): CopilotHandoffCorrelation['binding'] {
    try {
      if (!admitted()) return null;
      const state = options.state.read();
      const b = state.binding;
      const migration = options.state.migration.read();
      if (
        !b ||
        b.phase !== 'retired' ||
        migration.head.epoch <= b.migrationEpoch ||
        migration.head.attemptId === b.attemptId ||
        state.authority.head?.origin === 'import' ||
        state.authority.mutation?.origin === 'import' ||
        !state.controls.some(
          (c) =>
            c.kind === 'retirement' &&
            c.phase === 'retired' &&
            c.operationId === b.operationId &&
            c.accountEpoch === b.accountEpoch &&
            c.attemptId === b.attemptId &&
            c.migrationEpoch === b.migrationEpoch,
        )
      )
        return null;
      return bindingFacts();
    } catch {
      return null;
    }
  }

  return {
    close: (): void => pump.close(),
    cancelAdmission: (): void => controls.cancelAdmission(),
    phase(): CopilotHandoffPhase {
      try {
        const b = options.state.read().binding;
        if (!b)
          return options.state.unused()
            ? 'invalid_unbound'
            : 'fenced_before_selection';
        if (b.phase === 'cancelling' || b.phase === 'retired')
          return 'cancelling_retired';
        if (!admitted()) return 'invalid_unbound';
        if (b.phase === 'pre_ingress') return 'bound_pre_ingress';
        if (b.phase === 'ingress_accepted') {
          return options.state.migration.resolve(b.attemptId).kind ===
            'not_accepted'
            ? 'ingress_accepted'
            : 'submitted_uncertain';
        }
        if (b.phase === 'published' && controls.current()) return 'published';
        return options.state.migration.read().head.authority === 'vault'
          ? 'host_confirmation_pending'
          : 'committed_unpublished';
      } catch {
        return 'invalid_unbound';
      }
    },
    current: () => admitted() && controls.current(),
    unused: (): boolean => admitted() && options.state.unused(),
    retiredBinding,
    ordinaryAuthority() {
      return retiredBinding() ? options.state.read().authority : null;
    },
    async exchange(
      raw: unknown,
      signal?: AbortSignal,
    ): Promise<{ frames: MigrationWireFrame[] }> {
      const cancelled = (): void => pump.close();
      signal?.addEventListener('abort', cancelled, { once: true });
      try {
        signal?.throwIfAborted();
        if (
          typeof raw === 'object' &&
          raw !== null &&
          'protocol' in raw &&
          raw.protocol === COPILOT_HANDOFF_PROTOCOL &&
          'type' in raw &&
          raw.type === 'command'
        ) {
          const candidate = parseCopilotHandoffFrame(raw);
          const command = CopilotHandoffCommandSchema.parse(
            JSON.parse(candidate.payload),
          );
          if (
            command.kind === 'cancel' ||
            options.state.read().authority.removal ||
            ['cancelling', 'retired'].includes(
              options.state.read().binding?.phase ?? '',
            )
          ) {
            controls.cancelAdmission(); // synchronous closure precedes the first host or persistence await
            retiring = true;
          }
        }
        if (
          !admitted(
            !(
              typeof raw === 'object' &&
              raw !== null &&
              'type' in raw &&
              raw.type === 'hello'
            ),
          )
        )
          throw new Error('Handoff channel not admitted.');
        if (
          typeof raw === 'object' &&
          raw !== null &&
          'protocol' in raw &&
          raw.protocol === COPILOT_HANDOFF_PROTOCOL
        ) {
          const frame = parseCopilotHandoffFrame(raw);
          if (frame.type === 'reply') return await pump.reply(raw);
          if (
            frame.type !== 'command' ||
            !greeted ||
            frame.correlation.requestId !== ++commandId ||
            frame.correlation.sourceFlavor !==
              options.migration.source.flavorId ||
            frame.correlation.sourceMode !==
              options.migration.source.secureMode ||
            frame.correlation.incarnation !== 'command' ||
            frame.correlation.freezeId !== null ||
            (frame.correlation.binding !== null &&
              JSON.stringify(frame.correlation.binding) !==
                JSON.stringify(bindingFacts()))
          )
            throw new Error('Unexpected handoff command.');
          const command = CopilotHandoffCommandSchema.parse(
            JSON.parse(frame.payload),
          );
          if (frame.correlation.operation !== command.kind)
            throw new Error('Cross-operation command.');
          return await pump.start(command.kind, async (port) => {
            host = port;
            if (
              command.kind === 'begin' &&
              !sessions.preflightImport(command.sessionId, {
                channel: options.channel,
                challenge: command.challenge,
                operation: command.operation,
                purpose: command.purpose,
              })
            )
              throw new Error('Import preflight refused.');
            const existing = options.state.read().binding;
            const local = options.state.read().authority;
            if (
              existing?.phase === 'published' &&
              !local.removal &&
              local.mutation &&
              (local.mutation.kind === 'refresh' ||
                local.mutation.kind === 'replace') &&
              command.kind !== 'cancel' &&
              !controls.current()
            ) {
              const recovered = await options.recoverPublished?.();
              if (
                recovered?.kind !== 'ready' ||
                recovered.head.epoch !== existing.accountEpoch ||
                options.state.read().authority.mutation
              )
                throw new Error('Published local recovery unconfirmed.');
            }
            if (
              existing?.phase === 'published' &&
              (command.kind === 'cancel' ||
                options.state.read().authority.removal)
            ) {
              controls.cancelAdmission();
              if (!options.removePublished)
                throw new Error('Published account removal unavailable.');
              const result = await options.removePublished(
                existing.accountEpoch,
              );
              const after = options.state.read();
              if (
                result.kind !== 'removed' ||
                after.binding?.operationId !== existing.operationId ||
                after.binding.phase !== 'retired' ||
                after.authority.head ||
                after.authority.mutation ||
                after.authority.removal ||
                after.authority.completed?.kind !== 'delete' ||
                after.authority.completed.epoch !== existing.accountEpoch
              )
                throw new Error('Published account retirement unconfirmed.');
              await action({
                kind: 'abandon',
                identity: {
                  operationId: existing.operationId,
                  epoch: existing.accountEpoch,
                  account: existing.account,
                  origin: 'import',
                },
                published: true,
                destination: existing.destination,
              });
            }
            if (command.kind === 'cancel' && !existing) {
              const bundle = options.state.read();
              const journal = options.state.migration.read();
              // P1 preparation can outlive the crash before the atomic P4 begin.
              // Only exact non-acceptance permits retirement without new ingress.
              if (
                bundle.authority.sequence !== 0 ||
                bundle.authority.head ||
                bundle.authority.mutation ||
                bundle.authority.removal ||
                bundle.authority.completed ||
                bundle.controls.length ||
                journal.attempts.some(
                  (attempt) =>
                    attempt.identity.brand !== options.migration.brand ||
                    attempt.identity.build !== options.migration.build ||
                    attempt.identity.sourceFlavor !==
                      options.migration.source.flavorId ||
                    attempt.identity.sourceMode !==
                      options.migration.source.secureMode ||
                    options.state.migration.resolveExact(attempt.id).kind !==
                      'not_accepted',
                )
              )
                throw new Error('Unbound retirement outcome unavailable.');
              if (journal.head.attemptId)
                options.state.migration.supersede(
                  Math.max(journal.head.epoch, options.migration.epoch()) + 1,
                  'qualification-unaccepted-import-cancelled',
                );
              CopilotHandoffSuccessSchema.parse(
                JSON.parse(await action({ kind: 'freeze', retirement: true })),
              );
              if (
                CopilotSelectionReadSchema.parse(
                  JSON.parse(await action({ kind: 'read' })),
                ) !== null
              )
                throw new Error('Unbound host retirement outcome unavailable.');
              await action({ kind: 'release', disposition: 'retired' });
              pump.complete();
              return pump.terminal('retired');
            }
            if (
              existing &&
              (command.kind === 'cancel' ||
                ['cancelling', 'retired'].includes(
                  options.state.read().binding?.phase ?? '',
                ))
            ) {
              controls.beginCancellation(existing.operationId);
              CopilotHandoffSuccessSchema.parse(
                JSON.parse(await action({ kind: 'freeze', retirement: true })),
              );
              await checkpoint(); // recover an acknowledgement lost before main learned the binding
              const attempt = options.state.migration
                .read()
                .attempts.find((a) => a.id === existing.attemptId);
              // Already submitted source cleanup owns its claim until exact completion, even when
              // this cancellation will retire selection. Keep the durable main cancellation fence.
              if (
                attempt?.state === 'verified' &&
                attempt.deletion?.phase === 'submitted'
              ) {
                const result = await cleanup.reconcile({
                  attemptId: attempt.id,
                  epoch: attempt.epoch,
                  source: options.migration.source,
                  generation: attempt.identity.generation,
                  operationId: attempt.deletion.id,
                });
                if (result.kind !== 'completed' || !result.completionId)
                  throw new Error('Source cleanup retirement unresolved.');
                options.state.migration.retiredDeletionReceipt(
                  attempt.id,
                  attempt.epoch,
                  result.operationId,
                  result.generation,
                  result.completionId,
                );
              }
              await controls.cancel(existing.operationId);
              await action({ kind: 'release', disposition: 'retired' });
              pump.complete();
              return pump.terminal('retired');
            }
            if (command.kind === 'verify' || command.kind === 'cleanup') {
              if (
                !controls.current() &&
                (await controls.recover()) !== 'published'
              )
                throw new Error('Published import unavailable.');
              cleanupOperation = command.kind === 'cleanup';
              const result =
                command.kind === 'verify'
                  ? await sessions.verify()
                  : await sessions.deleteLegacy();
              cleanupOperation = false;
              if (
                command.kind === 'cleanup' &&
                (await controls.recover()) !== 'published'
              )
                throw new Error('Cleanup publication unavailable.');
              pump.complete();
              return pump.terminal(JSON.stringify(result));
            }
            if (command.kind === 'resume' && options.state.read().binding) {
              const result = await controls.recover();
              if (result === 'published') {
                await action({ kind: 'release', disposition: 'selected' });
                frozen = undefined;
                pump.complete();
                return pump.terminal('published');
              }
              if (result !== 'resupply')
                throw new Error('Old import still unresolved.');
            }
            // Committed custody survives source cleanup; only resupply needs a new capture.
            await freeze();
            if (!frozen) throw new Error('Freeze lost.');
            const context = await sessions.beginImport(
              command.sessionId,
              {
                channel: options.channel,
                challenge: command.challenge,
                operation: command.operation,
                purpose: command.purpose,
              },
              frozen.account,
              frozen.predecessorGeneration,
            );
            await checkpoint();
            return pump.terminal(
              JSON.stringify({
                kind: 'ingress-ready',
                operationId: options.state.migration.importKey(
                  context.attemptId,
                ),
              }),
            );
          });
        }
        const parsed = parseMigrationLauncherFrame(raw);
        if (!parsed.ok) throw new Error('Migration frame refused.');
        const frame = parsed.frame;
        if (frame.type === 'hello') {
          if (greeted) {
            if (frozen) throw new Error('Repeated hello during handoff.');
            return { frames: [encodeMigrationFrame({ type: 'welcome' })] };
          }
          greeted = true;
          const issued = await sessions.issue(
            options.channel,
            'copilot-account',
          );
          return {
            frames: [
              encodeMigrationFrame({ type: 'welcome' }),
              ...(issued.issued
                ? [encodeMigrationFrame(migrationOfferFrame(issued.offer))]
                : []),
            ],
          };
        }
        if (!greeted) {
          if (frame.type === 'import') frame.value.fill(0);
          throw new Error('Hello required.');
        }
        const presentation = {
          channel: options.channel,
          challenge: frame.challenge,
          operation: frame.operation,
          purpose: frame.purpose,
        };
        if (frame.type === 'decline') {
          if (frozen) throw new Error('Unexpected decline during handoff.');
          sessions.decline(frame.sessionId, presentation, frame.reason);
          return { frames: [] };
        }
        if (!frozen) {
          frame.value.fill(0);
          throw new Error('Import checkpoint required.');
        }
        let handedOff = false;
        try {
          return await pump.start('import', async (port) => {
            host = port;
            handedOff = true;
            const result = sessions.importSlot(
              frame.sessionId,
              presentation,
              frame.value,
            );
            if (!result.accepted)
              return encodeMigrationFrame(
                migrationRefusedFrame(frame.sessionId, result.reason),
              );
            // The pump, not the occupied exchange, owns the outcome and any host replies it needs.
            const outcome = await result.outcome;
            if (outcome.state === 'completed') {
              await action({ kind: 'release', disposition: 'selected' });
              frozen = undefined;
              pump.complete();
            }
            return encodeMigrationFrame(
              migrationResultFrame(frame.sessionId, outcome),
            );
          });
        } catch (error) {
          if (!handedOff) frame.value.fill(0);
          throw error;
        }
      } catch (error) {
        pump.close();
        throw error;
      } finally {
        signal?.removeEventListener('abort', cancelled);
      }
    },
  };
}
