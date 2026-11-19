import { randomUUID } from 'node:crypto';
import {
  CopilotHostSelectionSchema,
  type CopilotHostSelection,
} from '@canopy/protocol/copilot-selection';
import type {
  VaultFamilyWriter,
  VaultMutationFailure,
  VaultSecretPin,
} from '../../vault/contracts';
import {
  CopilotAuthorityRecordSchema,
  CopilotAuthorityJournalError,
  CopilotVaultGrantSchema,
  type CopilotAuthorityRecord,
  type CopilotGrantAuthorityOptions,
  type CopilotGrantFailure,
  type CopilotGrantHead,
  type CopilotGrantMutation,
  type CopilotGrantResult,
  type CopilotSelectionReceipt,
  type CopilotSetupLineageWitness,
  type CopilotVaultAccount,
  type CopilotVaultGrant,
  type CopilotVaultGrantAuthority,
} from './copilot-grant-contracts';

const blocked = (
  reason: CopilotGrantFailure['reason'],
): CopilotGrantFailure => ({ kind: 'blocked', reason });
function samePin(a: VaultSecretPin, b: VaultSecretPin): boolean {
  return (
    a.ref.vaultId === b.ref.vaultId &&
    a.ref.entryId === b.ref.entryId &&
    a.revision === b.revision
  );
}
function account(grant: CopilotVaultAccount): CopilotVaultAccount {
  return { host: grant.host, login: grant.login, id: grant.id };
}
function sameAccount(a: CopilotVaultAccount, b: CopilotVaultAccount): boolean {
  return a.host === b.host && a.id === b.id && a.login === b.login;
}
/**
 * The exact disabled receipt of the retired head, committed in the same CAS as
 * the completed delete. Without one (no lineage composition) the witness stays
 * unset and post-restart setup reconstruction refuses.
 */
function retiredLineage(
  head: CopilotGrantHead,
  receipt: CopilotHostSelection | undefined,
  completed: { readonly operationId: string; readonly epoch: string },
): CopilotSetupLineageWitness | undefined {
  const parsed = CopilotHostSelectionSchema.safeParse(receipt);
  if (!parsed.success) return undefined;
  const { identity, pin, pinGeneration, state } = parsed.data;
  return state === 'disabled' &&
    pin !== null &&
    pinGeneration === head.pinGeneration &&
    identity.operationId === head.operationId &&
    identity.epoch === head.epoch &&
    identity.origin === head.origin &&
    sameAccount(identity.account, head.account) &&
    pin.ref.vaultId === head.pin.ref.vaultId &&
    pin.ref.entryId === head.pin.ref.entryId &&
    pin.revision <= head.pin.revision &&
    completed.epoch === head.epoch &&
    completed.operationId !== head.operationId &&
    !completed.operationId.endsWith(':cancel')
    ? {
        version: 1,
        predecessor: parsed.data,
        successor: {
          operationId: completed.operationId,
          epoch: completed.epoch,
        },
        phase: 'retired',
      }
    : undefined;
}
/**
 * The cancelled successor's own disabled receipt, committed with its
 * cancellation. Undefined keeps the witness predecessor: the receipt that
 * survives when the successor was never prepared.
 */
function cancelledLineage(
  witness: CopilotSetupLineageWitness | null | undefined,
  cancelled: Pick<
    CopilotGrantMutation,
    'operationId' | 'epoch' | 'account' | 'origin'
  >,
  committed: VaultSecretPin | null,
  receipt: CopilotHostSelection | undefined,
): CopilotSetupLineageWitness | undefined {
  const parsed = CopilotHostSelectionSchema.safeParse(receipt);
  if (!witness || !parsed.success) return undefined;
  const { identity, pin, state } = parsed.data;
  return state === 'disabled' &&
    cancelled.origin === 'setup' &&
    identity.origin === 'setup' &&
    witness.successor.operationId === cancelled.operationId &&
    witness.successor.epoch === cancelled.epoch &&
    identity.operationId === cancelled.operationId &&
    identity.epoch === cancelled.epoch &&
    sameAccount(identity.account, cancelled.account) &&
    (pin === null || (committed !== null && samePin(pin, committed)))
    ? { ...witness, predecessor: parsed.data, phase: 'cancelled' }
    : undefined;
}
function mutationFailure(result: VaultMutationFailure): CopilotGrantFailure {
  switch (result.kind) {
    case 'not_found':
      return blocked('absent');
    case 'revision_conflict':
    case 'superseded':
      return blocked('changed');
    case 'refused':
      return blocked(
        result.reason === 'managed_family' ? 'denied' : 'unconfirmed',
      );
    default:
      return blocked('unconfirmed');
  }
}

type RefreshPhase =
  | 'preparing'
  | 'presenting'
  | 'success'
  | 'rejected'
  | 'no-result'
  | 'recovering-orphan'
  | 'recovered-local-mutation'
  | 'confirmed'
  | 'superseded';
type RefreshOutcome =
  | { kind: 'success'; grant: CopilotVaultGrant }
  | { kind: 'no-result'; failure: CopilotGrantFailure }
  | { kind: 'rejected' };
type RefreshEvent =
  | { kind: 'presenting' }
  | { kind: 'success'; grant: CopilotVaultGrant }
  | { kind: 'rejected' }
  | { kind: 'no-result'; failure: CopilotGrantFailure }
  | { kind: 'confirmed' }
  | { kind: 'recover-local'; mutation: CopilotGrantMutation }
  | { kind: 'superseded' };
interface RefreshEffect {
  id: string;
  kind: 'journal' | 'put' | 'delete';
  sequence: number;
  submitted: boolean;
  outcome: 'pending' | 'definite' | 'unknown' | 'superseded';
}
interface RefreshAttempt {
  head: CopilotGrantHead;
  mutation: CopilotGrantMutation;
  phase: RefreshPhase;
  generation: number;
  predecessor?: CopilotVaultGrant;
  candidate?: CopilotVaultGrant;
  outcome: Promise<RefreshOutcome>;
  publish(outcome: RefreshOutcome): void;
  result?: RefreshOutcome;
  chain?: Promise<CopilotGrantResult>;
  progress?: Promise<CopilotGrantResult>;
  effects: RefreshEffect[];
  submissionOpen: boolean;
  retired: boolean;
  cutoff: number;
}
type AdmissionClosure =
  | 'runtime'
  | `removing:${string}`
  | `signed-out:${string}`;
interface DemandTicket {
  id: number;
  epoch: string;
  generation: number;
  attempt?: RefreshAttempt;
}

interface FamilyLifetime {
  closed: boolean;
  drains: Set<() => Promise<void>>;
  terminal: Set<() => void>;
  setups: Map<
    string,
    {
      epoch: string;
      grant: CopilotVaultGrant;
      cancellation: AbortController;
      signal: AbortSignal;
    }
  >;
  setupSaving: Map<string, Promise<CopilotGrantResult>>;
  cancelling: Set<string>;
  quiescence?: Promise<void>;
}
interface ProcessLifetime {
  families: Map<string, FamilyLifetime>;
  owners: WeakMap<object, FamilyLifetime>;
  recoveries: WeakMap<object, Promise<void>>;
}
const processFamilies = new WeakMap<object, ProcessLifetime>();
// Store/journal reconstruction in this process cannot terminate a provider or submission.
const processLifetime = {};
const defaultReceiptOwner = {};
type LifetimeOptions = Pick<
  CopilotGrantAuthorityOptions,
  'journal' | 'familyLifetime' | 'processLifetime'
>;
function resolveLifetime(options: LifetimeOptions): {
  process: ProcessLifetime;
  family: FamilyLifetime;
} {
  const boot = options.processLifetime ?? processLifetime;
  let process = processFamilies.get(boot);
  if (!process) {
    process = {
      families: new Map(),
      owners: new WeakMap(),
      recoveries: new WeakMap(),
    };
    processFamilies.set(boot, process);
  }
  const owner = options.familyLifetime ?? options.journal;
  const familyId = options.familyLifetime
    ? undefined
    : options.journal.lifetime?.familyId;
  let family = familyId
    ? process.families.get(familyId)
    : process.owners.get(owner);
  if (!family) {
    family = {
      closed: false,
      drains: new Set(),
      terminal: new Set(),
      setups: new Map(),
      setupSaving: new Map(),
      cancelling: new Set(),
    };
    if (familyId) process.families.set(familyId, family);
    else process.owners.set(owner, family);
  }
  return { process, family };
}

/** Trusted process/family capability, shared with P4; never a recipient-generation test. */
export function copilotGrantLifetime(options: LifetimeOptions): {
  closed(): boolean;
  onQuiesce(listener: () => void): () => void;
  setupSignal(identity: {
    operationId: string;
    epoch: string;
  }): AbortSignal | undefined;
  recoverReceipts(
    owner: object | undefined,
    recover: (() => Promise<void>) | undefined,
  ): Promise<void>;
} {
  const { process, family } = resolveLifetime(options);
  return {
    closed: () => family.closed,
    onQuiesce(listener) {
      if (family.closed) listener();
      else family.terminal.add(listener);
      return () => {
        family.terminal.delete(listener);
      };
    },
    setupSignal(identity) {
      const setup = family.setups.get(identity.operationId);
      return setup?.epoch === identity.epoch ? setup.signal : undefined;
    },
    recoverReceipts(owner, recover) {
      if (family.closed)
        return Promise.reject(new Error('Copilot runtime is unavailable.'));
      // A missing port cannot consume another composition's real recovery obligation.
      if (!recover) return Promise.resolve();
      const namespace = owner ?? defaultReceiptOwner;
      const existing = process.recoveries.get(namespace);
      if (existing) return existing;
      const attempt = Promise.resolve()
        .then(recover)
        .catch((error: unknown) => {
          if (process.recoveries.get(namespace) === attempt)
            process.recoveries.delete(namespace);
          throw error;
        });
      process.recoveries.set(namespace, attempt);
      return attempt;
    },
  };
}
const processRefreshes = new WeakMap<
  object,
  Map<string, { attempt: RefreshAttempt; settled: boolean }>
>();
function refreshKey(m: CopilotGrantMutation): string {
  return JSON.stringify([m.from?.ref.vaultId, m.epoch, m.operationId]);
}

/**
 * Unselected P4 foundation. No production composition instantiates it.
 * Journal/selection/recipient ports are trusted internal capabilities, not wire APIs.
 */
export function createCopilotVaultGrantAuthority(
  options: CopilotGrantAuthorityOptions,
): CopilotVaultGrantAuthority {
  const now = options.now ?? Date.now;
  const boot = options.processLifetime ?? processLifetime;
  let registry = processRefreshes.get(boot);
  if (!registry) {
    registry = new Map();
    processRefreshes.set(boot, registry);
  }
  const ownedRefreshes = registry;
  const { family } = resolveLifetime(options);
  let writer: Promise<VaultFamilyWriter> | undefined;
  const admissionClosures = new Set<AdmissionClosure>();
  const setupClosures = new Map<
    string,
    { epoch: string; reason: AdmissionClosure | undefined }
  >();
  let generation = 0;
  const attempts = new Map<string, RefreshAttempt>();
  const removals = new Map<string, Promise<CopilotGrantResult>>();
  const demands = new Set<DemandTicket>();
  const closedSubmissions = new Set<string>();
  let requestSequence = 0;
  const setupSaving = family.setupSaving;
  const cancelling = family.cancelling;
  const setupCustody = family.setups;
  family.drains.add(async () => {
    await Promise.allSettled(
      [...attempts.values()].map(async (attempt) => {
        await attempt.chain;
        // The provider response can create persistence while the chain is draining.
        await attempt.progress;
      }),
    );
  });

  function quiesce(): Promise<void> {
    if (family.quiescence) return family.quiescence;
    family.closed = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    family.quiescence = Promise.race([
      Promise.allSettled([...family.drains].map((drain) => drain())).then(
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 2_000);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    for (const setup of setupCustody.values()) setup.cancellation.abort();
    for (const listener of family.terminal) {
      try {
        listener();
      } catch {
        /* One host cannot prevent sibling cancellation. */
      }
    }
    family.terminal.clear();
    closeAdmission('runtime');
    return family.quiescence;
  }

  function retireEpoch(epoch: string): void {
    const attempt = attempts.get(epoch);
    if (attempt) {
      transition(attempt, { kind: 'superseded' });
      attempts.delete(epoch);
    }
    for (const [id, successor] of setupCustody)
      if (successor.epoch === epoch) setupCustody.delete(id);
  }
  function attemptFor(m: CopilotGrantMutation): RefreshAttempt | undefined {
    const attempt = attempts.get(m.epoch);
    return attempt?.mutation.operationId === m.operationId
      ? attempt
      : undefined;
  }
  function foreignWork(m: CopilotGrantMutation): boolean {
    const owned = ownedRefreshes.get(refreshKey(m));
    return (
      !!owned &&
      owned.attempt !== attemptFor(m) &&
      (!owned.settled ||
        !!owned.attempt.progress ||
        (m.kind === 'refresh' && !!owned.attempt.candidate))
    );
  }
  function terminatedRefresh(m: CopilotGrantMutation): boolean {
    const owned = ownedRefreshes.get(refreshKey(m));
    return (
      options.journal.lifetime?.isExclusive() === true &&
      (!owned ||
        (owned.settled && !owned.attempt.progress && !owned.attempt.candidate))
    );
  }
  function currentAttempt(attempt: RefreshAttempt): boolean {
    return (
      attempts.get(attempt.head.epoch) === attempt &&
      attempt.submissionOpen &&
      attempt.phase !== 'superseded'
    );
  }
  function ownsSubmission(m: CopilotGrantMutation): boolean {
    const attempt = attemptFor(m);
    return (
      !closedSubmissions.has(m.epoch) &&
      (!attempt ||
        (attempt.submissionOpen && attempt.phase !== 'superseded')) &&
      !cancelling.has(m.operationId)
    );
  }
  function setupFenced(m: CopilotGrantMutation): boolean {
    // Owned refresh successors may settle after quit; new setup publication may not.
    return (
      m.kind === 'create' &&
      (family.closed ||
        cancelling.has(m.operationId) ||
        setupCustody.get(m.operationId)?.signal.aborted === true)
    );
  }
  function allocateAttempt(
    head: CopilotGrantHead,
    admittedGeneration: number,
    mutation?: CopilotGrantMutation,
  ): RefreshAttempt {
    let publish: (outcome: RefreshOutcome) => void = () => {};
    const outcome = new Promise<RefreshOutcome>((resolve) => {
      publish = resolve;
    });
    const attempt: RefreshAttempt = {
      head,
      mutation: mutation ?? {
        operationId: randomUUID(),
        epoch: head.epoch,
        account: account(head.account),
        origin: head.origin,
        kind: 'refresh',
        from: head.pin,
        committed: null,
        probeConfirmed: true,
        cancelling: false,
      },
      phase: mutation
        ? mutation.kind === 'refresh'
          ? 'recovering-orphan'
          : 'recovered-local-mutation'
        : 'preparing',
      generation: admittedGeneration,
      outcome,
      publish,
      effects: [],
      submissionOpen: !closedSubmissions.has(head.epoch),
      retired: false,
      cutoff: 0,
    };
    attempts.set(head.epoch, attempt);
    for (const demand of demands)
      if (demand.epoch === head.epoch && !demand.attempt)
        demand.attempt = attempt;
    return attempt;
  }
  function transition(attempt: RefreshAttempt, event: RefreshEvent): void {
    if (event.kind === 'superseded') {
      attempt.phase = 'superseded';
      attempt.submissionOpen = false;
      attempt.candidate = undefined;
      attempt.predecessor = undefined;
      if (!attempt.result) {
        const result: RefreshOutcome = {
          kind: 'no-result',
          failure: blocked('changed'),
        };
        attempt.result = result;
        attempt.cutoff = requestSequence;
        attempt.publish(result);
      }
      return;
    }
    if (!currentAttempt(attempt)) return;
    if (event.kind === 'recover-local') {
      if (
        attempt.phase === 'recovering-orphan' &&
        event.mutation.operationId === attempt.mutation.operationId
      ) {
        attempt.mutation = event.mutation;
        attempt.phase = 'recovered-local-mutation';
      }
      return;
    }
    if (event.kind === 'confirmed') {
      if (
        attempt.phase === 'success' ||
        attempt.phase === 'recovered-local-mutation'
      )
        attempt.phase = 'confirmed';
      return;
    }
    if (event.kind === 'presenting') {
      if (attempt.phase === 'preparing') attempt.phase = 'presenting';
      return;
    }
    if (
      attempt.result ||
      (attempt.phase !== 'preparing' && attempt.phase !== 'presenting')
    )
      return;
    attempt.phase = event.kind;
    if (event.kind === 'success') {
      attempt.predecessor = undefined;
      attempt.candidate = event.grant;
      attempt.mutation = { ...attempt.mutation, kind: 'replace' };
    } else if (event.kind === 'rejected') {
      attempt.predecessor = undefined;
      attempt.mutation = { ...attempt.mutation, kind: 'delete' };
    } else attempt.cutoff = requestSequence;
    attempt.result = event;
    attempt.publish(event);
  }

  function familyWriter(): Promise<VaultFamilyWriter> {
    writer ??= options
      .writer()
      .then((value) => {
        if (value.family !== 'copilot-account')
          throw new Error('Wrong family writer.');
        return value;
      })
      .catch((error: unknown) => {
        writer = undefined;
        throw error;
      });
    return writer;
  }
  async function read(): Promise<CopilotAuthorityRecord> {
    const parsed = CopilotAuthorityRecordSchema.safeParse(
      await options.journal.read(),
    );
    if (!parsed.success) throw new CopilotAuthorityJournalError('corrupt');
    const state = parsed.data;
    const m = state.mutation;
    if (
      m &&
      ((m.kind === 'create' && (m.from !== null || state.head !== null)) ||
        ((m.kind === 'replace' || m.kind === 'refresh') &&
          (!m.from ||
            !state.head ||
            state.head.epoch !== m.epoch ||
            !samePin(state.head.pin, m.from))) ||
        (m.kind === 'delete' && !m.from) ||
        (m.kind !== 'create' &&
          (!m.probeConfirmed || m.committed !== null || m.cancelling)) ||
        (m.kind === 'create' && m.committed !== null && !m.probeConfirmed) ||
        (m.kind !== 'create' &&
          state.head &&
          (m.epoch !== state.head.epoch ||
            !sameAccount(m.account, state.head.account) ||
            m.origin !== state.head.origin ||
            m.from?.ref.vaultId !== state.head.pin.ref.vaultId ||
            m.from?.ref.entryId !== state.head.pin.ref.entryId)))
    )
      throw new CopilotAuthorityJournalError('corrupt');
    if (
      state.removal &&
      (!state.head || state.removal.epoch !== state.head.epoch)
    )
      throw new CopilotAuthorityJournalError('corrupt');
    return state;
  }
  async function save(
    state: CopilotAuthorityRecord,
    change: Partial<Omit<CopilotAuthorityRecord, 'version' | 'sequence'>>,
    owner?: RefreshAttempt,
  ): Promise<boolean> {
    const candidate: CopilotAuthorityRecord = {
      ...state,
      ...change,
      version: change.setupLineage ? 2 : state.version,
      sequence: state.sequence + 1,
    };
    const witness = candidate.setupLineage;
    if (witness) {
      const successor = witness.successor;
      const m = candidate.mutation;
      // A retired witness survives only until the next head or setup intent.
      if (candidate.head || (witness.phase === 'retired' && m))
        candidate.setupLineage = null;
      else if (
        !m &&
        candidate.completed?.kind === 'delete' &&
        candidate.completed.operationId === `${successor.operationId}:cancel` &&
        candidate.completed.epoch === successor.epoch
      )
        candidate.setupLineage = { ...witness, phase: 'cancelled' };
      else if (m?.cancelling || m?.kind === 'delete')
        candidate.setupLineage = { ...witness, phase: 'cancelling' };
    }
    const next = CopilotAuthorityRecordSchema.parse(candidate);
    const m = change.mutation ?? state.mutation;
    const effect = recordEffect(
      owner ?? (m ? attemptFor(m) : undefined),
      'journal',
      state.sequence,
    );
    return trackEffect(effect, () =>
      options.journal.compareExchange(state.sequence, next),
    );
  }
  function recordEffect(
    attempt: RefreshAttempt | undefined,
    kind: RefreshEffect['kind'],
    sequence: number,
  ): RefreshEffect | undefined {
    if (!attempt) return undefined;
    const effect: RefreshEffect = {
      id: randomUUID(),
      kind,
      sequence,
      submitted: false,
      outcome: 'pending',
    };
    attempt.effects.push(effect);
    return effect;
  }
  async function trackEffect<T>(
    effect: RefreshEffect | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      if (effect) effect.submitted = true;
      const result = await run();
      if (effect && effect.outcome !== 'superseded')
        effect.outcome = 'definite';
      return result;
    } catch (error) {
      if (effect && effect.outcome !== 'superseded') effect.outcome = 'unknown';
      throw error;
    }
  }
  function pending(operation: {
    operationId: string;
    kind: CopilotGrantMutation['kind'] | 'remove';
    origin: CopilotGrantHead['origin'];
  }): CopilotGrantResult {
    return {
      kind: 'pending',
      operationId: operation.operationId,
      operation: { kind: operation.kind, origin: operation.origin },
    };
  }
  async function safe(
    run: () => Promise<CopilotGrantResult>,
  ): Promise<CopilotGrantResult> {
    try {
      return await run();
    } catch (error) {
      return blocked(
        error instanceof CopilotAuthorityJournalError
          ? error.reason
          : 'unavailable',
      );
    }
  }
  async function commit(
    m: CopilotGrantMutation,
    pin: VaultSecretPin,
  ): Promise<CopilotGrantResult> {
    const state = await read();
    if (
      m.kind === 'replace' &&
      (!m.from ||
        pin.ref.vaultId !== m.from.ref.vaultId ||
        pin.ref.entryId !== m.from.ref.entryId ||
        pin.revision !== m.from.revision + 1)
    )
      return blocked('unconfirmed');
    if (
      m.kind === 'replace' &&
      !state.mutation &&
      state.head?.epoch === m.epoch &&
      samePin(state.head.pin, pin)
    )
      return { kind: 'ready', head: state.head };
    if (state.mutation?.operationId !== m.operationId)
      return blocked('changed');
    if (m.kind === 'replace') {
      if (
        !state.head ||
        state.head.epoch !== m.epoch ||
        !m.from ||
        !samePin(state.head.pin, m.from)
      )
        return blocked('changed');
      if (
        !(await save(state, {
          head: { ...state.head, pin },
          mutation: null,
          completed: {
            operationId: m.operationId,
            epoch: m.epoch,
            kind: 'replace',
          },
        }))
      ) {
        const latest = await read();
        return !latest.removal &&
          !latest.mutation &&
          latest.head?.epoch === m.epoch &&
          latest.completed?.operationId === m.operationId &&
          samePin(latest.head.pin, pin)
          ? { kind: 'ready', head: latest.head }
          : blocked('unconfirmed');
      }
      setupCustody.delete(m.operationId);
      return { kind: 'ready', head: { ...state.head, pin } };
    }
    if (m.kind === 'create') {
      if (
        !(await save(state, {
          mutation: { ...state.mutation, committed: pin },
        }))
      )
        return blocked('unconfirmed');
      return pending(m);
    }
    return blocked('changed');
  }
  async function persistOnce(
    m: CopilotGrantMutation,
  ): Promise<CopilotGrantResult> {
    const material =
      attemptFor(m)?.candidate ?? setupCustody.get(m.operationId)?.grant;
    if (!material || !m.probeConfirmed) return blocked('unconfirmed');
    const state = await read();
    if (
      (state.removal && !attemptFor(m)) ||
      state.mutation?.operationId !== m.operationId ||
      state.mutation.cancelling ||
      cancelling.has(m.operationId)
    )
      return blocked('changed');
    const repository = await options.repository();
    if (repository.status().protection.state !== 'available')
      await options.probeKeyIfDue();
    const writer = await familyWriter();
    const latest = await read();
    if (
      setupFenced(m) ||
      !ownsSubmission(m) ||
      latest.mutation?.operationId !== m.operationId ||
      latest.mutation.kind !== m.kind
    )
      return blocked('changed');
    const bytes = Buffer.from(JSON.stringify(material));
    try {
      const effect = recordEffect(attemptFor(m), 'put', latest.sequence);
      const result = await trackEffect(effect, () =>
        writer.put({
          ...(m.from
            ? { ref: m.from.ref, expectedRevision: m.from.revision }
            : {
                family: 'copilot-account',
                entryId: null,
                expectedRevision: null,
              }),
          label: 'Copilot',
          material: bytes,
          expiresAt: null,
          idempotencyKey: m.operationId,
        }),
      );
      if (effect && result.kind === 'outcome_unknown')
        effect.outcome = 'unknown';
      if (result.kind === 'committed') return commit(m, result.pin);
      if (result.kind === 'blocked') return blocked(result.reason);
      return mutationFailure(result);
    } finally {
      bytes.fill(0);
    }
  }
  function persist(m: CopilotGrantMutation): Promise<CopilotGrantResult> {
    if (attemptFor(m)) return safe(() => persistOnce(m));
    const existing = setupSaving.get(m.operationId);
    if (existing) return existing;
    const task = safe(() => persistOnce(m)).finally(() => {
      setupSaving.delete(m.operationId);
    });
    setupSaving.set(m.operationId, task);
    return task;
  }
  async function recover(
    state: CopilotAuthorityRecord,
  ): Promise<CopilotGrantResult | null> {
    const m = state.mutation;
    if (!m || m.kind === 'delete' || m.committed) return null;
    // Post-fence demands stay unconfirmed to avoid another stored-grant presentation (D31).
    if (m.kind === 'refresh') return blocked('unconfirmed');
    const outcome = await options.journal.reconcile(m.operationId);
    if (outcome.kind === 'committed') return commit(m, outcome.pin);
    if (foreignWork(m)) return blocked('unconfirmed');
    if (
      (outcome.kind === 'not_accepted' || outcome.kind === 'retryable') &&
      (attemptFor(m)?.candidate || setupCustody.has(m.operationId))
    )
      return persist(m);
    return blocked('unconfirmed');
  }
  function validReceipt(
    m: CopilotGrantMutation,
    receipt: CopilotSelectionReceipt,
  ): boolean {
    return (
      receipt.operationId === m.operationId &&
      receipt.epoch === m.epoch &&
      receipt.origin === m.origin &&
      sameAccount(receipt.account, m.account) &&
      Boolean(m.committed && samePin(receipt.pin, m.committed)) &&
      Boolean(receipt.pinGeneration.trim())
    );
  }
  async function advanceAttempt(
    attempt: RefreshAttempt,
  ): Promise<CopilotGrantResult> {
    if (
      attempts.get(attempt.head.epoch) !== attempt ||
      attempt.phase === 'superseded'
    )
      return blocked('changed');
    let state = await read();
    if (
      !currentAttempt(attempt) ||
      !state.head ||
      state.head.epoch !== attempt.head.epoch
    )
      return blocked('changed');
    if (
      attempt.phase === 'no-result' ||
      attempt.phase === 'recovering-orphan'
    ) {
      if (
        attempt.phase === 'recovering-orphan' &&
        !terminatedRefresh(attempt.mutation)
      )
        return blocked('unconfirmed');
      if (
        state.mutation?.operationId === attempt.mutation.operationId &&
        state.mutation.kind === 'refresh'
      ) {
        const accepted = await save(state, { mutation: null });
        state = await read();
        if (!currentAttempt(attempt) || state.removal)
          return blocked('changed');
        if (!accepted && state.mutation && state.mutation.kind === 'refresh')
          return blocked('unconfirmed');
      }
      if (
        attempt.phase === 'recovering-orphan' &&
        state.mutation?.operationId === attempt.mutation.operationId &&
        (state.mutation.kind === 'replace' || state.mutation.kind === 'delete')
      ) {
        transition(attempt, {
          kind: 'recover-local',
          mutation: state.mutation,
        });
        return advanceAttempt(attempt);
      }
      const unfenced = attempt.effects.filter(
        (effect) =>
          effect.kind === 'journal' &&
          (effect.outcome === 'unknown' || effect.outcome === 'pending') &&
          effect.sequence >= state.sequence,
      );
      if (!state.mutation && unfenced.length) {
        // Absence in a read cannot fence an uncertain CAS that may still execute.
        const accepted = await save(state, { mutation: null }, attempt);
        state = await read();
        if (!accepted || !currentAttempt(attempt) || state.removal)
          return blocked('unconfirmed');
      }
      for (const effect of attempt.effects)
        if (
          effect.kind === 'journal' &&
          effect.sequence < state.sequence &&
          (effect.outcome === 'unknown' || effect.outcome === 'pending')
        )
          effect.outcome = 'superseded';
      if (
        state.mutation ||
        !state.head ||
        (attempt.phase !== 'recovering-orphan' &&
          !samePin(state.head.pin, attempt.head.pin))
      )
        return blocked('changed');
      attempt.retired = true;
      return attempt.result?.kind === 'no-result'
        ? attempt.result.failure
        : { kind: 'ready', head: state.head };
    }
    if (attempt.phase === 'preparing' || attempt.phase === 'presenting')
      return pending(attempt.mutation);
    const m = attempt.mutation;
    if (!state.mutation) {
      if (
        state.completed?.operationId === m.operationId &&
        state.completed.kind === 'replace'
      ) {
        transition(attempt, { kind: 'confirmed' });
        return { kind: 'ready', head: state.head };
      }
      return blocked('changed');
    }
    if (state.mutation.operationId !== m.operationId) return blocked('changed');
    if (state.mutation.kind === 'refresh') {
      if (!samePin(state.head.pin, attempt.head.pin)) return blocked('changed');
      if (!(await save(state, { mutation: m }))) return blocked('unconfirmed');
      state = await read();
      if (
        state.mutation?.operationId !== m.operationId ||
        state.mutation.kind !== m.kind
      )
        return blocked('changed');
    }
    if (m.kind === 'delete')
      return state.removal ? pending(m) : deleteMutation(m);
    const recovered = await recover(state);
    if (recovered?.kind === 'ready') transition(attempt, { kind: 'confirmed' });
    return recovered ?? blocked('unconfirmed');
  }
  function progressAttempt(
    attempt: RefreshAttempt,
  ): Promise<CopilotGrantResult> {
    if (attempt.progress) return attempt.progress;
    const progress = safe(() => advanceAttempt(attempt)).finally(() => {
      if (attempt.progress === progress) attempt.progress = undefined;
    });
    attempt.progress = progress;
    return progress;
  }
  async function resume(operationId: string): Promise<CopilotGrantResult> {
    let state = await read();
    if (state.removal) {
      if (
        state.removal.operationId === operationId ||
        state.mutation?.operationId === operationId ||
        state.completed?.operationId === operationId ||
        state.head?.operationId === operationId
      )
        return remove(state.removal.epoch);
      return blocked('busy');
    }
    const local = state.head ? attempts.get(state.head.epoch) : undefined;
    if (
      local &&
      local.mutation.operationId === operationId &&
      local.phase !== 'preparing' &&
      local.phase !== 'presenting'
    )
      return progressAttempt(local);
    if (state.completed?.operationId === operationId) {
      if (state.completed.kind === 'delete') return { kind: 'removed' };
      if (state.mutation) return blocked('unconfirmed');
      return state.head && state.head.epoch === state.completed.epoch
        ? { kind: 'ready', head: state.head }
        : blocked('changed');
    }
    if (
      state.mutation?.operationId === operationId &&
      state.mutation.kind === 'delete'
    )
      return deleteMutation(state.mutation);
    if (state.head?.operationId === operationId && !state.mutation) {
      return state.completed?.kind === 'delete' &&
        state.completed.epoch === state.head.epoch
        ? blocked('expired')
        : { kind: 'ready', head: state.head };
    }
    if (
      options.selection.abandon &&
      state.mutation?.operationId === operationId &&
      (state.mutation.cancelling ||
        (state.mutation.kind === 'create' &&
          state.mutation.origin === 'setup' &&
          !state.mutation.probeConfirmed &&
          setupCustody.get(operationId)?.epoch !== state.mutation.epoch))
    )
      return completeCancellation(operationId, await cancel(operationId));
    if (
      state.mutation?.operationId !== operationId ||
      state.mutation.cancelling ||
      cancelling.has(operationId)
    )
      return blocked('changed');
    if (
      state.mutation.kind === 'create' &&
      !state.mutation.probeConfirmed &&
      setupCustody.get(operationId)?.epoch === state.mutation.epoch
    )
      return blocked('unconfirmed');
    const recovery = await recover(state);
    if (recovery?.kind === 'blocked') return recovery;
    state = await read();
    const m = state.mutation;
    if (!m)
      return state.head
        ? { kind: 'ready', head: state.head }
        : blocked('absent');
    if (m.kind !== 'create' || !m.committed) return blocked('unconfirmed');
    const rows = (await (await options.repository()).list()).filter(
      (row) => row.family === 'copilot-account',
    );
    const entry = rows[0];
    if (
      setupFenced(m) ||
      rows.length !== 1 ||
      !entry ||
      !samePin(m.committed, { ref: entry.ref, revision: entry.revision })
    )
      return blocked('unconfirmed');
    const selection = await options.selection.confirm({
      operationId: m.operationId,
      epoch: m.epoch,
      account: account(m.account),
      origin: m.origin,
      pin: m.committed,
    });
    if (selection.kind !== 'confirmed')
      return blocked(
        selection.kind === 'superseded' ? 'changed' : 'unconfirmed',
      );
    if (!validReceipt(m, selection.receipt)) return blocked('changed');
    const latest = await read();
    if (
      setupFenced(m) ||
      latest.removal ||
      latest.mutation?.operationId !== operationId ||
      latest.mutation.cancelling ||
      cancelling.has(operationId)
    )
      return blocked('changed');
    const head: CopilotGrantHead = {
      operationId,
      epoch: m.epoch,
      account: account(m.account),
      origin: m.origin,
      pin: m.committed,
      pinGeneration: selection.receipt.pinGeneration,
    };
    if (!(await save(latest, { head, mutation: null })))
      return blocked('unconfirmed');
    // Submitted writes can settle after quit; their acknowledgement cannot reopen setup.
    if (setupFenced(m)) return blocked('changed');
    return { kind: 'ready', head };
  }
  async function load(
    head: CopilotGrantHead,
  ): Promise<CopilotVaultGrant | CopilotGrantFailure> {
    const repository = await options.repository();
    if (repository.status().protection.state !== 'available')
      await options.probeKeyIfDue();
    const rows = (await repository.list()).filter(
      (row) => row.family === 'copilot-account',
    );
    if (
      rows.length !== 1 ||
      !rows[0] ||
      !samePin(head.pin, { ref: rows[0].ref, revision: rows[0].revision })
    )
      return blocked('unconfirmed');
    const result = await repository.get(head.pin.ref);
    if (result.kind === 'blocked') return blocked(result.reason);
    if (result.kind !== 'available')
      return blocked(result.kind === 'unconfirmed' ? 'unconfirmed' : 'absent');
    try {
      if (!samePin(result.pin, head.pin)) return blocked('changed');
      const decoded: unknown = JSON.parse(
        Buffer.from(
          result.material.buffer,
          result.material.byteOffset,
          result.material.byteLength,
        ).toString('utf8'),
      );
      const parsed = CopilotVaultGrantSchema.safeParse(decoded);
      if (!parsed.success) return blocked('corrupt');
      if (!sameAccount(parsed.data, head.account)) return blocked('changed');
      const admission = repository.admit(head.pin);
      if (admission.kind !== 'admitted')
        return blocked(
          admission.kind === 'blocked' ? admission.reason : 'unconfirmed',
        );
      return parsed.data;
    } catch {
      return blocked('corrupt');
    } finally {
      result.material.fill(0);
    }
  }
  async function rotate(
    attempt: RefreshAttempt,
    grant: CopilotVaultGrant,
    handle: string,
  ): Promise<CopilotGrantResult> {
    const head = attempt.head;
    const noResult = async (
      failure: CopilotGrantFailure,
    ): Promise<CopilotGrantResult> => {
      transition(attempt, { kind: 'no-result', failure });
      return progressAttempt(attempt);
    };
    try {
      const repository = await options.repository();
      const before = await read();
      if (
        family.closed ||
        admissionClosures.size !== 0 ||
        generation !== attempt.generation ||
        before.removal ||
        before.mutation ||
        !before.head ||
        before.head.epoch !== head.epoch ||
        !samePin(before.head.pin, head.pin)
      )
        return noResult(blocked('changed'));
      if (!(await save(before, { mutation: attempt.mutation })))
        return noResult(blocked('unconfirmed'));
      const admitted = await read();
      if (
        family.closed ||
        admissionClosures.size !== 0 ||
        generation !== attempt.generation ||
        admitted.removal ||
        admitted.mutation?.operationId !== attempt.mutation.operationId ||
        !admitted.head ||
        admitted.head.epoch !== head.epoch ||
        !samePin(admitted.head.pin, head.pin) ||
        !attempt.submissionOpen ||
        !options.recipient.admitted(handle, head, attempt.generation)
      )
        return noResult(blocked('changed'));
      const admission = repository.admit(head.pin);
      if (admission.kind !== 'admitted')
        return noResult(
          blocked(
            admission.kind === 'blocked' ? admission.reason : 'unconfirmed',
          ),
        );
      transition(attempt, { kind: 'presenting' });
      let result:
        | Awaited<ReturnType<typeof options.refresh>>
        | { readonly kind: 'thrown' };
      try {
        result = await options.refresh(grant, AbortSignal.timeout(30_000));
      } catch {
        result = { kind: 'thrown' };
      }
      if (!currentAttempt(attempt)) return noResult(blocked('changed'));
      if (result.kind === 'lost') return noResult(blocked('network'));
      if (result.kind === 'thrown') return noResult(blocked('refresh_failed'));
      if (result.kind === 'success') {
        const next = CopilotVaultGrantSchema.safeParse(result.grant);
        if (
          !next.success ||
          !sameAccount(next.data, head.account) ||
          next.data.clientId !== grant.clientId
        )
          return noResult(blocked('changed'));
        transition(attempt, { kind: 'success', grant: next.data });
      } else {
        transition(attempt, { kind: 'rejected' });
      }
      return progressAttempt(attempt);
    } catch {
      // Fence submission uncertainty never permits provider execution in this cohort.
      if (!attempt.result) {
        const failure = blocked('unavailable');
        transition(attempt, { kind: 'no-result', failure });
        return failure;
      }
      return blocked('unavailable');
    }
  }
  async function deleteMutation(
    m: CopilotGrantMutation,
    finishRemoval = false,
    /** The host's disabled receipt: the removal owner's head, or the cancelled setup's own. */
    receipt?: CopilotHostSelection,
  ): Promise<CopilotGrantResult> {
    let retiredReceipt = finishRemoval ? receipt : undefined;
    const from = m.from;
    if (!from) return blocked('changed');
    const outcome = await options.journal.reconcile(m.operationId);
    if (outcome.kind === 'unconfirmed') return blocked('unconfirmed');
    if (outcome.kind === 'committed') {
      if (
        !samePin(outcome.pin, {
          ref: from.ref,
          revision: from.revision + 1,
        })
      )
        return blocked('unconfirmed');
    } else {
      const writer = await familyWriter();
      const current = await read();
      if (
        current.completed?.operationId === m.operationId &&
        current.completed.kind === 'delete'
      )
        return { kind: 'removed' };
      if (
        current.mutation?.operationId !== m.operationId ||
        current.mutation.kind !== 'delete' ||
        cancelling.has(m.operationId) ||
        (!finishRemoval && attemptFor(m) && !ownsSubmission(m))
      )
        return blocked('changed');
      const effect = recordEffect(attemptFor(m), 'delete', current.sequence);
      const result = await trackEffect(effect, () =>
        writer.delete({
          ref: from.ref,
          expectedRevision: from.revision,
          idempotencyKey: m.operationId,
        }),
      );
      if (effect && result.kind === 'outcome_unknown')
        effect.outcome = 'unknown';
      if (result.kind !== 'committed') return mutationFailure(result);
    }
    let latest = await read();
    if (latest.completed?.operationId === m.operationId)
      return { kind: 'removed' };
    if (
      latest.mutation?.operationId !== m.operationId ||
      latest.mutation.cancelling ||
      cancelling.has(m.operationId)
    )
      return blocked('changed');
    if (latest.head && !latest.removal && !finishRemoval) {
      if (latest.head.epoch !== m.epoch || !samePin(latest.head.pin, from))
        return blocked('changed');
      // Retain rejected-grant lineage until its exact host receipt is retired.
      const disabled = await options.selection.disable({
        operationId: m.operationId,
        head: latest.head,
      });
      if (disabled.kind !== 'disabled') return blocked('unconfirmed');
      retiredReceipt = disabled.receipt;
      latest = await read();
      if (
        latest.mutation?.operationId !== m.operationId ||
        latest.mutation.cancelling ||
        cancelling.has(m.operationId)
      )
        return blocked('changed');
    }
    const lineage = latest.setupLineage;
    let cancelled: CopilotSetupLineageWitness | undefined;
    if (
      !latest.head &&
      lineage &&
      m.operationId === `${lineage.successor.operationId}:cancel`
    ) {
      const setup = { ...m, operationId: lineage.successor.operationId };
      // A replay has no receipt in hand; the host reports the durable survivor.
      const survivor =
        receipt ??
        (await options.selection.cancelledReceipt?.({
          operationId: setup.operationId,
          epoch: setup.epoch,
          account: account(setup.account),
          origin: setup.origin,
        }));
      cancelled = cancelledLineage(lineage, setup, from, survivor);
      latest = await read();
      if (
        latest.head ||
        latest.mutation?.operationId !== m.operationId ||
        latest.mutation.cancelling
      )
        return blocked('changed');
    }
    const completed: NonNullable<CopilotAuthorityRecord['completed']> = {
      operationId: m.operationId,
      epoch: m.epoch,
      kind: 'delete',
    };
    const retainsHead = !!latest.removal && !finishRemoval;
    const retired =
      latest.head && !retainsHead
        ? retiredLineage(latest.head, retiredReceipt, completed)
        : undefined;
    if (
      !(await save(latest, {
        head: retainsHead ? latest.head : null,
        mutation: null,
        removal: finishRemoval ? null : latest.removal,
        completed,
        ...(retired ? { setupLineage: retired } : {}),
        ...(cancelled ? { setupLineage: cancelled } : {}),
      }))
    )
      return blocked('unconfirmed');
    retireEpoch(m.epoch);
    return { kind: 'removed' };
  }
  async function deliverCandidate(
    attempt: RefreshAttempt,
    grant: CopilotVaultGrant,
    handle: string,
    ticket: DemandTicket,
  ): Promise<CopilotGrantResult> {
    const source = attempt.head;
    const repository = await options.repository();
    const rows = (await repository.list()).filter(
      (entry) => entry.family === 'copilot-account',
    );
    const row = rows[0];
    if (
      rows.length !== 1 ||
      !row ||
      row.state === 'delete_unconfirmed' ||
      row.ref.vaultId !== source.pin.ref.vaultId ||
      row.ref.entryId !== source.pin.ref.entryId ||
      (row.revision !== source.pin.revision &&
        row.revision !== source.pin.revision + 1)
    )
      return blocked('changed');
    const final = await read();
    if (
      !admittedDemand(final, handle, ticket) ||
      !final.head ||
      attempts.get(source.epoch) !== attempt ||
      !attempt.submissionOpen ||
      (attempt.phase !== 'success' && attempt.phase !== 'confirmed') ||
      !sameAccount(final.head.account, source.account)
    )
      return blocked('changed');
    if (
      final.mutation
        ? final.mutation.operationId !== attempt.mutation.operationId ||
          (final.mutation.kind !== 'refresh' &&
            final.mutation.kind !== 'replace') ||
          !samePin(final.head.pin, source.pin)
        : final.completed?.operationId !== attempt.mutation.operationId ||
          final.completed.kind !== 'replace' ||
          !samePin(final.head.pin, {
            ref: source.pin.ref,
            revision: source.pin.revision + 1,
          })
    )
      return blocked('changed');
    return deliver(grant, handle, null);
  }
  function admittedDemand(
    state: CopilotAuthorityRecord,
    handle: string,
    ticket: DemandTicket,
  ): boolean {
    return (
      !family.closed &&
      admissionClosures.size === 0 &&
      generation === ticket.generation &&
      !state.removal &&
      Boolean(
        state.head &&
        state.head.epoch === ticket.epoch &&
        options.recipient.admitted(handle, state.head, ticket.generation),
      )
    );
  }
  function deliver(
    grant: CopilotVaultGrant,
    handle: string,
    committedPin: VaultSecretPin | null,
  ): CopilotGrantResult {
    const expiresAt = Date.parse(grant.accessTokenExpiresAt);
    if (expiresAt <= now()) return blocked('network');
    options.recipient.deliver(handle, grant.accessToken, expiresAt);
    return { kind: 'delivered', expiresAt, committedPin };
  }
  async function deliverStored(
    head: CopilotGrantHead,
    grant: CopilotVaultGrant,
    handle: string,
    ticket: DemandTicket,
  ): Promise<CopilotGrantResult> {
    const repository = await options.repository();
    const final = await read();
    if (
      !admittedDemand(final, handle, ticket) ||
      !final.head ||
      final.mutation ||
      !samePin(final.head.pin, head.pin)
    )
      return blocked('changed');
    const admission = repository.admit(head.pin);
    if (admission.kind !== 'admitted')
      return blocked(
        admission.kind === 'blocked' ? admission.reason : 'unconfirmed',
      );
    return deliver(grant, handle, head.pin);
  }
  async function useAttempt(
    attempt: RefreshAttempt,
    handle: string,
    ticket: DemandTicket,
  ): Promise<CopilotGrantResult> {
    if (attempt.phase === 'recovering-orphan') {
      const recovered = await progressAttempt(attempt);
      if (attempt.phase !== 'recovering-orphan')
        return useAttempt(attempt, handle, ticket);
      if (!attempt.retired) return recovered;
      // Retirement is definite. Allocation below is synchronous, so later joiners share it.
      ticket.attempt = undefined;
      if (attempts.get(ticket.epoch) === attempt) attempts.delete(ticket.epoch);
      return present(handle, ticket);
    }
    if (
      attempt.phase === 'recovered-local-mutation' ||
      (attempt.phase === 'confirmed' && !attempt.result)
    ) {
      const recovered = await progressAttempt(attempt);
      if (recovered.kind !== 'ready')
        return recovered.kind === 'removed' ? blocked('expired') : recovered;
      const state = await read();
      if (!state.head || !admittedDemand(state, handle, ticket))
        return blocked('changed');
      const grant = await load(state.head);
      return 'kind' in grant
        ? grant
        : deliverStored(state.head, grant, handle, ticket);
    }
    if (!attempt.result && attempt.phase === 'superseded')
      return blocked('changed');
    const outcome = await attempt.outcome;
    if (outcome.kind === 'success') {
      return deliverCandidate(attempt, outcome.grant, handle, ticket);
    }
    if (outcome.kind === 'rejected') {
      const result = await progressAttempt(attempt);
      return result.kind === 'removed' ? blocked('expired') : result;
    }
    const retired = await (ticket.id > attempt.cutoff
      ? progressAttempt(attempt)
      : (attempt.chain ?? progressAttempt(attempt)));
    if (!attempt.retired) return retired;
    if (ticket.id > attempt.cutoff) {
      ticket.attempt = undefined;
      if (attempts.get(ticket.epoch) === attempt) attempts.delete(ticket.epoch);
      return present(handle, ticket);
    }
    const failure = outcome.failure;
    // A thrown refresh keeps a network loss's fallback to the still-valid grant.
    if (
      (failure.reason !== 'network' && failure.reason !== 'refresh_failed') ||
      !attempt.predecessor
    )
      return failure;
    const fallback = await deliverStored(
      attempt.head,
      attempt.predecessor,
      handle,
      ticket,
    );
    // An expired predecessor reads as `network`; keep the refresh's own cause.
    return fallback.kind === 'blocked' && fallback.reason === 'network'
      ? failure
      : fallback;
  }
  async function present(
    handle: string,
    ticket: DemandTicket,
  ): Promise<CopilotGrantResult> {
    const state = await read();
    if (!admittedDemand(state, handle, ticket) || !state.head)
      return blocked('changed');
    if (
      !state.mutation &&
      state.completed?.kind === 'delete' &&
      state.completed.epoch === state.head.epoch
    )
      return blocked('expired');
    let attempt = ticket.attempt ?? attempts.get(ticket.epoch);
    if (attempt?.phase === 'superseded') return blocked('changed');
    if (
      attempt &&
      !state.mutation &&
      attempt.phase === 'confirmed' &&
      !ticket.attempt
    )
      attempt = undefined;
    if (attempt) {
      if (attempt.phase === 'success' && !attempt.progress)
        void progressAttempt(attempt);
      return useAttempt(attempt, handle, ticket);
    }
    if (state.mutation) {
      if (
        state.mutation.kind === 'refresh' &&
        !terminatedRefresh(state.mutation)
      )
        return blocked('unconfirmed');
      attempt = allocateAttempt(state.head, ticket.generation, state.mutation);
      return useAttempt(attempt, handle, ticket);
    }
    const head = state.head;
    const grant = await load(head).catch((error: unknown) =>
      blocked(
        error instanceof CopilotAuthorityJournalError
          ? error.reason
          : 'unavailable',
      ),
    );
    // A demand delayed in load still belongs to the attempt allocated while it was outstanding.
    attempt = ticket.attempt ?? attempts.get(ticket.epoch);
    if (attempt && attempt.phase !== 'confirmed')
      return useAttempt(attempt, handle, ticket);
    if (ticket.attempt) return useAttempt(ticket.attempt, handle, ticket);
    if ('kind' in grant) return grant;
    if (Date.parse(grant.accessTokenExpiresAt) - now() > 3_600_000)
      return deliverStored(head, grant, handle, ticket);
    const started = allocateAttempt(head, ticket.generation);
    started.predecessor = grant;
    const owned = { attempt: started, settled: false };
    const key = refreshKey(started.mutation);
    ownedRefreshes.set(key, owned);
    started.chain = safe(() => rotate(started, grant, handle)).finally(() => {
      owned.settled = true;
      if (
        (!started.candidate ||
          started.phase === 'confirmed' ||
          started.phase === 'superseded') &&
        ownedRefreshes.get(key) === owned
      )
        ownedRefreshes.delete(key);
    });
    return useAttempt(started, handle, ticket);
  }
  async function demand(): Promise<CopilotGrantResult> {
    let state = await read();
    if (family.closed || state.removal) return blocked('unconfirmed');
    if (!state.head) return blocked('absent');
    const m = state.mutation;
    if (m) {
      if (
        m.cancelling ||
        m.epoch !== state.head.epoch ||
        (m.kind !== 'refresh' && m.kind !== 'replace')
      )
        return blocked('unconfirmed');
      const local = attemptFor(m);
      if (
        local &&
        (local.candidate ||
          local.phase === 'preparing' ||
          local.phase === 'presenting')
      )
        return { kind: 'ready', head: state.head };
      if (m.kind === 'refresh') {
        if (!terminatedRefresh(m)) return blocked('unconfirmed');
        const attempt = local ?? allocateAttempt(state.head, generation, m);
        const result = await progressAttempt(attempt);
        if (result.kind !== 'ready') return result;
        if (attempt.retired && attempts.get(m.epoch) === attempt)
          attempts.delete(m.epoch);
      } else {
        const result = await recover(state);
        if (result?.kind !== 'ready') return result ?? blocked('unconfirmed');
      }
      state = await read();
    }
    if (family.closed || state.removal || state.mutation || !state.head)
      return blocked('unconfirmed');
    if (
      state.completed?.kind === 'delete' &&
      state.completed.epoch === state.head.epoch
    )
      return blocked('expired');
    return { kind: 'ready', head: state.head };
  }
  function closeAdmission(reason: AdmissionClosure): void {
    admissionClosures.add(reason);
    generation++;
    try {
      options.recipient.revoke();
    } catch {
      throw new Error('Copilot recipient unavailable.');
    }
  }
  function completeRemoval(epoch: string): void {
    let closed = admissionClosures.delete(`removing:${epoch}`);
    // Deletion supersedes this setup even if its completion reply was lost.
    for (const [id, setup] of setupClosures) {
      if (setup.epoch !== epoch) continue;
      if (setup.reason && admissionClosures.delete(setup.reason)) closed = true;
      setupClosures.delete(id);
    }
    if (closed) admissionClosures.add(`signed-out:${epoch}`);
  }
  function completeSetup(result: CopilotGrantResult): CopilotGrantResult {
    if (result.kind === 'ready' && setupClosures.has(result.head.operationId)) {
      if (
        family.closed ||
        cancelling.has(result.head.operationId) ||
        setupCustody.get(result.head.operationId)?.signal.aborted
      )
        return blocked('changed');
      setupCustody.delete(result.head.operationId);
      const setup = setupClosures.get(result.head.operationId);
      if (setup?.reason) admissionClosures.delete(setup.reason);
      // Fence delayed removal acknowledgements even on the first setup.
      generation++;
      setupClosures.delete(result.head.operationId);
    }
    return result;
  }
  function completeCancellation(
    operationId: string,
    result: CopilotGrantResult,
  ): CopilotGrantResult {
    const setup = setupClosures.get(operationId);
    if (result.kind === 'removed' && setup) completeRemoval(setup.epoch);
    return result;
  }
  function remove(
    expectedEpoch: string,
    pendingOperationId?: string,
  ): Promise<CopilotGrantResult> {
    const current = removals.get(expectedEpoch);
    if (current)
      return pendingOperationId
        ? Promise.resolve(blocked('unconfirmed'))
        : current;
    const startedGeneration = generation;
    // Register before invoking journal ports, which may synchronously reenter.
    const removing = Promise.resolve()
      .then(() =>
        safe(() =>
          removeAttempt(expectedEpoch, startedGeneration, pendingOperationId),
        ),
      )
      .then((result) => {
        if (result.kind === 'removed') completeRemoval(expectedEpoch);
        return result;
      })
      .finally(() => {
        removals.delete(expectedEpoch);
      });
    removals.set(expectedEpoch, removing);
    return removing;
  }
  async function removeAttempt(
    expectedEpoch: string,
    startedGeneration: number,
    pendingOperationId?: string,
  ): Promise<CopilotGrantResult> {
    let state = await read();
    // Match the operation in the same authenticated snapshot used to CAS the fence.
    if (
      pendingOperationId &&
      state.mutation?.operationId !== pendingOperationId &&
      state.removal?.operationId !== pendingOperationId
    )
      return blocked('changed');
    if (!state.head && state.completed?.epoch === expectedEpoch)
      return { kind: 'removed' };
    if (!state.head || state.head.epoch !== expectedEpoch)
      return blocked('changed');
    if (state.removal && state.removal.epoch !== expectedEpoch)
      return blocked('changed');
    // Revalidate even an existing removal fence before revoking local recipients.
    if (
      !(await save(state, {
        removal: state.removal ?? {
          operationId: randomUUID(),
          epoch: expectedEpoch,
        },
      }))
    )
      return blocked('unconfirmed');
    // The accepted fence may have finished removal while its reply was delayed.
    if (generation !== startedGeneration) return blocked('changed');
    const reason: AdmissionClosure = `removing:${expectedEpoch}`;
    closeAdmission(reason);
    // D30: only the rotation wait is bounded. Deletion can supersede a held put.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const drain = async (): Promise<void> => {
        const attempt = attempts.get(expectedEpoch);
        if (attempt?.chain) await attempt.chain;
        if (attempt?.progress) await attempt.progress;
      };
      await Promise.race([
        drain(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 2_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    state = await read();
    if (!state.head || state.head.epoch !== expectedEpoch || !state.removal)
      return blocked('changed');
    const disabled = await options.selection.disable({
      operationId: state.removal.operationId,
      head: state.head,
    });
    if (disabled.kind === 'failed') {
      const latest = await read();
      if (
        latest.removal?.operationId === state.removal.operationId &&
        (await save(latest, { removal: null }))
      )
        admissionClosures.delete(reason);
      return blocked('unavailable');
    }
    if (disabled.kind !== 'disabled') return blocked('unconfirmed');
    closedSubmissions.add(expectedEpoch);
    const currentAttempt = attempts.get(expectedEpoch);
    if (currentAttempt) transition(currentAttempt, { kind: 'superseded' });
    if (
      !state.mutation &&
      state.completed?.kind === 'delete' &&
      state.completed.epoch === expectedEpoch
    ) {
      const retired = retiredLineage(
        state.head,
        disabled.receipt,
        state.completed,
      );
      return (await save(state, {
        head: null,
        removal: null,
        ...(retired ? { setupLineage: retired } : {}),
      }))
        ? { kind: 'removed' }
        : blocked('unconfirmed');
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!state.head || state.head.epoch !== expectedEpoch || !state.removal)
        return blocked('changed');
      if (state.mutation?.kind === 'delete') {
        const replay = await deleteMutation(
          state.mutation,
          true,
          disabled.receipt,
        );
        if (replay.kind !== 'blocked' || replay.reason !== 'changed')
          return replay;
      }
      const targetedHead = state.head;
      const rows = (await (await options.repository()).list()).filter(
        (entry) =>
          entry.family === 'copilot-account' &&
          entry.ref.vaultId === targetedHead.pin.ref.vaultId &&
          entry.ref.entryId === targetedHead.pin.ref.entryId,
      );
      const row = rows[0];
      if (!row) return blocked('unconfirmed');
      const m: CopilotGrantMutation = {
        epoch: targetedHead.epoch,
        account: account(targetedHead.account),
        origin: targetedHead.origin,
        operationId: `${state.removal.operationId}:${row.revision}`,
        kind: 'delete',
        from: { ref: row.ref, revision: row.revision },
        committed: null,
        probeConfirmed: true,
        cancelling: false,
      };
      if (!(await save(state, { mutation: m }))) return blocked('unconfirmed');
      retireEpoch(expectedEpoch);
      const result = await deleteMutation(m, true, disabled.receipt);
      if (result.kind !== 'blocked' || result.reason !== 'changed')
        return result;
      state = await read();
    }
    return blocked('changed');
  }

  async function cancel(operationId: string): Promise<CopilotGrantResult> {
    let state = await read();
    let m = state.mutation;
    if (state.completed?.operationId === `${operationId}:cancel`)
      return { kind: 'removed' };
    if (m?.kind === 'delete' && m.operationId === `${operationId}:cancel`)
      return deleteMutation(m);
    if (
      state.head ||
      !m ||
      m.operationId !== operationId ||
      m.kind !== 'create'
    )
      return blocked('changed');
    cancelling.add(operationId);
    const liveSetup = setupCustody.get(operationId);
    if (liveSetup?.epoch === m.epoch) liveSetup.cancellation.abort();
    if (!m.cancelling) {
      if (!(await save(state, { mutation: { ...m, cancelling: true } })))
        return blocked('unconfirmed');
    }
    // A staged create must settle (or observe the local fence) before absence is authoritative.
    await setupSaving.get(operationId);
    state = await read();
    m = state.mutation;
    if (state.head || m?.operationId !== operationId || m.kind !== 'create')
      return blocked('changed');
    if (!m.committed) {
      const outcome = await options.journal.reconcile(operationId);
      if (outcome.kind === 'unconfirmed' || outcome.kind === 'retryable')
        return blocked('unconfirmed');
      if (outcome.kind === 'not_accepted') {
        const binding = {
          operationId: m.operationId,
          epoch: m.epoch,
          account: account(m.account),
          origin: m.origin,
        };
        if (options.selection.abandon) await options.selection.abandon(binding);
        const witness = cancelledLineage(
          state.setupLineage,
          m,
          null,
          state.setupLineage
            ? await options.selection.cancelledReceipt?.(binding)
            : undefined,
        );
        if (
          !(await save(state, {
            mutation: null,
            completed: {
              operationId: `${operationId}:cancel`,
              epoch: m.epoch,
              kind: 'delete',
            },
            ...(witness ? { setupLineage: witness } : {}),
          }))
        )
          return blocked('unconfirmed');
        setupCustody.delete(operationId);
        return { kind: 'removed' };
      }
      await commit(m, outcome.pin);
      state = await read();
      m = state.mutation;
    }
    if (!m?.committed || m.operationId !== operationId)
      return blocked('unconfirmed');
    const selected = await options.selection.confirm({
      operationId,
      epoch: m.epoch,
      account: account(m.account),
      origin: m.origin,
      pin: m.committed,
    });
    if (selected.kind === 'unconfirmed') return blocked('unconfirmed');
    let survivor: CopilotHostSelection | undefined;
    if (selected.kind === 'confirmed') {
      if (!validReceipt(m, selected.receipt)) return blocked('changed');
      const disabled = await options.selection.disable({
        operationId,
        head: {
          operationId,
          epoch: m.epoch,
          account: account(m.account),
          origin: m.origin,
          pin: m.committed,
          pinGeneration: selected.receipt.pinGeneration,
        },
      });
      if (disabled.kind !== 'disabled') return blocked('unconfirmed');
      survivor = disabled.receipt;
    }
    const latest = await read();
    if (latest.head || latest.mutation?.operationId !== operationId)
      return blocked('changed');
    const deletion: CopilotGrantMutation = {
      ...m,
      cancelling: false,
      kind: 'delete',
      from: m.committed,
      committed: null,
      operationId: `${operationId}:cancel`,
    };
    if (!(await save(latest, { mutation: deletion })))
      return blocked('unconfirmed');
    return deleteMutation(deletion, false, survivor);
  }
  return {
    create: (input, origin, onCheckpoint, signal) => {
      const parsed = CopilotVaultGrantSchema.safeParse(input);
      return safe(async () => {
        if (!parsed.success || (origin !== 'setup' && origin !== 'import'))
          return blocked('denied');
        const grant = parsed.data;
        if (family.closed || signal?.aborted) return blocked('changed');
        const state = await read();
        if (state.head || state.mutation || state.removal)
          return blocked('busy');
        const rows = (await (await options.repository()).list()).filter(
          (row) => row.family === 'copilot-account',
        );
        if (rows.length) return blocked('unconfirmed');
        if (family.closed || signal?.aborted) return blocked('changed');
        // Durable deletion can precede its acknowledgement to the removal owner.
        if (state.completed?.kind === 'delete')
          completeRemoval(state.completed.epoch);
        const setupReason: AdmissionClosure | undefined =
          state.completed?.kind === 'delete'
            ? `signed-out:${state.completed.epoch}`
            : undefined;
        let m: CopilotGrantMutation = {
          operationId: randomUUID(),
          epoch: randomUUID(),
          account: account(grant),
          origin,
          kind: 'create',
          from: null,
          committed: null,
          probeConfirmed: origin === 'import',
          cancelling: false,
        };
        const predecessor =
          origin === 'setup'
            ? await options.selection.setupPredecessor?.()
            : undefined;
        let witness: CopilotSetupLineageWitness | undefined;
        if (predecessor) {
          const retained = state.setupLineage;
          const prior = retained?.predecessor;
          const samePredecessor =
            prior &&
            prior.pinGeneration === predecessor.pinGeneration &&
            prior.state === predecessor.state &&
            prior.identity.operationId === predecessor.identity.operationId &&
            prior.identity.epoch === predecessor.identity.epoch &&
            prior.identity.origin === predecessor.identity.origin &&
            sameAccount(prior.identity.account, predecessor.identity.account) &&
            (prior.pin === null
              ? predecessor.pin === null
              : predecessor.pin !== null &&
                samePin(prior.pin, predecessor.pin));
          // Only the authenticated witness binds a predecessor; a matching epoch alone does not.
          if (
            predecessor.state !== 'disabled' ||
            state.completed?.kind !== 'delete' ||
            !samePredecessor ||
            (retained.phase !== 'cancelled' && retained.phase !== 'retired')
          )
            return blocked('changed');
          witness = {
            version: 1,
            predecessor,
            successor: { operationId: m.operationId, epoch: m.epoch },
            phase: 'creating',
          };
        }
        const supersededSetups = [...setupClosures.keys()];
        if (family.closed || signal?.aborted) return blocked('changed');
        setupClosures.set(m.operationId, {
          epoch: m.epoch,
          reason: setupReason,
        });
        const cancellation = new AbortController();
        setupCustody.set(m.operationId, {
          epoch: m.epoch,
          grant,
          cancellation,
          signal: signal
            ? AbortSignal.any([signal, cancellation.signal])
            : cancellation.signal,
        });
        onCheckpoint?.(m.operationId);
        if (
          !(await save(state, {
            mutation: m,
            ...(witness
              ? { setupLineage: witness }
              : state.version === 2
                ? { setupLineage: null }
                : {}),
          }))
        ) {
          setupClosures.delete(m.operationId);
          setupCustody.delete(m.operationId);
          return blocked('unconfirmed');
        }
        // The accepted intent fences older attempts that never became durable.
        for (const id of supersededSetups) setupClosures.delete(id);
        if (origin === 'setup') {
          try {
            if (
              family.closed ||
              setupCustody.get(m.operationId)?.signal.aborted
            )
              throw new Error('Copilot setup is unavailable.');
            await options.probe(
              grant.accessToken,
              account(grant),
              AbortSignal.timeout(30_000),
            );
          } catch {
            if (options.selection.abandon) {
              // Retain the journal identity until its prepared receipt is retired.
              setupCustody.delete(m.operationId);
              const latest = await read();
              if (
                latest.mutation?.operationId === m.operationId &&
                !latest.mutation.cancelling
              )
                completeCancellation(
                  m.operationId,
                  await cancel(m.operationId),
                );
              return blocked('unavailable');
            }
            const latest = await read();
            if (latest.mutation?.operationId === m.operationId)
              await save(latest, { mutation: null });
            setupClosures.delete(m.operationId);
            setupCustody.delete(m.operationId);
            return blocked('unavailable');
          }
        }
        if (!m.probeConfirmed) {
          const latest = await read();
          if (
            setupFenced(m) ||
            latest.mutation?.operationId !== m.operationId ||
            latest.mutation.cancelling ||
            cancelling.has(m.operationId)
          )
            return blocked('changed');
          m = { ...m, probeConfirmed: true };
          if (!(await save(latest, { mutation: m }))) return pending(m);
        }
        // Leave accepted intent recoverable by P4, without publishing after quit.
        if (setupFenced(m)) return blocked('changed');
        const stored = await persist(m);
        if (setupFenced(m)) return blocked('changed');
        if (stored.kind === 'blocked') return pending(m);
        return completeSetup(await resume(m.operationId));
      });
    },
    resume: (id) => safe(async () => completeSetup(await resume(id))),
    recipientGeneration: () =>
      !family.closed && admissionClosures.size === 0 ? generation : undefined,
    status: () =>
      safe(async () => {
        const state = await read();
        if (state.removal && state.head)
          return pending({
            ...state.head,
            operationId: state.removal.operationId,
            kind: 'remove',
          });
        if (state.mutation) return pending(state.mutation);
        if (
          state.head &&
          state.completed?.kind === 'delete' &&
          state.completed.epoch === state.head.epoch
        )
          return blocked('expired');
        return state.head
          ? { kind: 'ready', head: state.head }
          : blocked('absent');
      }),
    cancel: (id) =>
      safe(async () => completeCancellation(id, await cancel(id))),
    present: (handle, epoch) => {
      const ticket: DemandTicket = { id: ++requestSequence, epoch, generation };
      const current = attempts.get(epoch);
      if (
        current &&
        current.phase !== 'no-result' &&
        current.phase !== 'confirmed'
      )
        ticket.attempt = current;
      demands.add(ticket);
      return safe(() => present(handle, ticket)).finally(() => {
        demands.delete(ticket);
      });
    },
    revoke: () => {
      closeAdmission('runtime');
    },
    reopen: () => {
      if (family.closed) return;
      admissionClosures.delete('runtime');
      generation++;
    },
    remove,
    demand: () => safe(demand),
    removePending: (operationId) =>
      safe(async () => {
        const state = await read();
        if (
          !state.head ||
          (state.mutation?.operationId !== operationId &&
            state.removal?.operationId !== operationId)
        )
          return blocked('changed');
        return remove(state.head.epoch, operationId);
      }),
    quiesce,
  };
}
