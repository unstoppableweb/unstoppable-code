import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseAuthoritativeOrganizationSnapshot } from '@canopy/protocol/canopy-server/account-snapshot';
import type {
  CloudAccountCustody,
  CloudAccountCustodyCommit,
  CloudAccountCustodyDocument,
  CloudAccountCustodyPin,
  CloudAccountCustodyUnavailable,
  CloudAccountProvenance,
} from './custody';
import { withConnectReceipt } from './custody';
import { organizationMembershipIds } from './organization-loss';
import {
  cloudAccountDiffersBeyondUpdatedAt,
  hasCloudAccountCredential,
  hasCloudAccountIdentityChanged,
  isGuestCloudAccount,
  matchesCloudAccountTransition,
  readCloudAccountRecord,
  type CloudAccountEntryJson,
  type CloudAccountRecord,
} from './record';
import {
  CloudAccountOperationQueue,
  CloudAccountOperationQueueTimeoutError,
  CloudAccountSessionStatus,
  type CloudAccountSessionProbe,
} from './session';

/** Sole writer of this daemon's record; client sign-in records are independent. */

export type CloudAccountAuthorityFailure =
  /** This daemon has not been provisioned. */
  | { readonly kind: 'inactive' }
  | {
      readonly kind: 'unavailable';
      /** `busy`: another operation held the queue; nothing was attempted. */
      readonly reason:
        | CloudAccountCustodyUnavailable
        | 'outcome_unknown'
        | 'busy';
    };

export interface CloudAccountAuthoritySnapshot {
  readonly record: CloudAccountRecord | null;
  readonly credentialGeneration: number;
  readonly sessionExpired: boolean;
  readonly provenance?: CloudAccountProvenance;
}

export type CloudAccountAuthorityRead =
  | ({ readonly kind: 'ok' } & CloudAccountAuthoritySnapshot)
  | CloudAccountAuthorityFailure;

export type CloudAccountRefreshSaveResult =
  | {
      readonly kind: 'saved';
      readonly record: CloudAccountRecord;
      /** False when only the save time moved: a confirmation, not a change. */
      readonly changed: boolean;
    }
  | { readonly kind: 'superseded'; readonly record: CloudAccountRecord | null }
  | { readonly kind: 'invalid' }
  | CloudAccountAuthorityFailure;

export type CloudAccountRejectionResult =
  | { readonly kind: 'recorded' }
  /** The rejected generation is no longer current; nothing changed. */
  | { readonly kind: 'stale' }
  | CloudAccountAuthorityFailure;

export type CloudAccountResetResult =
  /** Custody is readable; nothing was reset, as in the app. */
  | { readonly kind: 'not-needed'; readonly record: CloudAccountRecord | null }
  | { readonly kind: 'reset' }
  | CloudAccountAuthorityFailure;

export type CloudAccountProvisionResult =
  | {
      readonly kind: 'provisioned' | 'unchanged' | 'cleared';
      readonly credentialGeneration: number;
    }
  /** The held credential is not the one the client expected. */
  | { readonly kind: 'superseded' }
  | { readonly kind: 'invalid' }
  /** Never `inactive`: provisioning creates the record. */
  | CloudAccountAuthorityFailure;

export interface CloudAccountAuthorityEvents {
  /** Account content changed, including sign-out. */
  onChange?(record: CloudAccountRecord | null): void;
  /** A refresh confirmed the stored account without changing it. */
  onConfirm?(): void;
  /** Session expiry flipped for the current credential. */
  onSessionStatus?(): void;
}

export interface CloudAccountAuthority {
  read(options?: {
    /** Reconciliation must observe issued writes even after their caller cancels. */
    readonly settleMutations?: boolean;
  }): Promise<CloudAccountAuthorityRead>;
  /** Clear/reset withdraws broker routes, including in-flight requests. */
  onCustodyInvalidated?(listener: () => void): () => void;
  /** Retires request headers on account changes, session refusal or uncertain writes. */
  onAccountChanged(listener: () => void): () => void;
  /** Process-local probe fence, captured before the network request. */
  beginProbe(): CloudAccountSessionProbe;
  /** A credential write, or a probe result (a same-key sign-in's included) begun after `probe`. */
  isProbeSuperseded(probe: CloudAccountSessionProbe): boolean;
  /**
   * A client's sign-in becomes this daemon's own record (CAN-6997): created
   * on first use, replaced or cleared after, fenced by the credential digest
   * and optional generation the client last observed. Known client rejection
   * is imported, never acceptance. The client's loss handoff stays the client's.
   */
  provision(
    entry: CloudAccountEntryJson | null,
    expectedCredentialDigest: string | null,
    signal?: AbortSignal,
    expectedCredentialGeneration?: number,
    credentialRejected?: boolean,
  ): Promise<CloudAccountProvisionResult>;
  /**
   * Register/join before probing. Successful receipts survive replacement and
   * restart. `signal` ends only this caller's wait; the joined command, and
   * the signal `verify` receives, stop once every waiting caller has left.
   * `verify` runs a second time when a newer result for the held key
   * committed while it probed.
   */
  connectVerified(input: {
    readonly commandId: string;
    readonly credentialDigest: string;
    readonly signal: AbortSignal;
    readonly verify: (
      previous: CloudAccountRecord | null,
      credentialGeneration: number,
      probe: CloudAccountSessionProbe,
      signal: AbortSignal,
    ) => Promise<CloudAccountEntryJson>;
  }): Promise<
    | CloudAccountProvisionResult
    | { readonly kind: 'guest-protected' }
    /** A newer committed result refused the key; nothing was installed. */
    | { readonly kind: 'credential-rejected' }
  >;
  /** Refresh: persists only while the probed account is still current. */
  saveIfUnchanged(
    entry: CloudAccountEntryJson,
    expected: CloudAccountRecord,
    options?: {
      readonly probe?: CloudAccountSessionProbe;
      readonly organizationsRefreshed?: boolean;
      readonly signal?: AbortSignal;
    },
  ): Promise<CloudAccountRefreshSaveResult>;
  /** Records a definitive probe outcome for the credential still stored. */
  applyProbeResult(
    expected: CloudAccountRecord,
    probe: CloudAccountSessionProbe,
    outcome: 'accepted' | 'rejected' | 'forbidden' | 'unknown',
    signal?: AbortSignal,
  ): Promise<CloudAccountRejectionResult>;
  /** Broker/sign-in refusal, fenced to the credential generation the request used. */
  recordCredentialRejected(
    credentialGeneration: number,
    outcome?: 'rejected' | 'forbidden' | 'unknown',
    probe?: CloudAccountSessionProbe,
  ): Promise<CloudAccountRejectionResult>;
  /** Clears only unreadable daemon custody; readable records are unchanged. */
  resetUnreadable(signal?: AbortSignal): Promise<CloudAccountResetResult>;
}

type Held =
  | {
      readonly kind: 'ok';
      readonly document: CloudAccountCustodyDocument;
      readonly pin: CloudAccountCustodyPin;
    }
  | CloudAccountAuthorityFailure;

/** SHA-256 of a credential: what clients may see of it. */
export function cloudAccountCredentialDigest(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

function failure(
  commit: CloudAccountCustodyCommit,
): CloudAccountAuthorityFailure {
  if (commit.kind === 'unavailable')
    return { kind: 'unavailable', reason: commit.reason };
  return { kind: 'unavailable', reason: 'outcome_unknown' };
}

/** Errors pass through unchanged; any other reason becomes `message`. */
function rejectionError(reason: unknown, message: string): Error {
  return reason instanceof Error ? reason : new Error(message);
}

export function cloudAccountSnapshotProvenance(
  record: CloudAccountRecord,
  credentialGeneration: number,
): CloudAccountProvenance {
  // Verification describes an account; one custody cannot identify proves
  // nothing, and its membership has no checkpoint to fence on.
  const identified = record.accountId !== null;
  const membership =
    identified &&
    record.entry.organizationsVerified === true &&
    parseAuthoritativeOrganizationSnapshot(record.entry.organizations) !== null;
  return {
    credentialGeneration,
    credential:
      record.entry.modelPolicyVerified === true && membership
        ? 'accepted'
        : 'unknown',
    membership,
    policy:
      identified &&
      record.entry.modelPolicyVerified === true &&
      !record.modelPolicyEnforcementUnavailable,
  };
}

export function createCloudAccountAuthority(options: {
  readonly custody: CloudAccountCustody;
  readonly events?: CloudAccountAuthorityEvents;
  readonly now?: () => Date;
  readonly queueTimeoutMs?: number;
}): CloudAccountAuthority {
  const { custody } = options;
  const events = options.events ?? {};
  const now = options.now ?? ((): Date => new Date());
  const queue = new CloudAccountOperationQueue(options.queueTimeoutMs);
  const invalidationListeners = new Set<() => void>();
  const accountChangeListeners = new Set<() => void>();
  // Counts notices so a write can tell whether one already covered it.
  let accountNotices = 0;
  const accountChanged = (): void => {
    accountNotices++;
    for (const listener of accountChangeListeners) emit(listener);
  };
  const unverifiedDigests = new Map<string, number>();
  // Refusal takes effect even when its durable write is queued or busy.
  const pendingRefusals = new Map<number, number>();
  // Per generation, the newest observation whose policy save did not commit:
  // the stored policy may be older than what Cloud answered.
  const unavailablePolicyGenerations = new Map<number, number>();
  function markPolicyUnavailable(generation: number, sequence: number): void {
    unavailablePolicyGenerations.set(
      generation,
      Math.max(sequence, unavailablePolicyGenerations.get(generation) ?? -1),
    );
  }
  /**
   * After a committed write at `generation`: earlier generations' markers no
   * longer apply. `settled` clears this generation's marker; returns whether
   * one was cleared.
   */
  function settlePolicyMarkers(generation: number, settled: boolean): boolean {
    for (const marked of unavailablePolicyGenerations.keys())
      if (marked < generation) unavailablePolicyGenerations.delete(marked);
    return settled && unavailablePolicyGenerations.delete(generation);
  }
  // Explicit sign-ins order among themselves only, by when each began probing.
  let signInsBegun = 0;
  let newestCommittedSignIn = 0;
  function confirm(generation: number, probe: CloudAccountSessionProbe): void {
    if (probe.sequence > (pendingRefusals.get(generation) ?? -1))
      pendingRefusals.delete(generation);
  }
  function distrust(
    record: CloudAccountRecord,
    probe: CloudAccountSessionProbe,
  ): void {
    const digest = cloudAccountCredentialDigest(record.apiKey);
    unverifiedDigests.set(
      digest,
      Math.max(probe.sequence, unverifiedDigests.get(digest) ?? -1),
    );
  }
  function confirmSnapshot(
    record: CloudAccountRecord,
    generation: number,
    probe: CloudAccountSessionProbe,
  ): void {
    confirm(generation, probe);
    const proof = cloudAccountSnapshotProvenance(record, generation);
    const digest = cloudAccountCredentialDigest(record.apiKey);
    // A queued older success cannot erase newer evidence whose write failed.
    if (
      proof.credential === 'accepted' &&
      proof.membership &&
      proof.policy &&
      probe.sequence > (unverifiedDigests.get(digest) ?? -1)
    )
      unverifiedDigests.delete(digest);
  }
  const invalidateCustody = (): void => {
    for (const listener of invalidationListeners) emit(listener);
  };
  const session = new CloudAccountSessionStatus<CloudAccountRecord, string>(
    (record) => (hasCloudAccountCredential(record) ? record.apiKey : null),
    (left, right) => left === right,
  );
  session.addListener(() => {
    accountChanged();
    events.onSessionStatus?.();
  });

  const emit = (run: () => void): void => {
    try {
      run();
    } catch {
      // Account persistence must never fail because a subscriber failed.
    }
  };

  let generationFloor = 0;
  async function readCustody(): ReturnType<CloudAccountCustody['read']> {
    const read = await custody.read();
    if (read.kind === 'ok')
      generationFloor = Math.max(
        generationFloor,
        read.document.credentialGeneration,
      );
    return read;
  }

  async function held(): Promise<Held> {
    const read = await readCustody();
    if (read.kind === 'absent') return { kind: 'inactive' };
    if (read.kind === 'unavailable')
      return { kind: 'unavailable', reason: read.reason };
    return read;
  }

  function retainCredentialRejection(
    current: CloudAccountCustodyDocument | undefined,
    credentialChanged: boolean,
    next: CloudAccountProvenance,
  ): CloudAccountProvenance {
    // Policy uncertainty is not successful authentication.
    return !credentialChanged &&
      next.credential !== 'accepted' &&
      (current?.provenance?.credential === 'rejected' ||
        session.isExpired(current?.record ?? null))
      ? { ...next, credential: 'rejected' }
      : next;
  }

  async function persist(
    current: Extract<Held, { kind: 'ok' }>,
    record: CloudAccountRecord | null,
    credentialChanged: boolean,
    signal?: AbortSignal,
    provenance = current.document.provenance,
  ): Promise<
    | {
        readonly kind: 'committed';
        readonly document: CloudAccountCustodyDocument;
        readonly pin: CloudAccountCustodyPin;
      }
    | { readonly kind: 'superseded' }
    | CloudAccountAuthorityFailure
  > {
    const commit = await custody.commit({
      expected: current.pin,
      state: 'active',
      connectReceipts: current.document.connectReceipts ?? {},
      ...(signal ? { signal } : {}),
      credentialGeneration:
        current.document.credentialGeneration + (credentialChanged ? 1 : 0),
      record,
      ...(provenance
        ? {
            provenance: retainCredentialRejection(
              current.document,
              credentialChanged,
              provenance,
            ),
          }
        : {}),
    });
    if (commit.kind === 'committed') {
      if (credentialChanged) session.resetCredential();
      return { kind: 'committed', document: commit.document, pin: commit.pin };
    }
    if (commit.kind === 'superseded') return commit;
    if (commit.kind === 'outcome_unknown') accountChanged();
    // The credential may have changed: retire probes begun against the old one.
    if (commit.kind === 'outcome_unknown' && credentialChanged)
      session.invalidateProbes();
    return failure(commit);
  }

  function withMembershipCheckpoint(
    previous: CloudAccountRecord,
    entry: CloudAccountEntryJson,
    organizationsRefreshed: boolean,
  ): CloudAccountRecord | null {
    const parsed = readCloudAccountRecord({
      ...entry,
      organizationAccessLossState: undefined,
    });
    if (!parsed) return null;
    const nextIds = organizationMembershipIds(parsed.entry.organizations);
    // An unverified list (a missing one normalizes to []) keeps the checkpoint.
    const organizationIds =
      organizationsRefreshed &&
      parsed.entry.organizationsVerified === true &&
      nextIds !== null
        ? nextIds
        : (previous.organizationAccessLossState?.organizationIds ??
          organizationMembershipIds(previous.entry.organizations));
    // Daemon membership has no pending-detachment consumer; desktop keeps its
    // independent handoffs. Do not build an unused loss history here.
    return readCloudAccountRecord({
      ...parsed.entry,
      organizationAccessLossState:
        parsed.accountId &&
        parsed.accountId === previous.accountId &&
        organizationIds !== null
          ? {
              version: 1,
              accountId: parsed.accountId,
              organizationIds,
              pending: [],
            }
          : undefined,
    });
  }

  // A queue timeout never started the operation, so it is a retryable typed
  // failure rather than an unknown outcome.
  async function serial<T>(
    run: () => Promise<T>,
  ): Promise<T | CloudAccountAuthorityFailure> {
    try {
      return await queue.run(run);
    } catch (error) {
      if (error instanceof CloudAccountOperationQueueTimeoutError)
        return { kind: 'unavailable', reason: 'busy' };
      throw error;
    }
  }

  /** What readers and authorization subscribers see of `document`. */
  function effective(
    document: CloudAccountCustodyDocument,
  ): Pick<CloudAccountAuthoritySnapshot, 'sessionExpired' | 'provenance'> {
    const { record, credentialGeneration } = document;
    const storedProof =
      document.provenance ??
      (record
        ? cloudAccountSnapshotProvenance(record, credentialGeneration)
        : undefined);
    const provenance: CloudAccountProvenance | undefined =
      storedProof &&
      (pendingRefusals.has(credentialGeneration) ||
        (record &&
          unverifiedDigests.has(cloudAccountCredentialDigest(record.apiKey))))
        ? {
            ...storedProof,
            credential: 'unknown',
            membership: false,
            policy: false,
          }
        : storedProof;
    return {
      sessionExpired:
        session.isExpired(record) ||
        document.provenance?.credential === 'rejected',
      ...(provenance
        ? {
            provenance: unavailablePolicyGenerations.has(credentialGeneration)
              ? { ...provenance, policy: false }
              : provenance,
          }
        : {}),
    };
  }

  /**
   * Runs `settle`, then notifies once when the entry changed (`settle`
   * returns true) or what subscribers see changed without it, such as a
   * recovery after a 403. A notice `settle` raised itself already covers it.
   */
  function settleAndNotify(
    before: CloudAccountCustodyDocument,
    after: CloudAccountCustodyDocument,
    settle: () => boolean,
  ): void {
    const previous = effective(before);
    const notices = accountNotices;
    const entryChanged = settle();
    if (accountNotices !== notices) return;
    if (entryChanged || !isDeepStrictEqual(previous, effective(after)))
      accountChanged();
  }

  async function read(): Promise<CloudAccountAuthorityRead> {
    const current = await held();
    if (current.kind !== 'ok') return current;
    const { record, credentialGeneration } = current.document;
    return {
      kind: 'ok',
      record,
      credentialGeneration,
      ...effective(current.document),
    };
  }

  interface VerifiedConnect {
    readonly commandId: string;
    readonly credentialDigest: string;
    readonly generation: number;
    readonly probe: CloudAccountSessionProbe;
    readonly order: number;
    /** A re-verification: superseded again, it answers without probing. */
    readonly final: boolean;
  }
  type SignInOutcome =
    | CloudAccountProvisionResult
    | { readonly kind: 'credential-rejected' }
    /** Probe again: a newer result for the held key committed meanwhile. */
    | { readonly kind: 'reverify'; readonly previous: CloudAccountRecord };
  function provision(
    entry: CloudAccountEntryJson | null,
    expectedCredentialDigest: string | null,
    signal?: AbortSignal,
    expectedCredentialGeneration?: number,
    credentialRejected = false,
    verified?: VerifiedConnect,
  ): Promise<SignInOutcome> {
    const clientProbe = credentialRejected ? session.begin() : undefined;
    if (verified && entry !== null && session.isCurrent(verified.probe)) {
      const candidate = readCloudAccountRecord(entry);
      const proof = candidate
        ? cloudAccountSnapshotProvenance(candidate, verified.generation)
        : null;
      if (
        !proof ||
        proof.credential !== 'accepted' ||
        !proof.membership ||
        !proof.policy
      ) {
        unverifiedDigests.set(
          verified.credentialDigest,
          Math.max(
            verified.probe.sequence,
            unverifiedDigests.get(verified.credentialDigest) ?? -1,
          ),
        );
        // It withdraws the held key's policy even if the commit then fails.
        if (expectedCredentialDigest === verified.credentialDigest)
          accountChanged();
      }
    }
    return serial(async (): Promise<SignInOutcome> => {
      const next =
        entry === null
          ? null
          : readCloudAccountRecord({
              ...entry,
              organizationAccessLossState: undefined,
            });
      if (entry !== null && !hasCloudAccountCredential(next))
        return { kind: 'invalid' };
      signal?.throwIfAborted();
      const read = await readCustody();
      signal?.throwIfAborted();
      if (read.kind === 'unavailable')
        return { kind: 'unavailable', reason: read.reason };
      const held = read.kind === 'ok' ? read : null;
      const current = held?.document.record ?? null;
      const digest = hasCloudAccountCredential(current)
        ? cloudAccountCredentialDigest(current.apiKey)
        : null;
      if (digest !== expectedCredentialDigest) return { kind: 'superseded' };
      const generation = held?.document.credentialGeneration ?? 0;
      // Digest-only CAS preserves version-skewed clients without new refusals.
      // Generation is required once activation is selected, or once the protocol
      // version guarantees the fence; until then fenceless requests retain ABA risk.
      if (
        expectedCredentialGeneration !== undefined &&
        generation !== expectedCredentialGeneration
      )
        return { kind: 'superseded' };
      // The durable generation and the custody pin admit a sign-in; what was
      // observed about another key never refuses one.
      if (verified && generation !== verified.generation)
        return { kind: 'superseded' };
      // A same-key sign-in keeps the generation, so an older one that finishes
      // probing last must not replace the newer one's snapshot.
      if (verified && verified.order < newestCommittedSignIn)
        return { kind: 'superseded' };
      // For the held key the newest committed probe result wins: a sign-in
      // probed before a newer refresh, 401, 403, uncertain write or failed
      // refresh save re-verifies once instead of installing its older snapshot.
      if (
        verified &&
        next !== null &&
        held !== null &&
        current !== null &&
        next.apiKey === current.apiKey &&
        !hasCloudAccountIdentityChanged(current, next) &&
        (session.isSuperseded(verified.probe) ||
          verified.probe.sequence <
            (unavailablePolicyGenerations.get(generation) ?? -1))
      ) {
        if (!verified.final) return { kind: 'reverify', previous: current };
        // Superseded again: answer from the committed state, never failing
        // for ordering alone. Only the receipt is written.
        if (
          session.isExpired(current) ||
          held.document.provenance?.credential === 'rejected'
        )
          return { kind: 'credential-rejected' };
        signal?.throwIfAborted();
        const answered = await custody.commit({
          expected: held.pin,
          state: 'active',
          credentialGeneration: generation,
          record: current,
          ...(held.document.provenance
            ? { provenance: held.document.provenance }
            : {}),
          connectReceipts: withConnectReceipt(
            held.document.connectReceipts,
            verified.commandId,
            {
              credentialDigest: verified.credentialDigest,
              credentialGeneration: verified.generation,
              completed: true,
            },
          ),
          ...(signal ? { signal } : {}),
        });
        if (answered.kind === 'superseded') return answered;
        if (answered.kind !== 'committed') return failure(answered);
        return { kind: 'unchanged', credentialGeneration: generation };
      }

      // Reconnection is not a policy refresh. Only the daemon's probe may
      // replace a snapshot for the identity and credential it already holds.
      if (
        !verified &&
        next !== null &&
        current !== null &&
        next.apiKey === current.apiKey &&
        !hasCloudAccountIdentityChanged(current, next)
      ) {
        if (clientProbe && held && !session.isSuperseded(clientProbe)) {
          session.record(clientProbe, current, 'rejected');
          accountChanged();
          const saved = await persist(held, current, false, signal, {
            credentialGeneration: generation,
            credential: 'rejected',
            membership: false,
            policy: false,
          });
          if (saved.kind !== 'committed') return saved;
        }
        return { kind: 'unchanged', credentialGeneration: generation };
      }
      const clearingPending =
        next === null &&
        Object.values(held?.document.connectReceipts ?? {}).some(
          (receipt) =>
            !receipt.completed && receipt.credentialGeneration === generation,
        );
      // Even an empty clear fences client provisions still in transit, which
      // have no daemon-side connect receipt. Do not treat it as a no-op.
      if (
        !verified &&
        next !== null &&
        !clearingPending &&
        isDeepStrictEqual(next.entry, current?.entry ?? null) &&
        held !== null
      )
        return { kind: 'unchanged', credentialGeneration: generation };
      const credentialChanged =
        next === null ||
        clearingPending ||
        (next?.apiKey ?? null) !== (current?.apiKey ?? null) ||
        (next !== null && hasCloudAccountIdentityChanged(current, next));
      const credentialGeneration =
        generation + (credentialChanged || held === null ? 1 : 0);
      generationFloor = Math.max(generationFloor, credentialGeneration);
      // Same identity keeps the daemon's checkpoint; only its own verified
      // probe advances it, never a client's organization claims.
      const accepted =
        current && next && !hasCloudAccountIdentityChanged(current, next)
          ? withMembershipCheckpoint(
              current,
              next.entry,
              verified !== undefined,
            )
          : next;
      if (next && !accepted) return { kind: 'invalid' };
      const previousProof =
        held?.document.provenance ??
        (current
          ? cloudAccountSnapshotProvenance(current, generation)
          : undefined);
      const withoutCredential = (
        record: CloudAccountRecord,
      ): CloudAccountEntryJson => ({
        ...record.entry,
        apiKey: undefined,
        updatedAt: undefined,
        organizationAccessLossState: undefined,
      });
      // Only identical policy already held by the daemon survives key rotation.
      // The new key stays unverified: this preserves presentations, not admissions.
      const retainPolicy =
        current !== null &&
        accepted !== null &&
        !credentialRejected &&
        !session.isExpired(current) &&
        !pendingRefusals.has(generation) &&
        !unavailablePolicyGenerations.has(generation) &&
        !unverifiedDigests.has(cloudAccountCredentialDigest(current.apiKey)) &&
        previousProof?.credentialGeneration === generation &&
        (previousProof.credential === 'accepted' ||
          previousProof.credential === 'unknown') &&
        previousProof.membership &&
        previousProof.policy &&
        isDeepStrictEqual(
          withoutCredential(current),
          withoutCredential(accepted),
        );
      signal?.throwIfAborted();
      const commit = await custody.commit({
        expected: held?.pin ?? null,
        state: 'active',
        credentialGeneration,
        record: accepted,
        // Explicit sign-in authenticates even when its policy is still unknown.
        // Client verification flags alone are not daemon probe evidence.
        provenance:
          accepted && verified
            ? cloudAccountSnapshotProvenance(accepted, credentialGeneration)
            : retainCredentialRejection(held?.document, credentialChanged, {
                credentialGeneration,
                credential:
                  accepted && credentialRejected ? 'rejected' : 'unknown',
                membership: retainPolicy,
                policy: retainPolicy,
              }),
        connectReceipts: verified
          ? withConnectReceipt(
              held?.document.connectReceipts,
              verified.commandId,
              {
                credentialDigest: verified.credentialDigest,
                credentialGeneration: verified.generation,
                completed: true,
              },
            )
          : (held?.document.connectReceipts ?? {}),
        ...(signal ? { signal } : {}),
      });
      if (commit.kind === 'superseded') return { kind: 'superseded' };
      if (commit.kind !== 'committed') {
        if (commit.kind === 'outcome_unknown') accountChanged();
        if (commit.kind === 'outcome_unknown' && credentialChanged) {
          session.invalidateProbes();
          const latest = await readCustody();
          if (
            latest.kind === 'ok' &&
            latest.document.record?.apiKey !== current?.apiKey
          ) {
            session.resetCredential();
            if (!latest.document.record) invalidateCustody();
          }
        }
        return commit.kind === 'unavailable'
          ? { kind: 'unavailable', reason: commit.reason }
          : { kind: 'unavailable', reason: 'outcome_unknown' };
      }
      if (verified && accepted) {
        // A new key starts a new probe order. The same key keeps its order: a
        // result that began probing after this sign-in still lands after it.
        if (credentialChanged) session.resetCredential();
        const result = credentialChanged ? session.begin() : verified.probe;
        confirmSnapshot(accepted, credentialGeneration, result);
        session.record(result, accepted, 'accepted');
        newestCommittedSignIn = Math.max(newestCommittedSignIn, verified.order);
        // It also retires a failed refresh save's marker: the fence above
        // made the snapshot just committed the newest this daemon holds.
        settlePolicyMarkers(credentialGeneration, true);
      } else {
        settlePolicyMarkers(credentialGeneration, false);
        if (credentialChanged) session.resetCredential();
        if (accepted && credentialRejected)
          session.record(session.begin(), accepted, 'rejected');
      }
      accountChanged();
      emit(() => events.onChange?.(accepted));
      if (!accepted) invalidateCustody();
      return {
        kind: next === null ? 'cleared' : 'provisioned',
        credentialGeneration,
      };
    });
  }

  interface RegisteredConnect {
    readonly kind: 'registered';
    readonly previous: CloudAccountRecord | null;
    readonly generation: number;
  }
  type ConnectInput = Parameters<CloudAccountAuthority['connectVerified']>[0];
  type ConnectOutcome = Awaited<
    ReturnType<CloudAccountAuthority['connectVerified']>
  >;
  const registerConnect = (
    input: ConnectInput,
    signal: AbortSignal,
  ): Promise<RegisteredConnect | ConnectOutcome> =>
    serial(async () => {
      signal.throwIfAborted();
      const before = await readCustody();
      signal.throwIfAborted();
      if (before.kind === 'unavailable') return before;
      const document = before.kind === 'ok' ? before.document : undefined;
      const generation = document?.credentialGeneration ?? 0;
      const previous = document?.record ?? null;
      const receipt = document?.connectReceipts?.[input.commandId];
      if (receipt) {
        if (receipt.credentialDigest !== input.credentialDigest)
          return { kind: 'superseded' };
        if (receipt.completed)
          return { kind: 'unchanged', credentialGeneration: generation };
        if (receipt.credentialGeneration !== generation)
          return { kind: 'superseded' };
      }
      // Refused before its receipt, so a refusal leaves custody untouched.
      if (previous && isGuestCloudAccount(previous))
        return { kind: 'guest-protected' };
      // Persist before probing: a retained interrupted command cannot retry
      // against a newer account state. A retry is rewritten as the newest
      // receipt, so pruning cannot drop the fence of a command still in use.
      const receiptOrder = Object.keys(document?.connectReceipts ?? {});
      if (receiptOrder[receiptOrder.length - 1] !== input.commandId) {
        const commit = await custody.commit({
          expected: before.kind === 'ok' ? before.pin : null,
          state: 'active',
          record: previous,
          credentialGeneration: generation,
          ...(document?.provenance ? { provenance: document.provenance } : {}),
          connectReceipts: withConnectReceipt(
            document?.connectReceipts,
            input.commandId,
            {
              credentialDigest: input.credentialDigest,
              credentialGeneration: generation,
              completed: false,
            },
          ),
          signal,
        });
        if (commit.kind === 'superseded') return commit;
        if (commit.kind !== 'committed') return failure(commit);
      }
      return { kind: 'registered', previous, generation };
    });

  interface ConnectCommand {
    readonly digest: string;
    /** The command's own lifetime: aborted only when no caller still waits. */
    readonly lifetime: AbortController;
    waiters: number;
    readonly promise: Promise<ConnectOutcome>;
  }
  const commands = new Map<string, ConnectCommand>();

  async function runConnect(
    input: ConnectInput,
    signal: AbortSignal,
  ): Promise<ConnectOutcome> {
    const registered = await registerConnect(input, signal);
    if (registered.kind !== 'registered') return registered;
    const { generation } = registered;
    let { previous } = registered;
    // A re-verification keeps the sign-in's order: re-probing must not make
    // it outrank a newer sign-in.
    const order = ++signInsBegun;
    for (let final = false; ; final = true) {
      signal.throwIfAborted();
      const probe = session.begin();
      const entry = await input.verify(previous, generation, probe, signal);
      signal.throwIfAborted();
      const outcome = await provision(
        entry,
        hasCloudAccountCredential(previous)
          ? cloudAccountCredentialDigest(previous.apiKey)
          : null,
        signal,
        generation,
        false,
        {
          commandId: input.commandId,
          credentialDigest: input.credentialDigest,
          generation,
          probe,
          order,
          final,
        },
      );
      if (outcome.kind !== 'reverify') return outcome;
      previous = outcome.previous;
    }
  }

  function startConnect(input: ConnectInput): ConnectCommand {
    const lifetime = new AbortController();
    const command: ConnectCommand = {
      digest: input.credentialDigest,
      lifetime,
      waiters: 0,
      promise: runConnect(input, lifetime.signal),
    };
    commands.set(input.commandId, command);
    // Registration and success are durable. While retained, failed commands
    // retry only against their original generation, never against a later
    // replacement/disconnect. Unknown outcomes stay joined until restart,
    // which consults the atomic receipt. Explicit unreadable reset loses
    // unreadable receipts along with custody.
    const settle = (retain: boolean): void => {
      if (!retain && commands.get(input.commandId) === command)
        commands.delete(input.commandId);
    };
    void command.promise.then(
      (outcome) =>
        settle(
          outcome.kind === 'unavailable' &&
            outcome.reason === 'outcome_unknown',
        ),
      () => settle(false),
    );
    return command;
  }

  /** One caller's wait: its signal ends only its own wait. */
  function awaitConnect(
    command: ConnectCommand,
    input: ConnectInput,
  ): Promise<ConnectOutcome> {
    const { signal } = input;
    command.waiters += 1;
    return new Promise<ConnectOutcome>((resolve, reject) => {
      let waiting = true;
      const onAbort = (): void => {
        if (!waiting) return;
        waiting = false;
        command.waiters -= 1;
        // The last caller to leave stops the command. Custody checks the
        // signal only before a write starts, so nothing is left half-written.
        if (command.waiters === 0) command.lifetime.abort(signal.reason);
        reject(rejectionError(signal.reason, 'The sign-in was cancelled.'));
      };
      const settled = (): boolean => {
        signal.removeEventListener('abort', onAbort);
        if (!waiting) return false;
        waiting = false;
        command.waiters -= 1;
        return true;
      };
      signal.addEventListener('abort', onAbort, { once: true });
      command.promise.then(
        (outcome) => {
          if (settled()) resolve(outcome);
        },
        (error: unknown) => {
          if (!settled()) return;
          // Callers that all left stopped it before a write: resume the
          // durable registration for this caller instead of their abort.
          if (command.lifetime.signal.aborted) resolve(connect(input));
          else reject(rejectionError(error, 'The sign-in failed.'));
        },
      );
    });
  }

  function connect(input: ConnectInput): Promise<ConnectOutcome> {
    const pending = commands.get(input.commandId);
    if (pending && pending.digest !== input.credentialDigest)
      return Promise.resolve({ kind: 'superseded' });
    if (input.signal.aborted)
      return Promise.reject(
        rejectionError(input.signal.reason, 'The sign-in was cancelled.'),
      );
    return awaitConnect(pending ?? startConnect(input), input);
  }

  const authority: CloudAccountAuthority = {
    read: (readOptions) =>
      readOptions?.settleMutations ? serial(read) : read(),
    onAccountChanged: (listener) => {
      accountChangeListeners.add(listener);
      return () => {
        accountChangeListeners.delete(listener);
      };
    },
    onCustodyInvalidated: (listener) => {
      invalidationListeners.add(listener);
      return () => {
        invalidationListeners.delete(listener);
      };
    },
    beginProbe: () => session.begin(),
    isProbeSuperseded: (probe) => session.isSuperseded(probe),

    provision: async (...args) => {
      const outcome = await provision(...args);
      // Only verified sign-ins re-verify or answer from committed state.
      return outcome.kind === 'reverify' ||
        outcome.kind === 'credential-rejected'
        ? { kind: 'superseded' }
        : outcome;
    },
    connectVerified: connect,

    saveIfUnchanged: (entry, expected, saveOptions = {}) => {
      // Order even probe-less observations before queueing their writes.
      const observation = saveOptions.probe ?? session.begin();
      if (saveOptions.probe && session.isCurrent(saveOptions.probe)) {
        const candidate = readCloudAccountRecord(entry);
        const proof = candidate
          ? cloudAccountSnapshotProvenance(candidate, 0)
          : null;
        if (
          !candidate ||
          candidate.apiKey !== expected.apiKey ||
          hasCloudAccountIdentityChanged(expected, candidate) ||
          !proof ||
          proof.credential !== 'accepted' ||
          !proof.membership ||
          !proof.policy
        ) {
          distrust(expected, saveOptions.probe);
          accountChanged();
        }
      }
      return serial(async (): Promise<CloudAccountRefreshSaveResult> => {
        saveOptions.signal?.throwIfAborted();
        const current = await held();
        saveOptions.signal?.throwIfAborted();
        if (current.kind !== 'ok') return current;
        const previous = current.document.record;
        if (
          (saveOptions.probe && session.isSuperseded(saveOptions.probe)) ||
          observation.sequence <
            (unavailablePolicyGenerations.get(
              current.document.credentialGeneration,
            ) ?? -1) ||
          !matchesCloudAccountTransition(previous, expected)
        )
          return { kind: 'superseded', record: previous };
        const next = withMembershipCheckpoint(
          previous ?? expected,
          entry,
          saveOptions.organizationsRefreshed === true,
        );
        // A refresh must never carry a different credential or identity.
        if (
          !next ||
          next.apiKey !== expected.apiKey ||
          hasCloudAccountIdentityChanged(expected, next)
        ) {
          if (session.isCurrent(observation)) {
            distrust(expected, observation);
            accountChanged();
            // An observation orders other observations; it never retires a
            // newer probe or a sign-in. Only credential writes retire probes.
            session.observe(observation);
            const saved = await persist(
              current,
              previous,
              false,
              saveOptions.signal,
              {
                credentialGeneration: current.document.credentialGeneration,
                credential: 'unknown',
                membership: false,
                policy: false,
              },
            );
            if (saved.kind === 'superseded')
              return { kind: 'superseded', record: previous };
            if (saved.kind !== 'committed') return saved;
          }
          return { kind: 'invalid' };
        }
        const changed = cloudAccountDiffersBeyondUpdatedAt(next, previous);
        const write = (): ReturnType<typeof persist> =>
          persist(
            current,
            next,
            false,
            saveOptions.signal,
            saveOptions.probe
              ? cloudAccountSnapshotProvenance(
                  next,
                  current.document.credentialGeneration,
                )
              : session.isExpired(previous)
                ? {
                    // Repair a failed refusal write without authenticating.
                    credentialGeneration: current.document.credentialGeneration,
                    credential: 'rejected',
                    membership: false,
                    policy: false,
                  }
                : current.document.provenance &&
                    current.document.provenance.credential !== 'accepted'
                  ? {
                      ...current.document.provenance,
                      membership:
                        current.document.provenance.membership && !changed,
                      policy: current.document.provenance.policy && !changed,
                    }
                  : cloudAccountSnapshotProvenance(
                      next,
                      current.document.credentialGeneration,
                    ),
          );
        const outcome = await write();
        if (outcome.kind === 'superseded')
          return { kind: 'superseded', record: previous };
        if (outcome.kind !== 'committed') {
          // A newly observed policy cannot leave the previous allow in force.
          markPolicyUnavailable(
            current.document.credentialGeneration,
            observation.sequence,
          );
          accountChanged();
          return outcome;
        }
        settleAndNotify(current.document, outcome.document, () => {
          // Older observations were refused above, so this one is the newest.
          const policyWasUnavailable = settlePolicyMarkers(
            current.document.credentialGeneration,
            true,
          );
          if (saveOptions.probe) {
            session.record(saveOptions.probe, next, 'accepted');
            confirmSnapshot(
              next,
              current.document.credentialGeneration,
              saveOptions.probe,
            );
          }
          return changed || policyWasUnavailable;
        });
        emit(() => (changed ? events.onChange?.(next) : events.onConfirm?.()));
        return { kind: 'saved', record: next, changed };
      });
    },

    applyProbeResult: async (
      expected,
      probe,
      outcome,
      signal,
    ): Promise<CloudAccountRejectionResult> => {
      if (outcome !== 'accepted' && session.isCurrent(probe)) {
        distrust(expected, probe);
        accountChanged();
      }
      return serial(async (): Promise<CloudAccountRejectionResult> => {
        signal?.throwIfAborted();
        if (!session.isCurrent(probe)) return { kind: 'stale' };
        const current = await held();
        signal?.throwIfAborted();
        if (current.kind !== 'ok') return current;
        const record = current.document.record;
        // Refusals concern the credential, not the snapshot's save timestamp.
        // The probe fence retires replacements and orders same-key outcomes.
        if (
          !record ||
          record.apiKey !== expected.apiKey ||
          hasCloudAccountIdentityChanged(expected, record)
        )
          return { kind: 'stale' };
        if (outcome !== 'accepted') accountChanged();
        if (outcome === 'accepted' || outcome === 'rejected')
          session.record(probe, record, outcome);
        else session.observe(probe);

        const saved = await persist(current, record, false, signal, {
          credentialGeneration: current.document.credentialGeneration,
          credential: outcome,
          membership: false,
          policy: false,
        });
        if (saved.kind === 'superseded') return { kind: 'stale' };
        if (saved.kind !== 'committed') return saved;
        // Acceptance alone can still withdraw membership and policy.
        if (outcome === 'accepted')
          settleAndNotify(current.document, saved.document, () => false);
        return { kind: 'recorded' };
      });
    },

    recordCredentialRejected: (
      credentialGeneration,
      outcome = 'rejected',
      refusalProbe = session.begin(),
    ) => {
      if (session.isSuperseded(refusalProbe))
        return Promise.resolve({ kind: 'stale' });
      pendingRefusals.set(
        credentialGeneration,
        Math.max(
          pendingRefusals.get(credentialGeneration) ?? -1,
          refusalProbe.sequence,
        ),
      );
      // Withdraw presentations before waiting for persistence; stale refusals
      // must not strip a newer generation's headers.
      if (credentialGeneration === generationFloor) accountChanged();
      return serial(async (): Promise<CloudAccountRejectionResult> => {
        const current = await held();
        if (current.kind !== 'ok') return current;
        const record = current.document.record;
        if (
          current.document.credentialGeneration !== credentialGeneration ||
          !hasCloudAccountCredential(record) ||
          session.isSuperseded(refusalProbe)
        ) {
          // Its withdrawal was announced, so its retraction is too.
          settleAndNotify(current.document, current.document, () => {
            if (
              pendingRefusals.get(credentialGeneration) ===
              refusalProbe.sequence
            )
              pendingRefusals.delete(credentialGeneration);
            return false;
          });
          return { kind: 'stale' };
        }
        accountChanged();
        if (outcome === 'rejected')
          session.record(refusalProbe, record, 'rejected');
        else session.observe(refusalProbe);

        const saved = await persist(current, record, false, undefined, {
          credentialGeneration,
          credential: outcome,
          membership: false,
          policy: false,
        });
        if (saved.kind === 'superseded') return { kind: 'stale' };
        return saved.kind === 'committed' ? { kind: 'recorded' } : saved;
      });
    },

    resetUnreadable: (signal) =>
      serial(async (): Promise<CloudAccountResetResult> => {
        const current = await held();
        if (current.kind === 'ok')
          return { kind: 'not-needed', record: current.document.record };
        if (current.kind === 'inactive') return current;
        // Time separates unreadable old custody; the floor fences same-tick resets.
        const generation = Math.max(now().getTime(), generationFloor + 1);
        generationFloor = generation;
        const write = (): ReturnType<CloudAccountCustody['resetUnreadable']> =>
          custody.resetUnreadable(generation, signal);
        const outcome = await write();
        switch (outcome.kind) {
          case 'committed':
            settlePolicyMarkers(generation, false);
            session.resetCredential();
            accountChanged();
            invalidateCustody();
            emit(() => events.onChange?.(null));
            return { kind: 'reset' };
          case 'readable': {
            const latest = await held();
            return latest.kind === 'ok'
              ? { kind: 'not-needed', record: latest.document.record }
              : latest;
          }
          case 'absent':
            return { kind: 'inactive' };
          case 'superseded':
            return { kind: 'unavailable', reason: 'outcome_unknown' };
          case 'unavailable':
          case 'outcome_unknown':
            if (outcome.kind === 'outcome_unknown') {
              session.invalidateProbes();
              accountChanged();
            }
            return failure(outcome);
        }
      }),
  };
  return authority;
}
