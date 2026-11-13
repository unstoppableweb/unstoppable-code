/** Product caps on agent-started work. */
export const AGENT_ACTION_LIMITS = {
  perParentTurn: 5,
  perUserPerHour: 20,
  maxDepth: 2,
} as const;

export interface AgentActionLimitValues {
  perParentTurn: number;
  perUserPerHour: number;
  maxDepth: number;
}

/** Work that counts against the limits. Spawning kinds also check depth. */
export type AgentActionLimitKind =
  | 'installed_items.set_status'
  | 'installed_items.uninstall'
  | 'chat.create'
  | 'chat.send_message'
  | 'fork'
  | 'experiments.set_enabled'
  /** Keys pipeline.run receipts; its family takes no limits reservation. */
  | 'pipeline.run'
  /** Key chat control receipts; stopping work takes no reservation. */
  | 'chat.interrupt'
  | 'chat.cancel'
  | 'chat.archive';

export type AgentActionLimitReason = 'per_turn' | 'per_hour' | 'depth';

export interface AgentActionLimitRequest {
  kind: AgentActionLimitKind;
  turnKey: string;
  actorKey: string;
  /** The calling chat; a turn counts per chat. */
  parentChatId: string;
  /** Spawn depth of the calling chat; user-started chats are depth 0. */
  parentDepth: number;
  /**
   * The idempotency key of the write the reservation covers. A port that
   * already holds a reservation for this actor and key returns it without
   * counting it again, so a retried tool call never takes a second slot.
   * The same key from another actor is a new reservation.
   */
  idempotencyKey: string;
  /** The attempt asking; a new reservation is owned by this attempt. */
  attemptId: string;
}

export type AgentActionLimitReservation =
  | {
      ok: true;
      /**
       * The attempt that owns the reservation: the requesting attempt, which
       * takes over a reservation an earlier attempt of the same key held.
       */
      ownerAttemptId: string;
      /**
       * Records that the write happened, from any attempt and in any order:
       * the reservation becomes permanent and counts. A reservation already
       * released (by the attempt that took it over) is counted again under
       * its key, turn, actor, and original time, even past a cap: caps are
       * enforced at reserve time. Idempotent per key.
       */
      commit(): Promise<void>;
      /**
       * Records that the write may have happened (its outcome is unknown),
       * from any attempt and in any order: the reservation becomes
       * uncertain. An uncertain reservation keeps counting through every
       * later takeover and release, and the mark moves with the
       * reservation when another attempt takes it over. A reservation
       * already released is counted again under its key, turn, actor, and
       * original time, as `commit` does. Only `commit` settles it, counting
       * it once; otherwise it counts until the port's retention for the key
       * ends. Idempotent per key.
       */
      markUncertain(): Promise<void>;
      /**
       * Frees the reservation when its write did not happen: only when the
       * requesting attempt still owns it, no attempt has committed it, and
       * no attempt has marked it uncertain. A superseded attempt's release
       * frees nothing.
       */
      release(): Promise<void>;
    }
  | { ok: false; reason: AgentActionLimitReason; limit: number };

/**
 * Reserves capacity before an action writes. Reservations are held per
 * actor and idempotency key and owned by the attempt that took them. A
 * reservation counts until its owner releases it, which it does only when
 * its write did not happen; once committed or marked uncertain it is never
 * released, and a commit or uncertain mark after a release counts the write
 * again. Reserving
 * a key the port already holds for the same actor returns the held
 * reservation without counting it again or applying any limit, even after
 * the parent chat started another turn; an uncommitted one passes to the
 * requesting attempt, and from then on only that attempt's release frees it. A port holds a key at least for
 * the hourly window. Each turn of a parent chat (`parentChatId`, `turnKey`)
 * keeps its own count: a reservation for one turn never changes another
 * turn's count, whatever order turns reserve in. A port keeps a turn's
 * count at least {@link AGENT_ACTION_TURN_RETENTION_MS} after its last
 * reservation, independent of the hourly window.
 */
export interface AgentActionLimitsPort {
  reserve(
    request: AgentActionLimitRequest,
  ): Promise<AgentActionLimitReservation>;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * How long a turn's per-turn count is kept after its last reservation. Much
 * longer than the hourly window, so a late call from an older turn finds
 * that turn's own count.
 */
export const AGENT_ACTION_TURN_RETENTION_MS = 24 * HOUR_MS;

/** The most turns an in-memory port keeps per parent chat. */
export const AGENT_ACTION_TURNS_KEPT_PER_CHAT = 200;

export function isAgentSpawnKind(kind: AgentActionLimitKind): boolean {
  return kind === 'chat.create' || kind === 'fork';
}

interface InMemoryClaim {
  owner: string;
  committed: boolean;
  /** Its write may have happened; no release frees it. */
  uncertain: boolean;
  free(): void;
  /**
   * Applies a settlement to the reservation that counts its key, counting
   * the write once more if it was released.
   */
  settle(mark: (claim: InMemoryClaim) => void): void;
}

interface InMemoryHourlyEntry {
  actorKey: string;
  heldKey: string;
  at: number;
  claim: InMemoryClaim;
}

/** A held reservation belongs to one actor: another actor's key is new. */
function heldReservationKey(request: AgentActionLimitRequest): string {
  return JSON.stringify([request.actorKey, request.idempotencyKey]);
}

/** The reservations of one turn of a chat, by actor and idempotency key. */
interface InMemoryTurn {
  keys: Map<string, InMemoryClaim>;
  /** When the turn last took a reservation. */
  lastAt: number;
}

function reservationOf(
  claim: InMemoryClaim,
  attemptId: string,
): AgentActionLimitReservation {
  return {
    ok: true,
    ownerAttemptId: claim.owner,
    commit: (): Promise<void> => {
      claim.settle((live) => {
        live.committed = true;
      });
      return Promise.resolve();
    },
    markUncertain: (): Promise<void> => {
      claim.settle((live) => {
        live.uncertain = true;
      });
      return Promise.resolve();
    },
    release: (): Promise<void> => {
      if (claim.owner === attemptId && !claim.committed && !claim.uncertain) {
        claim.free();
      }
      return Promise.resolve();
    },
  };
}

/**
 * Process-local limits. Suitable for a single host process; hosts that run
 * several processes need a shared store. Each (parent chat, turn key) keeps
 * its own count, and a reservation only ever touches its own turn's count,
 * so a call from any earlier turn that lands late never changes another
 * turn's count. A turn's count is kept for {@link AGENT_ACTION_TURN_RETENTION_MS}
 * after its last reservation, and a chat keeps at most
 * {@link AGENT_ACTION_TURNS_KEPT_PER_CHAT} turns, forgetting the least
 * recently used first. Hourly entries expire after an hour without touching
 * the turn counts. A key stays held while its turn is kept or it is in the
 * hourly window, so a call replayed from an earlier turn is not counted
 * again.
 */
export function createInMemoryAgentActionLimits(
  options: {
    limits?: AgentActionLimitValues;
    now?: () => number;
  } = {},
): AgentActionLimitsPort {
  const limits = options.limits ?? AGENT_ACTION_LIMITS;
  const now = options.now ?? ((): number => Date.now());
  const chats = new Map<string, Map<string, InMemoryTurn>>();
  let hourly: InMemoryHourlyEntry[] = [];

  const refusal = (
    reason: AgentActionLimitReason,
    limit: number,
  ): Promise<AgentActionLimitReservation> =>
    Promise.resolve({ ok: false, reason, limit });

  return {
    reserve: (request): Promise<AgentActionLimitReservation> => {
      const at = now();
      hourly = hourly.filter((entry) => at - entry.at < HOUR_MS);
      const heldKey = heldReservationKey(request);
      const chat =
        chats.get(request.parentChatId) ?? new Map<string, InMemoryTurn>();
      chat.forEach((candidate, turnKey) => {
        if (at - candidate.lastAt >= AGENT_ACTION_TURN_RETENTION_MS) {
          chat.delete(turnKey);
        }
      });
      const known = chat.get(request.turnKey);
      const heldClaim =
        known?.keys.get(heldKey) ??
        hourly.find((entry) => entry.heldKey === heldKey)?.claim;
      if (heldClaim) {
        if (!heldClaim.committed) heldClaim.owner = request.attemptId;
        return Promise.resolve(reservationOf(heldClaim, request.attemptId));
      }
      const turn: InMemoryTurn = known ?? { keys: new Map(), lastAt: at };
      if (
        isAgentSpawnKind(request.kind) &&
        request.parentDepth + 1 > limits.maxDepth
      ) {
        return refusal('depth', limits.maxDepth);
      }
      if (turn.keys.size >= limits.perParentTurn) {
        return refusal('per_turn', limits.perParentTurn);
      }
      if (
        hourly.filter((entry) => entry.actorKey === request.actorKey).length >=
        limits.perUserPerHour
      ) {
        return refusal('per_hour', limits.perUserPerHour);
      }
      turn.lastAt = at;
      chat.delete(request.turnKey);
      chat.set(request.turnKey, turn);
      while (chat.size > AGENT_ACTION_TURNS_KEPT_PER_CHAT) {
        const oldest = chat.keys().next();
        if (oldest.done) break;
        chat.delete(oldest.value);
      }
      chats.set(request.parentChatId, chat);
      const parentChatId = request.parentChatId;
      const turnKey = request.turnKey;
      const actorKey = request.actorKey;
      const claim: InMemoryClaim = {
        owner: request.attemptId,
        committed: false,
        uncertain: false,
        free: (): void => {
          turn.keys.delete(heldKey);
          hourly = hourly.filter((candidate) => candidate.claim !== claim);
        },
        settle: (mark): void => {
          // A write committed or left uncertain after its reservation was
          // released may have happened: count it again under its original
          // turn and time. A later reservation of the same key already
          // counts it, so the mark lands there.
          mark(claim);
          const live = turn.keys.get(heldKey);
          if (live && live !== claim) {
            mark(live);
          } else if (!live) {
            turn.keys.set(heldKey, claim);
          }
          const chatTurns =
            chats.get(parentChatId) ?? new Map<string, InMemoryTurn>();
          if (!chatTurns.has(turnKey)) chatTurns.set(turnKey, turn);
          chats.set(parentChatId, chatTurns);
          const hourlyLive = hourly.find(
            (candidate) => candidate.heldKey === heldKey,
          );
          if (hourlyLive && hourlyLive.claim !== claim) {
            mark(hourlyLive.claim);
          } else if (!hourlyLive) {
            hourly.push({ actorKey, heldKey, at, claim });
          }
        },
      };
      turn.keys.set(heldKey, claim);
      hourly.push({ actorKey: request.actorKey, heldKey, at, claim });
      return Promise.resolve(reservationOf(claim, request.attemptId));
    },
  };
}
