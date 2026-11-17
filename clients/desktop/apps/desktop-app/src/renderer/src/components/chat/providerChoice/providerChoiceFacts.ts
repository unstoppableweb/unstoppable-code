import type {
  CreditsBalanceState,
  ProviderChoiceModel,
  ProviderChoiceRow,
  ProviderConnection,
  ProviderSourceFacts,
  ProviderSourceId,
} from '@canopy/app-state/provider-choice';
import type {
  AgentProviderType,
  ChatModel,
} from '@canopy/desktop-shared/types';
import { normalizeEpochMs } from '@canopy/desktop-shared/ai-credits-routing-state';
import type { ProviderModelAvailability } from '@/hooks/useProviderAvailability';

/** A model the desktop provider list can name and switch to. */
export interface DesktopChoiceModel extends ProviderChoiceModel {
  readonly id: ChatModel;
}

export type DesktopChoiceRow = ProviderChoiceRow<DesktopChoiceModel>;

/**
 * What the composer knows about this chat's sources, for every
 * provider-choice notice it renders. The notices add the credits purchase
 * facts from their own coverage read, so the guest, buyer and organization
 * rules stay with `resolveCreditsPrompt`.
 */
export interface DesktopProviderChoiceContext {
  /** The source this chat bills now, or `null` when it has none. */
  readonly current: ProviderSourceId | null;
  /** The chat's model, for "Stays on {model}" and the resolver's target. */
  readonly currentModel?: DesktopChoiceModel;
  /** The configured AI gateway's name, for "Continue with {name}". */
  readonly gatewayName?: string;
  /** Subscription (and, later, gateway) rows. */
  readonly accountSources: readonly ProviderSourceFacts<DesktopChoiceModel>[];
  /** The credits row's model facts. */
  readonly credits: {
    readonly runsTargetModel: boolean;
    readonly defaultModel?: DesktopChoiceModel;
    /**
     * Why the chat can't move onto credits now, for example a locked billing
     * toggle. It applies only to a spendable balance: a purchase stays
     * available.
     */
    readonly useBlockedReason?: string;
  };
  /**
   * Moves the chat onto a row with action `use`: the same handler the
   * notice's "Continue with X" runs. A `switch-model` outcome goes through
   * the composer's switch dialog where it applies. Resolves `false` when the
   * chat did not move, and the list then says so.
   */
  readonly onUse: (row: DesktopChoiceRow) => Promise<boolean>;
  /** Formats a reset time for "Limit reached, resets at …". */
  readonly formatResetsAt: (resetsAt: number) => string;
}

/** The providers whose sign-in the desktop can start from the list. */
export const DESKTOP_SUBSCRIPTION_SOURCES = ['claude', 'codex'] as const;
export type DesktopSubscriptionSource =
  (typeof DESKTOP_SUBSCRIPTION_SOURCES)[number];

export function isDesktopSubscriptionSource(
  source: ProviderSourceId,
): source is DesktopSubscriptionSource {
  return source === 'claude' || source === 'codex';
}

/** A provider's connection, from the composer's availability read. */
export function desktopProviderConnection(
  availability: ProviderModelAvailability | undefined,
  limited: { readonly resetsAt: number | null } | null,
): ProviderConnection {
  if (availability === undefined) return { kind: 'checking' };
  const inconclusive =
    availability.nativeAuthInconclusive ?? availability.loading;
  if (availability.nativeAuth) {
    return limited !== null
      ? { kind: 'limited', resetsAt: limited.resetsAt }
      : { kind: 'ready' };
  }
  return inconclusive ? { kind: 'checking' } : { kind: 'not-connected' };
}

export interface DesktopAccountSourcesInput {
  /** The provider the chat's model runs on. */
  readonly modelProvider: AgentProviderType;
  /**
   * The chat's model can run on a native login (a gateway-only model
   * cannot, whatever its provider).
   */
  readonly modelRunsNatively: boolean;
  readonly availability: Readonly<
    Partial<Record<AgentProviderType, ProviderModelAvailability>>
  >;
  /** Each provider whose usage limit is reached, with its reset time. */
  readonly limited: DesktopUsageLimits;
  /** Each provider's own default model, when it has one. */
  readonly defaultModelFor: (
    provider: DesktopSubscriptionSource,
  ) => DesktopChoiceModel | undefined;
  /** Why the chat can't move to a provider now, when it can't. */
  readonly blockedReasonFor?: (
    provider: DesktopSubscriptionSource,
  ) => string | undefined;
  /**
   * The provider's own route for the chat's model under another id (a chat
   * on a gateway slug whose model the provider runs natively), as the model
   * matcher found it.
   */
  readonly equivalentModelFor?: (
    provider: DesktopSubscriptionSource,
  ) => DesktopChoiceModel | undefined;
}

/** Each limited provider's reset time (ms), `null` when not known. */
export type DesktopUsageLimits = Readonly<
  Partial<Record<AgentProviderType, { readonly resetsAt: number | null }>>
>;

/**
 * The account's usage limits, from every chat's recorded limit: a provider
 * is limited while any chat holds a limit for it that hasn't reset. This
 * chat's own visible limit always counts, even without a reset time; another
 * chat's counts only with a reset time still ahead, so a stale record can't
 * hold a provider forever. Reset times may arrive in seconds or ms. A
 * chat's record clears when that chat sends again, so a limit is only as
 * account-wide as the chats that still hold it.
 */
export function accountUsageLimits(
  recorded: readonly (
    | {
        readonly provider: AgentProviderType;
        readonly resetsAt?: number;
      }
    | undefined
  )[],
  own: {
    readonly provider: AgentProviderType;
    readonly resetsAt?: number;
  } | null,
  now: number,
): DesktopUsageLimits {
  const limits: Partial<
    Record<AgentProviderType, { readonly resetsAt: number | null }>
  > = {};
  const ms = (resetsAt: number | undefined): number | null =>
    typeof resetsAt === 'number' ? (normalizeEpochMs(resetsAt) ?? null) : null;
  for (const entry of recorded) {
    if (entry === undefined) continue;
    const resetsAt = ms(entry.resetsAt);
    if (resetsAt === null || resetsAt <= now) continue;
    const prior = limits[entry.provider]?.resetsAt;
    if (prior == null || resetsAt > prior) {
      limits[entry.provider] = { resetsAt };
    }
  }
  if (own !== null && limits[own.provider] === undefined) {
    limits[own.provider] = { resetsAt: ms(own.resetsAt) };
  }
  return limits;
}

/** The subscription rows' facts. Pure, so the resolver input stays testable. */
export function buildDesktopAccountSources({
  modelProvider,
  modelRunsNatively,
  availability,
  limited,
  defaultModelFor,
  blockedReasonFor,
  equivalentModelFor,
}: DesktopAccountSourcesInput): ProviderSourceFacts<DesktopChoiceModel>[] {
  return DESKTOP_SUBSCRIPTION_SOURCES.map((source) => {
    const defaultModel = defaultModelFor(source);
    const blockedReason = blockedReasonFor?.(source);
    const equivalentModel = equivalentModelFor?.(source);
    return {
      source,
      connection: desktopProviderConnection(
        availability[source],
        limited[source] ?? null,
      ),
      connectable: true,
      runsTargetModel: modelRunsNatively && modelProvider === source,
      ...(defaultModel !== undefined ? { defaultModel } : {}),
      ...(equivalentModel !== undefined ? { equivalentModel } : {}),
      ...(blockedReason !== undefined ? { blockedReason } : {}),
    };
  });
}

export interface DesktopGatewaySourceInput {
  /** A Personal (or device) gateway is saved. */
  readonly configured: boolean;
  /** This computer holds the gateway key. */
  readonly keyHeld: boolean;
  /**
   * The gateway model a switch continues on: set only once this computer
   * holds the key and the gateway has a model the next send would accept.
   */
  readonly switchModel?: DesktopChoiceModel;
  /** The chat already runs on this gateway. */
  readonly chatOnGateway: boolean;
  /**
   * The gateway's own route for the chat's model under another id, as the
   * model matcher found it: the row then stays on the chat's model.
   */
  readonly equivalentModel?: DesktopChoiceModel;
  /** Why the chat can't move onto the gateway now, when it can't. */
  readonly blockedReason?: string;
}

/**
 * The AI gateway row's facts. Before setup, and while this computer lacks
 * the key, it is not connected and offers Set up; with the key it is ready
 * and continues on its model, like the subscription rows. With the key but
 * no sendable model it stays ready and offers nothing (its blocked reason
 * says why), since setting it up again would change nothing.
 */
export function buildDesktopGatewaySource({
  configured,
  keyHeld,
  switchModel,
  chatOnGateway,
  equivalentModel,
  blockedReason,
}: DesktopGatewaySourceInput): ProviderSourceFacts<DesktopChoiceModel> {
  const ready =
    configured && (keyHeld || switchModel !== undefined || chatOnGateway);
  return {
    source: 'gateway',
    connection: ready ? { kind: 'ready' } : { kind: 'not-connected' },
    connectable: true,
    runsTargetModel: chatOnGateway,
    ...(ready && switchModel !== undefined
      ? { defaultModel: switchModel }
      : {}),
    ...(ready && equivalentModel !== undefined ? { equivalentModel } : {}),
    ...(blockedReason !== undefined ? { blockedReason } : {}),
  };
}

/** The credits balance as the provider list reads it. */
export function desktopCreditsBalance(input: {
  readonly settled: boolean;
  readonly canSpend: boolean;
  readonly inconclusive: boolean;
}): CreditsBalanceState {
  if (!input.settled || input.inconclusive) return 'unknown';
  return input.canSpend ? 'spendable' : 'empty';
}
