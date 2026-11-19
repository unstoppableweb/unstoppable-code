import {
  CopilotHandoffControlSchema,
  CopilotHandoffActionSchema,
  type CopilotHandoffControl,
  type CopilotHandoffPhase,
  CopilotHandoffPhaseSchema,
} from '@canopy/protocol/copilot-handoff';
import { randomUUID } from 'node:crypto';
import { lstat, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createPlatformEndpointServices,
  hostPlatformOperatingSystem,
  hostPlatformServices,
} from '@canopy/core-platform';
import {
  COPILOT_HANDOFF_BOUND_MS,
  COPILOT_HANDOFF_PROTOCOL,
  encodeCopilotHandoffFrame,
  parseCopilotHandoffFrame,
  encodeMigrationFrame,
  parseMigrationCoreFrame,
  type CopilotHandoffCorrelation,
  type MigrationWireFrame,
  type CopilotAuthorityRecord,
} from '@canopy/core-runtime/node/vault';
import {
  CopilotHostSelectionSchema,
  type CopilotHostSelection,
} from '@canopy/protocol/copilot-selection';
import { observeCopilotSelectionAuthority } from '../lib/preferences-store';
import { beginCopilotMigrationBarrier } from './grant-authority';
import type { CopilotMigrationSource } from './credential-store';
import type { CopilotSetupLineage } from './setup-lineage';
import {
  createCopilotSelectionReceipt,
  readCopilotSelectionPreferences,
} from './selection-receipt';
import {
  createDirectoryDurably,
  writeFileAtomically,
} from '../lib/atomic-file';

/** Main-owned redacted control, never credential authority. Explicit isolated root only. */
export interface CopilotHandoffFile {
  read(): Promise<CopilotHandoffControl | null>;
  write(record: CopilotHandoffControl): Promise<void>;
}
export function createCopilotHandoffFile(dataRoot: string): CopilotHandoffFile {
  const folder = join(dataRoot, 'copilot-qualification');
  const path = join(folder, 'handoff-control.v1.json');
  const { secureFiles } = hostPlatformServices(
    createPlatformEndpointServices(hostPlatformOperatingSystem()),
  );
  async function requirePrivate(
    path: string,
    kind: 'file' | 'directory',
    action: 'verify' | 'restrict' = 'verify',
  ): Promise<void> {
    const permission = await secureFiles.permissions({
      path,
      kind,
      mode: 'owner-only',
      action,
    });
    if (permission.state !== 'private')
      throw new Error('Handoff permissions unavailable.');
  }
  return {
    async read(): Promise<CopilotHandoffControl | null> {
      try {
        const directory = await lstat(folder);
        if (!directory.isDirectory() || directory.isSymbolicLink())
          throw new Error('Invalid handoff directory.');
        await requirePrivate(folder, 'directory');
        const stat = await lstat(path);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16_384)
          throw new Error('Invalid handoff control.');
        await requirePrivate(path, 'file');
        return CopilotHandoffControlSchema.parse(
          JSON.parse(await readFile(path, 'utf8')),
        );
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return null;
        throw new Error('Handoff control unavailable.');
      }
    },
    async write(record: CopilotHandoffControl): Promise<void> {
      const checked = CopilotHandoffControlSchema.parse(record);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const directory = await lstat(folder);
      if (!directory.isDirectory() || directory.isSymbolicLink())
        throw new Error('Handoff directory unavailable.');
      await requirePrivate(folder, 'directory', 'restrict');
      await createDirectoryDurably(folder, { dataRoot });
      await writeFileAtomically(path, JSON.stringify(checked), {
        durable: true,
        mode: 0o600,
      });
    },
  };
}

/** Deliberately uncalled by connection.ts/startup. Owns the real source queue and preferences owner. */
export interface CopilotQualificationHandoff {
  phase(): Promise<CopilotHandoffPhase>;
  custody(): Promise<'unused' | 'pending' | 'selected'>;
  ordinarySetup(): Promise<boolean>;
  connect(cancel?: boolean): Promise<readonly MigrationWireFrame[]>;
  verify(): Promise<readonly MigrationWireFrame[]>;
  cleanup(): Promise<readonly MigrationWireFrame[]>;
  close(): Promise<void>;
}
export function createCopilotQualificationHandoff(options: {
  dataRoot: string;
  source: { flavorId: string; secureMode: string };
  exchange(
    frame: MigrationWireFrame,
    metadata: { deadlineMs: number; signal: AbortSignal },
  ): Promise<{ frames: readonly MigrationWireFrame[] }>;
  /** Synthetic fixtures may inject repositories; ordinary production never constructs the host. */
  selection?: ReturnType<typeof createCopilotSelectionReceipt>;
  readSelection?: typeof readCopilotSelectionPreferences;
  setupLineage: CopilotSetupLineage;
  proveUnused?(): Promise<boolean>;
  corePhase?(): Promise<CopilotHandoffPhase>;
  retiredBinding?(): Promise<CopilotHandoffCorrelation['binding']>;
  ordinaryAuthority?(): Promise<CopilotAuthorityRecord | null>;
  /** Retire the trusted channel and recipient admission synchronously on host-authority loss. */
  retireChannel(): void;
  /** Close recipient/submission admission synchronously without destroying cancellation transport. */
  cancelAdmission(): void;
}): CopilotQualificationHandoff {
  let barrier = beginCopilotMigrationBarrier(); // closes legacy admission before the first await
  const file = createCopilotHandoffFile(options.dataRoot);
  const lineage = options.setupLineage;
  const selection =
    options.selection ?? createCopilotSelectionReceipt(undefined, lineage);
  const readSelection =
    options.readSelection ?? readCopilotSelectionPreferences;
  const stopped = new AbortController();
  let legacyReleased = false;
  let record: CopilotHandoffControl | null | undefined;
  let source: CopilotMigrationSource | undefined;
  let freezeId: string | undefined;
  let finishHold: (() => void) | undefined;
  let hold: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: number | undefined;
  let incarnation: string | undefined;
  let runId: string | undefined;
  let requestId = 0;
  let commandId = 0;
  let expectedOperation: CopilotHandoffCorrelation['operation'] = 'begin';
  let busy = false;
  let closed = false;
  let confirmedImportSelection: CopilotHostSelection | undefined;
  let observedSelection: CopilotHostSelection | null | undefined;
  const unobserve = observeCopilotSelectionAuthority((change) => {
    if (change.kind === 'unavailable') {
      interrupt();
      return;
    }
    const nextSelection =
      CopilotHostSelectionSchema.safeParse(change.selection).data ?? null;
    observedSelection = nextSelection;
    if (lineage.active()) {
      if (!lineage.observe(nextSelection)) interrupt();
    } else if (
      confirmedImportSelection &&
      JSON.stringify(nextSelection) !== JSON.stringify(confirmedImportSelection)
    )
      interrupt();
  });
  async function load(): Promise<CopilotHandoffControl | null> {
    const observed = await file.read();
    if (record && JSON.stringify(record) !== JSON.stringify(observed))
      throw new Error('Handoff control changed.');
    record = observed;
    if (
      record &&
      (record.source.flavorId !== options.source.flavorId ||
        record.source.secureMode !== options.source.secureMode)
    )
      throw new Error('Handoff source disagrees.');
    return record;
  }
  let saveTail = Promise.resolve();
  function save(patch: Partial<CopilotHandoffControl>): Promise<void> {
    const work = saveTail.then(() => saveNow(patch));
    saveTail = work.catch(() => undefined);
    return work;
  }
  async function saveNow(patch: Partial<CopilotHandoffControl>): Promise<void> {
    const before = await load();
    if (
      before &&
      ['cancelling', 'retired'].includes(before.disposition) &&
      patch.disposition &&
      patch.disposition !== before.disposition &&
      !(before.disposition === 'cancelling' && patch.disposition === 'retired')
    )
      throw new Error('Cancellation fence cannot be reopened.');
    const next: CopilotHandoffControl = {
      version: 1,
      generation: 0,
      source: options.source,
      slot: 'copilot-account',
      handoffId: randomUUID(),
      ciphertextGeneration: null,
      binding: null,
      predecessorGeneration: null,
      disposition: 'preparing',
      ...before,
      ...patch,
    };
    next.generation = (before?.generation ?? -1) + 1;
    await file.write(next);
    record = next;
  }
  function interrupt(): void {
    if (closed) return;
    closed = true;
    lineage.interrupt();
    confirmedImportSelection = undefined;
    unobserve();
    try {
      options.retireChannel();
    } finally {
      stopped.abort();
      clearTimeout(timer);
      finishHold?.();
      source = undefined;
      freezeId = undefined;
    }
  }
  async function release(): Promise<void> {
    finishHold?.();
    finishHold = undefined;
    source = undefined;
    freezeId = undefined;
    const settled = hold;
    hold = undefined;
    await settled?.catch(() => undefined);
  }
  async function freeze(cleanup = false): Promise<string> {
    if (source || hold || closed) throw new Error('Freeze unavailable.');
    if (legacyReleased) {
      barrier = beginCopilotMigrationBarrier();
      legacyReleased = false;
    }
    deadline ??= Date.now() + COPILOT_HANDOFF_BOUND_MS;
    timer ??= setTimeout(interrupt, Math.max(0, deadline - Date.now()));
    const proof = await barrier.quiesce(stopped.signal);
    if (proof.kind !== 'quiescent')
      throw new Error('Legacy successor is not settled.');
    let entered: (() => void) | undefined;
    let failed: ((error: unknown) => void) | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      entered = resolve;
      failed = reject;
    });
    const untilRelease = new Promise<void>((resolve) => {
      finishHold = resolve;
    });
    let captured:
      | Awaited<ReturnType<CopilotMigrationSource['capture']>>
      | undefined;
    hold = proof.proof.withSource(async (context) => {
      // The fence intentionally precedes capture and all core preparation.
      const existing = await load();
      if (closed) throw new Error('Freeze lost.');
      const preferences = await readSelection();
      if (closed) throw new Error('Freeze lost.');
      const previous =
        preferences.copilotVaultSelection === undefined
          ? null
          : CopilotHostSelectionSchema.parse(preferences.copilotVaultSelection);
      if (!existing)
        await save({ predecessorGeneration: previous?.pinGeneration ?? null });
      source = context;
      if (cleanup) {
        freezeId = randomUUID();
        entered?.();
        await untilRelease;
        return;
      }
      captured = await context.capture();
      if (closed) throw new Error('Freeze lost.');
      if (captured.kind !== 'present')
        throw new Error('Source capture unavailable.');
      if (
        existing?.ciphertextGeneration &&
        existing.ciphertextGeneration !== captured.generation
      )
        throw new Error('Frozen source changed.');
      await save({
        ciphertextGeneration: captured.generation,
        disposition:
          existing?.disposition === 'cancelling' ||
          existing?.disposition === 'retired'
            ? existing.disposition
            : 'pending',
      });
      if (closed) throw new Error('Freeze lost.');
      freezeId = randomUUID();
      entered?.();
      await untilRelease;
    });
    void hold.catch((error) => {
      failed?.(error);
      interrupt();
    });
    const cancelled = (): void => failed?.(new Error('Freeze interrupted.'));
    stopped.signal.addEventListener('abort', cancelled, { once: true });
    try {
      if (stopped.signal.aborted) cancelled();
      await ready;
    } finally {
      stopped.signal.removeEventListener('abort', cancelled);
    }
    if (cleanup && !closed && freezeId) return JSON.stringify({ freezeId });
    if (!captured || captured.kind !== 'present' || closed)
      throw new Error('Source hold lost.');
    return JSON.stringify({
      freezeId,
      generation: captured.generation,
      account: {
        host: captured.grant.host,
        login: captured.grant.login,
        id: captured.grant.id,
      },
      predecessorGeneration: record?.predecessorGeneration ?? null,
    });
  }
  function validate(c: CopilotHandoffCorrelation): void {
    if (c.operation !== expectedOperation)
      throw new Error('Cross-operation host action.');
    if (
      c.sourceFlavor !== options.source.flavorId ||
      c.sourceMode !== options.source.secureMode ||
      c.requestId !== requestId + 1 ||
      (incarnation && incarnation !== c.incarnation) ||
      (runId && runId !== c.runId)
    )
      throw new Error('Handoff correlation refused.');
    incarnation = c.incarnation;
    runId = c.runId;
    requestId = c.requestId;
    if (c.freezeId !== (freezeId ?? null))
      throw new Error('Stale freeze reply.');
    if (
      record?.binding &&
      JSON.stringify(record.binding) !== JSON.stringify(c.binding)
    )
      throw new Error('Handoff binding disagrees.');
  }
  async function perform(
    payload: string,
    c: CopilotHandoffCorrelation,
  ): Promise<string> {
    const action = CopilotHandoffActionSchema.parse(JSON.parse(payload));
    if (action.kind === 'freeze') {
      if (action.retirement) {
        const before = await load();
        if (before?.disposition === 'selected') {
          const selected = CopilotHostSelectionSchema.parse(
            (await readSelection()).copilotVaultSelection,
          );
          if (
            selected.state !== 'disabled' ||
            selected.identity.operationId !== before.binding?.operationId ||
            selected.identity.epoch !== before.binding.accountEpoch
          )
            throw new Error('Published retirement receipt unavailable.');
          await save({ disposition: 'cancelling' });
        }
        if (!record || !['cancelling', 'retired'].includes(record.disposition))
          throw new Error('Retirement fence missing.');
        return 'true';
      }
      return freeze();
    }
    if (action.kind === 'freeze-cleanup') return freeze(true);
    if (!record || closed) throw new Error('Handoff control unavailable.');
    if (
      !['checkpoint', 'abandon', 'read', 'release', 'cleanup'].includes(
        action.kind,
      ) &&
      // Exact committed recovery confirms the bound receipt without recapturing legacy.
      !(
        action.kind === 'confirm' &&
        (record.disposition === 'selected' ||
          (expectedOperation === 'resume' && !source))
      )
    ) {
      if (!source) throw new Error('Source hold unavailable.');
      if ((await source.compare(record.ciphertextGeneration ?? '')) !== 'same')
        throw new Error('Source changed.');
    }
    switch (action.kind) {
      case 'cleanup':
        if (
          !source ||
          !['selected', 'cancelling'].includes(record.disposition) ||
          record.ciphertextGeneration !== action.generation
        )
          throw new Error('Cleanup hold unavailable.');
        return JSON.stringify(
          await source.cleanup(
            options.dataRoot,
            action.operationId,
            action.generation,
            action.step,
          ),
        );
      case 'checkpoint':
        if (
          JSON.stringify(action.binding) !== JSON.stringify(c.binding) ||
          (record.binding &&
            JSON.stringify(record.binding) !== JSON.stringify(action.binding))
        )
          throw new Error('Checkpoint disagrees.');
        await save({ binding: action.binding });
        return 'true';
      case 'prepare':
        if (
          action.identity.origin !== 'import' ||
          action.identity.operationId !== record.binding?.operationId ||
          action.identity.epoch !== record.binding.accountEpoch ||
          action.predecessorGeneration !== record.predecessorGeneration
        )
          throw new Error('Selection preparation disagrees.');
        return JSON.stringify(
          await selection.prepare(
            action.identity,
            action.predecessorGeneration,
          ),
        );
      case 'confirm':
        if (
          action.generation !== record.ciphertextGeneration ||
          action.predecessorGeneration !== record.predecessorGeneration ||
          action.request.origin !== 'import' ||
          action.request.operationId !== record.binding?.operationId ||
          action.request.epoch !== record.binding.accountEpoch
        )
          throw new Error('Selection confirmation disagrees.');
        {
          const result = await selection.confirm(action.request);
          if (closed) throw new Error('Host authority lost.');
          if (result.kind === 'confirmed') {
            const { pinGeneration, pin, ...identity } = result.receipt;
            const expected = CopilotHostSelectionSchema.parse({
              version: 1,
              identity,
              pin,
              pinGeneration,
              state: 'selected',
            });
            if (
              observedSelection !== undefined &&
              JSON.stringify(observedSelection) !== JSON.stringify(expected)
            )
              throw new Error('Host receipt changed during confirmation.');
            confirmedImportSelection = expected;
          }
          return JSON.stringify(result);
        }
      case 'abandon':
        if (
          action.identity.operationId !== record.binding?.operationId ||
          action.identity.epoch !== record.binding.accountEpoch
        )
          throw new Error('Selection retirement disagrees.');
        {
          const saved = (await readSelection()).copilotVaultSelection;
          const previous =
            saved === undefined
              ? undefined
              : CopilotHostSelectionSchema.parse(saved);
          // A committed destination required host preparation. Absence cannot
          // prove retirement; a published import also requires its selected pin.
          if (
            (!previous && (action.destination || action.published)) ||
            (action.published && !previous?.pin) ||
            (previous &&
              (JSON.stringify(previous.identity) !==
                JSON.stringify(action.identity) ||
                (previous.pin &&
                  (!action.destination ||
                    JSON.stringify(previous.pin.ref) !==
                      JSON.stringify(action.destination.ref) ||
                    previous.pin.revision > action.destination.revision))))
          )
            throw new Error('Host retirement receipt unavailable.');
          if (previous?.state === 'selected') {
            if (!previous.pin) throw new Error('Selected pin unavailable.');
            const disabled = await selection.disable({
              operationId: action.identity.operationId,
              head: {
                ...previous.identity,
                pin: previous.pin,
                pinGeneration: previous.pinGeneration,
              },
            });
            if (disabled.kind !== 'disabled')
              throw new Error('Selected retirement unconfirmed.');
          } else await selection.abandon(action.identity);
          const preferences = await readSelection();
          const after = preferences.copilotVaultSelection;
          if (
            (previous && preferences.copilotEnabled !== false) ||
            (previous
              ? !after ||
                after.pinGeneration !== previous.pinGeneration ||
                JSON.stringify(after.pin) !== JSON.stringify(previous.pin) ||
                JSON.stringify(after.identity) !==
                  JSON.stringify(action.identity) ||
                after.state !== 'disabled'
              : after !== undefined)
          )
            throw new Error('Host retirement unconfirmed.');
          return 'true';
        }
      case 'read':
        return JSON.stringify(
          (await readSelection()).copilotVaultSelection ?? null,
        );
      case 'release':
        await save({ disposition: action.disposition });
        await release();
        clearTimeout(timer);
        timer = undefined;
        deadline = undefined;
        return 'true';
    }
  }
  async function exchange(
    frame: MigrationWireFrame,
  ): Promise<{ frames: readonly MigrationWireFrame[] }> {
    if (closed || stopped.signal.aborted)
      throw new Error('Handoff unavailable.');
    const deadlineMs = deadline ?? Date.now() + COPILOT_HANDOFF_BOUND_MS;
    return options.exchange(frame, { deadlineMs, signal: stopped.signal });
  }
  async function pump(
    frame: MigrationWireFrame,
  ): Promise<readonly MigrationWireFrame[]> {
    expectedOperation =
      frame.protocol === COPILOT_HANDOFF_PROTOCOL
        ? parseCopilotHandoffFrame(frame).correlation.operation
        : 'import';
    let result = await exchange(frame);
    for (;;) {
      if (
        result.frames.length !== 1 ||
        result.frames[0]?.protocol !== COPILOT_HANDOFF_PROTOCOL
      )
        return result.frames;
      const incoming = parseCopilotHandoffFrame(result.frames[0]);
      validate(incoming.correlation);
      if (incoming.type === 'terminal') return result.frames;
      if (incoming.type !== 'action')
        throw new Error('Unexpected host action.');
      const payload = await perform(incoming.payload, incoming.correlation);
      result = await exchange(
        encodeCopilotHandoffFrame({ ...incoming, type: 'reply', payload }),
      );
    }
  }
  async function connect(
    cancel = false,
    qualification?: 'verify' | 'cleanup',
  ): Promise<readonly MigrationWireFrame[]> {
    if (closed) throw new Error('Handoff busy.');
    if (cancel) options.cancelAdmission();
    if (busy) {
      if (cancel) {
        try {
          await save({ disposition: 'cancelling' });
        } finally {
          interrupt();
        }
      }
      throw new Error(
        'Handoff busy; reconstruct the admitted channel to retire cancellation.',
      );
    }
    busy = true;
    try {
      const before = await load();
      cancel ||=
        before?.disposition === 'cancelling' ||
        before?.disposition === 'retired';
      if (cancel) options.cancelAdmission();
      confirmedImportSelection = undefined;
      if (
        cancel &&
        before &&
        !['selected', 'retired'].includes(before.disposition)
      )
        await save({ disposition: 'cancelling' });
      const hello = await exchange(encodeMigrationFrame({ type: 'hello' }));
      const offers = hello.frames.map(parseMigrationCoreFrame);
      const offer = offers.find(
        (item) => item.ok && item.frame.type === 'offer',
      );
      const f =
        offer?.ok && offer.frame.type === 'offer' ? offer.frame : undefined;
      if (!f && !before?.binding && !(cancel && before))
        throw new Error('No admitted import offer.');
      const correlation: CopilotHandoffCorrelation = {
        incarnation: 'command',
        runId: before?.handoffId ?? 'new',
        requestId: ++commandId,
        operation: cancel
          ? 'cancel'
          : (qualification ?? (before ? 'resume' : 'begin')),
        sourceFlavor: options.source.flavorId,
        sourceMode: options.source.secureMode,
        slot: 'copilot-account',
        binding: before?.binding ?? null,
        freezeId: null,
      };
      const ready = await pump(
        encodeCopilotHandoffFrame({
          protocol: COPILOT_HANDOFF_PROTOCOL,
          version: 1,
          type: 'command',
          correlation,
          payload: JSON.stringify({
            kind: cancel
              ? 'cancel'
              : (qualification ?? (before ? 'resume' : 'begin')),
            sessionId: f?.sessionId ?? '',
            challenge: f?.challenge ?? '',
            operation: f?.operation ?? '',
            purpose: f?.purpose ?? '',
          }),
        }),
      );
      if (qualification) return ready;
      const terminal =
        ready[0]?.protocol === COPILOT_HANDOFF_PROTOCOL
          ? parseCopilotHandoffFrame(ready[0])
          : undefined;
      if (terminal?.payload === 'published' || terminal?.payload === 'retired')
        return ready;
      if (!source || !record || !f)
        throw new Error('Ingress source unavailable.');
      const captured = await source.capture();
      if (
        captured.kind !== 'present' ||
        captured.generation !== record.ciphertextGeneration
      )
        throw new Error('Ingress source changed.');
      const value = Buffer.from(JSON.stringify(captured.grant));
      try {
        const result = await pump(
          encodeMigrationFrame({
            type: 'import',
            sessionId: f.sessionId,
            challenge: f.challenge,
            operation: f.operation,
            purpose: f.purpose,
            value,
          }),
        );
        const completed = parseMigrationCoreFrame(result[0]);
        if (
          !completed.ok ||
          completed.frame.type !== 'result' ||
          completed.frame.outcome !== 'imported'
        )
          throw new Error('Import outcome unconfirmed.');
        return result;
      } finally {
        value.fill(0);
      }
    } catch (error) {
      interrupt();
      throw error;
    } finally {
      busy = false;
    }
  }
  return {
    async ordinarySetup(): Promise<boolean> {
      if (closed) return false;
      const fence = await load();
      const retired = await options.retiredBinding?.();
      if (
        closed ||
        !retired ||
        fence?.disposition !== 'retired' ||
        JSON.stringify(fence.binding) !== JSON.stringify(retired)
      )
        return false;
      const revision = lineage.revision();
      const preferences = await readSelection();
      const authority = await options.ordinaryAuthority?.();
      const selected = CopilotHostSelectionSchema.safeParse(
        preferences.copilotVaultSelection,
      ).data;
      if (closed) return false;
      if (!selected || !authority) {
        interrupt();
        return false;
      }
      if (
        lineage.stale(selected, authority) ||
        (revision !== lineage.revision() &&
          JSON.stringify(selected) !== JSON.stringify(lineage.current()))
      )
        return false;
      // Revalidate both owners after the preference read; neither is a legacy-unused claim.
      const currentRetired = await options.retiredBinding?.();
      const currentAuthority = await options.ordinaryAuthority?.();
      const currentFence = await load();
      if (
        closed ||
        JSON.stringify(currentRetired) !== JSON.stringify(retired) ||
        JSON.stringify(currentAuthority) !== JSON.stringify(authority) ||
        JSON.stringify(currentFence) !== JSON.stringify(fence)
      )
        return false;
      if (
        lineage.stale(selected, authority) ||
        (revision !== lineage.revision() &&
          JSON.stringify(selected) !== JSON.stringify(lineage.current()))
      )
        return false;
      if (
        !lineage.admit(selected, preferences.copilotEnabled, authority, {
          operationId: retired.operationId,
          epoch: retired.accountEpoch,
        })
      ) {
        interrupt();
        return false;
      }
      confirmedImportSelection = undefined;
      return true;
    },
    async phase(): Promise<CopilotHandoffPhase> {
      const fence = await load();
      if (
        fence?.disposition === 'cancelling' ||
        fence?.disposition === 'retired'
      )
        return 'cancelling_retired';
      const core = CopilotHandoffPhaseSchema.parse(await options.corePhase?.());
      return core === 'invalid_unbound' && fence && !fence.binding
        ? 'fenced_before_selection'
        : core;
    },
    async custody(): Promise<'unused' | 'pending' | 'selected'> {
      try {
        if (closed) throw new Error('Handoff control unavailable.');
        const fence = await load();
        const preferences = await readSelection();
        if (
          !fence &&
          preferences.copilotVaultSelection === undefined &&
          (await options.proveUnused?.())
        ) {
          if (!legacyReleased) {
            barrier.release();
            legacyReleased = true;
          }
          return 'unused';
        }
        const selected = CopilotHostSelectionSchema.safeParse(
          preferences.copilotVaultSelection,
        ).data;
        if (
          (lineage.current() ?? confirmedImportSelection) &&
          JSON.stringify(selected) !==
            JSON.stringify(lineage.current() ?? confirmedImportSelection)
        )
          throw new Error('Host receipt changed.');
        if (
          fence?.disposition === 'selected' &&
          selected?.state === 'selected' &&
          selected.identity.operationId === fence.binding?.operationId &&
          selected.identity.epoch === fence.binding.accountEpoch
        )
          return 'selected';
        return 'pending';
      } catch (error) {
        interrupt();
        throw error;
      }
    },
    /** Connect never falls through to device flow on a fence or a lost response. */
    connect,
    verify: () => connect(false, 'verify'),
    cleanup: () => connect(false, 'cleanup'),
    async close(): Promise<void> {
      interrupt();
      await release();
      if (!legacyReleased) barrier.detach();
    },
  };
}
