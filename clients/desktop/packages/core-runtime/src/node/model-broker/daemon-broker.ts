import { randomBytes } from 'node:crypto';
import type { CloudAccountAuthority } from '../cloud-account/authority';
import {
  AI_CREDITS_WORK_OWNER_HEADER,
  type WorkOwner,
} from '@canopy/protocol/llm-gateway';
import { canonicalModelRoutingModelId } from '@canopy/protocol/model-routing';
import {
  parseWorkspaceContext,
  serializeWorkspaceContext,
} from '@canopy/protocol/workspace-context';
import {
  readCloudAccountAccess,
  type CloudAccountAccessRead,
} from '../cloud-account/access';
import {
  createCloudAccountAuthorizationPort,
  CloudAccountAuthorizationError,
} from '../cloud-account/authorization';
import {
  CLAUDE_BROKER_ALLOWED_PATHS,
  CLAUDE_BROKER_ALLOWED_QUERIES,
  CLAUDE_BROKER_FORWARD_HEADERS,
  CODEX_BROKER_ALLOWED_PATHS,
  LOOPBACK_BROKER_AUTH_TOKEN,
  buildAiCreditsProxyBaseUrl,
} from './broker-routes';
import type {
  CodexGatewayProxyService,
  CodexGatewayRouteLease,
  GatewayDaemonRoutePolicy,
} from './gateway-proxy';

/**
 * The daemon-hosted model broker (CAN-6997): the portable gateway proxy with
 * daemon credential readers. Routes are created by the daemon when a run
 * starts, never migrated from an app-issued loopback URL, and live until the
 * run settles or is cancelled; a client disconnect releases nothing.
 *
 * A child receives the loopback route, placeholder and an environment-only
 * route secret. The URL alone never authorizes use of daemon custody.
 * Every upstream request re-reads the account through the authority and is
 * refused when the bound route identity (account id, else server key id, else
 * credential digest, as the app binds it), endpoint or endpoint epoch changed, the
 * credential was rejected, or custody became unavailable. A rejection is
 * recorded only against the credential generation the request used.
 *
 * Each request's body `model` must be one the route authorizes, and passes
 * the same policy check under its own governed id before every credential
 * lease; any other model gets a local policy refusal and the route stays open.
 * Once revocation begins no new upstream attempt starts; a running stream may
 * finish while the step checkpoints. Attribution headers come only from the
 * daemon's binding, never the child, and the funding owner sent is always the
 * owner admission checked.
 */

/**
 * Claude Code's built-in side-request models (titles, summaries, Explore),
 * sent when side models are unpinned, as on the desktop's non-guest routes.
 * Revisit when the bundled `claude-code` version changes its haiku default.
 */
const CLAUDE_BUILTIN_SIDE_MODELS: readonly string[] = [
  'claude-haiku-5-5',
  'claude-haiku-4-5-20251001',
  'claude-haiku-4-5',
];

export type DaemonModelRouteBlocker = 'policy' | 'ai-credits';

export interface DaemonModelRouteBinding {
  readonly executionId: string;
  /**
   * The run owner the execution authority recorded, never from a worker:
   * `personal` or `org:<uuid>`. Anything else opens no route.
   */
  readonly owner: string;
  readonly harness: 'claude' | 'codex';
  readonly governedModelId: string;
  /**
   * Body `model` → governed policy id: the step's admitted runtime model and
   * the run's other launch-admitted AI Credits models for this harness.
   * Claude's built-in side models are added for non-guest accounts.
   */
  readonly requestModels: Readonly<Record<string, string>>;
  readonly policyScope: 'owner' | 'union';
  /** The Cloud account identity admitted at route creation. */
  readonly accountId: string | null;
  /** The credential generation admitted at route creation. */
  readonly credentialGeneration: number;
  /**
   * Attribution headers; the only `x-canopy-*` sent. Its work-owner entry is
   * always replaced by the serialized {@link owner}, so hosted billing sees
   * the owner admission checked.
   */
  readonly workOwnerHeader?: Readonly<Record<string, string>>;
  /** Checkpoint a running step before revocation can surface as a provider error. */
  readonly checkpointBeforeRevoke?: (
    blocker: DaemonModelRouteBlocker,
  ) => Promise<void>;
}

export type DaemonModelRouteOpen =
  | {
      readonly kind: 'opened';
      readonly routeId: string;
      /** Child-only configuration; the route capability must never enter argv. */
      readonly child: {
        readonly baseUrl: string;
        readonly authToken: string;
        readonly routeSecret: string;
      };
    }
  | {
      readonly kind: 'refused';
      readonly reason:
        | 'closed'
        | 'inactive'
        | 'unavailable'
        | 'signed-out'
        | 'identity-changed'
        | 'session-expired'
        | 'policy'
        | 'mandatory-gateway'
        | 'endpoint-unavailable';
    };

export interface DaemonModelBroker {
  openAiCreditsRoute(
    binding: DaemonModelRouteBinding,
  ): Promise<DaemonModelRouteOpen>;
  /** Releases one route, only if it belongs to this execution and owner. */
  release(input: {
    readonly executionId: string;
    readonly owner: string;
    readonly routeId: string;
  }): boolean;
  /** Settlement or cancellation: releases every route of the execution. */
  releaseExecution(executionId: string): number;
  /** Route count per execution, for diagnostics and tests; no secrets. */
  routeCount(executionId?: string): number;
  shutdown(): Promise<void>;
}

/** Same model/scope decision at admission and every credential presentation. */
function routeBlocker(
  read: CloudAccountAccessRead,
  binding: DaemonModelRouteBinding,
  owner: WorkOwner | null,
  mode: 'admission' | 'presentation',
  governedModelId = binding.governedModelId,
): DaemonModelRouteBlocker | null {
  if (read.kind !== 'ok' || !read.hasCredential || read.sessionExpired)
    return 'ai-credits';
  if (read.mayRequireGateway(owner)) return 'policy';
  const policy = read.modelPolicy({
    owner,
    scope: binding.policyScope,
    governedModelId,
    mode,
  });
  return policy.kind === 'allowed' ? null : 'policy';
}

interface HeldRoute {
  readonly binding: DaemonModelRouteBinding;
  /** The binding's owner, serialized after parsing. */
  readonly owner: string;
  readonly lease: CodexGatewayRouteLease;
  readonly upstream: AbortController;
  readonly endpoint: string;
  readonly endpointEpoch: string;
  revocation?: Promise<void>;
}

export function createDaemonModelBroker(options: {
  readonly proxy: CodexGatewayProxyService;
  readonly authority: CloudAccountAuthority;
  /** The configured Cloud origin; throws in a local-only build. */
  readonly cloudBaseUrl: () => string;
  /** Changes whenever the endpoint authority changes (configuration epoch). */
  readonly endpointEpoch: () => string;
  /** Only an account probe can distinguish a bad user key from proxy failure. */
  readonly refreshAccount?: () => Promise<void>;
}): DaemonModelBroker {
  const routes = new Map<string, HeldRoute>();
  const authorization = createCloudAccountAuthorizationPort(options.authority);
  let closed = false;
  let custodyEpoch = 0;

  function currentEndpoint(): string | null {
    try {
      return options.cloudBaseUrl().replace(/\/+$/, '');
    } catch {
      return null;
    }
  }

  function drop(routeId: string): boolean {
    const held = routes.get(routeId);
    if (!held) return false;
    routes.delete(routeId);
    held.upstream.abort();
    options.proxy.unregisterRoute(routeId);
    return true;
  }

  function revoke(
    routeId: string,
    blocker: DaemonModelRouteBlocker = 'ai-credits',
  ): Promise<void> {
    const held = routes.get(routeId);
    if (!held) return Promise.resolve();
    if (held.revocation) return held.revocation;
    if (!held.binding.checkpointBeforeRevoke) {
      drop(routeId);
      return Promise.resolve();
    }
    // Fence new attempts immediately, but let the executor record its pause
    // before aborting a stream that would otherwise fail the running step.
    // Failed checkpoint persistence must still withdraw authorization.
    held.revocation = Promise.resolve()
      .then(() => held.binding.checkpointBeforeRevoke?.(blocker))
      .catch(() => undefined)
      .then(() => {
        drop(routeId);
      });
    return held.revocation;
  }

  const unsubscribe = options.authority.onCustodyInvalidated?.(() => {
    custodyEpoch += 1;
    for (const routeId of [...routes.keys()]) void revoke(routeId);
  });

  return {
    openAiCreditsRoute: async (binding): Promise<DaemonModelRouteOpen> => {
      if (closed) return { kind: 'refused', reason: 'closed' };
      const owner: WorkOwner | null = parseWorkspaceContext(binding.owner);
      if (!owner) return { kind: 'refused', reason: 'unavailable' };
      const ownerKey = serializeWorkspaceContext(owner);
      // The owner admission checks is the one hosted billing is asked to fund.
      const extraHeaders: Record<string, string> = {
        ...Object.fromEntries(
          Object.entries(binding.workOwnerHeader ?? {}).filter(
            ([name]) => name.toLowerCase() !== AI_CREDITS_WORK_OWNER_HEADER,
          ),
        ),
        [AI_CREDITS_WORK_OWNER_HEADER]: ownerKey,
      };
      const openingEpoch = custodyEpoch;
      const read = await readCloudAccountAccess(options.authority);
      if (read.kind === 'inactive')
        return { kind: 'refused', reason: 'inactive' };
      if (read.kind !== 'ok') return { kind: 'refused', reason: 'unavailable' };
      if (!read.hasCredential) return { kind: 'refused', reason: 'signed-out' };
      if (
        read.accountId !== binding.accountId ||
        read.credentialGeneration !== binding.credentialGeneration
      )
        return { kind: 'refused', reason: 'identity-changed' };
      if (read.sessionExpired)
        return { kind: 'refused', reason: 'session-expired' };
      if (read.executionUnknownReason(owner))
        return { kind: 'refused', reason: 'unavailable' };
      if (read.mayRequireGateway(owner))
        return { kind: 'refused', reason: 'mandatory-gateway' };
      if (routeBlocker(read, binding, owner, 'admission'))
        return { kind: 'refused', reason: 'policy' };
      const identity = read.routeIdentity;
      const endpoint = currentEndpoint();
      if (!endpoint) return { kind: 'refused', reason: 'endpoint-unavailable' };
      const endpointEpoch = options.endpointEpoch();
      const upstream = new AbortController();
      const claude = binding.harness === 'claude';
      // Set once the route is recorded; requests before then are refused.
      const recorded: { routeId?: string } = {};
      const routeSecret = randomBytes(32).toString('hex');
      const requestModels = new Map(Object.entries(binding.requestModels));
      const sideModels = claude ? CLAUDE_BUILTIN_SIDE_MODELS : [];
      const requestedModel = (
        model: string,
      ): { readonly governed: string; readonly side: boolean } | undefined => {
        const explicit = requestModels.get(model);
        if (explicit !== undefined) return { governed: explicit, side: false };
        return sideModels.includes(model)
          ? { governed: canonicalModelRoutingModelId(model), side: true }
          : undefined;
      };
      /**
       * Whether `read` refuses this request's own model while the route's
       * admitted model stays allowed; route-wide refusals revoke instead.
       */
      const requestModelRefused = (
        read: CloudAccountAccessRead,
        model: string,
      ): boolean => {
        const requested = requestedModel(model);
        if (!requested) return true;
        // Guest routes pin side models to the admitted one's own spellings,
        // so a built-in alias of the admitted model is refused too.
        if (requested.side && read.kind === 'ok' && read.guest) return true;
        if (requested.governed === binding.governedModelId) return false;
        return (
          routeBlocker(
            read,
            binding,
            owner,
            'presentation',
            requested.governed,
          ) !== null
        );
      };
      const heldRoute = (): HeldRoute | undefined =>
        recorded.routeId === undefined
          ? undefined
          : routes.get(recorded.routeId);
      const routeCurrent = (held: HeldRoute): boolean =>
        routes.get(held.lease.routeId) === held &&
        !held.revocation &&
        !closed &&
        currentEndpoint() === held.endpoint &&
        options.endpointEpoch() === held.endpointEpoch;
      // No new bind once shutdown began; it would outlive the proxy.
      if (closed) return { kind: 'refused', reason: 'closed' };
      const daemon: GatewayDaemonRoutePolicy = {
        clientSecret: routeSecret,
        preflight: async (): Promise<boolean> => {
          const held = heldRoute();
          if (!held || closed) return false;
          if (held.revocation) {
            await held.revocation;
            return false;
          }
          // Fail fast before the body; each attempt's lease re-reads custody.
          const current = await readCloudAccountAccess(options.authority);
          const denied = routeBlocker(current, binding, owner, 'presentation');
          if (
            routeCurrent(held) &&
            current.kind === 'ok' &&
            denied === null &&
            current.routeIdentity === identity
          )
            return true;
          await revoke(held.lease.routeId, denied ?? 'ai-credits');
          return false;
        },
        admitModel: async (model): Promise<boolean> => {
          const requested = requestedModel(model);
          if (!requested) return false;
          // Route-wide refusals (account, gateway, the admitted model's
          // policy) stay with the lease path, which checkpoints first.
          // A built-in side alias still needs the read for the guest pin.
          if (requested.governed === binding.governedModelId && !requested.side)
            return true;
          const current = await readCloudAccountAccess(options.authority);
          if (
            current.kind !== 'ok' ||
            routeBlocker(current, binding, owner, 'presentation') !== null
          )
            return true;
          return !requestModelRefused(current, model);
        },
        prepare: async (model) => {
          const held = heldRoute();
          if (!held || closed) return null;
          if (held.revocation) {
            await held.revocation;
            return null;
          }
          let blocker: DaemonModelRouteBlocker = 'ai-credits';
          // One fresh read permits same-account rotation, never an unbounded retry.
          for (let attempt = 0; attempt < 2; attempt++) {
            const current = await readCloudAccountAccess(options.authority);
            const denied = routeBlocker(
              current,
              binding,
              owner,
              'presentation',
            );
            blocker = denied ?? 'ai-credits';
            if (
              !routeCurrent(held) ||
              current.kind !== 'ok' ||
              denied !== null ||
              current.routeIdentity !== identity
            )
              break;
            // The request's own model, from the same snapshot as the route.
            if (requestModelRefused(current, model)) return 'model-refused';
            let modelRefused = false;
            try {
              // Unapplied: the proxy presents it in the tick it sends.
              return await authorization.lease(
                current.credentialGeneration,
                (latest) => {
                  const denied = routeBlocker(
                    latest,
                    binding,
                    owner,
                    'presentation',
                  );
                  if (denied) blocker = denied;
                  const routeAllowed =
                    routeCurrent(held) &&
                    denied === null &&
                    latest.kind === 'ok' &&
                    latest.routeIdentity === identity;
                  modelRefused =
                    routeAllowed && requestModelRefused(latest, model);
                  return routeAllowed && !modelRefused;
                },
              );
            } catch (error) {
              if (!(error instanceof CloudAccountAuthorizationError))
                throw error;
              if (modelRefused) return 'model-refused';
              if (error.reason !== 'stale-lease') break;
            }
          }
          await revoke(held.lease.routeId, blocker);
          return null;
        },
        current: (): boolean => {
          const held = heldRoute();
          return held !== undefined && routeCurrent(held);
        },
        settled: (): Promise<void> => {
          const held = heldRoute();
          if (!held) return Promise.resolve();
          // A fence without a begun revocation (endpoint or shutdown) revokes too.
          return revoke(held.lease.routeId);
        },
        // Policy, not credential: checkpoint and pause, keep custody.
        onPolicyRefusal: async (): Promise<void> => {
          if (recorded.routeId !== undefined)
            await revoke(recorded.routeId, 'policy');
        },
        onCredentialRejected: async (_status, credentialVersion) => {
          // The hosted proxy relays service-key 401s too: probe user custody.
          if (credentialVersion === undefined) return;
          const generation = Number(credentialVersion);
          if (!Number.isSafeInteger(generation)) return;
          const current = await readCloudAccountAccess(options.authority);
          if (
            current.kind === 'ok' &&
            current.credentialGeneration === generation
          )
            await options.refreshAccount?.();
          const latest = await readCloudAccountAccess(options.authority);
          const blocker = routeBlocker(latest, binding, owner, 'presentation');
          if (recorded.routeId !== undefined && blocker !== null)
            await revoke(recorded.routeId, blocker);
        },
      };
      let lease: CodexGatewayRouteLease;
      try {
        lease = await options.proxy.registerRoute({
          daemon,
          sessionId: `daemon-run:${binding.executionId}`,
          upstreamUrl: buildAiCreditsProxyBaseUrl(endpoint, binding.harness),
          allowedPaths: claude
            ? CLAUDE_BROKER_ALLOWED_PATHS
            : CODEX_BROKER_ALLOWED_PATHS,
          ...(claude ? { allowedQueries: CLAUDE_BROKER_ALLOWED_QUERIES } : {}),
          ...(claude ? { forwardHeaders: CLAUDE_BROKER_FORWARD_HEADERS } : {}),
          // Attribution is daemon-derived; a child's labels never reach billing.
          forwardCanopyHeaders: false,
          extraHeaders,
          upstreamSignal: () => upstream.signal,
        });
      } catch (error) {
        // Shutdown during the bind: the proxy closed its own listener.
        if (closed) return { kind: 'refused', reason: 'closed' };
        throw error;
      }
      const latest = await readCloudAccountAccess(options.authority);
      if (
        closed ||
        openingEpoch !== custodyEpoch ||
        latest.kind !== 'ok' ||
        routeBlocker(latest, binding, owner, 'admission') !== null ||
        currentEndpoint() !== endpoint ||
        options.endpointEpoch() !== endpointEpoch ||
        !latest.hasCredential ||
        latest.routeIdentity !== identity ||
        latest.credentialGeneration !== binding.credentialGeneration
      ) {
        upstream.abort();
        options.proxy.unregisterRoute(lease.routeId);
        return { kind: 'refused', reason: closed ? 'closed' : 'unavailable' };
      }
      routes.set(lease.routeId, {
        binding,
        owner: ownerKey,
        lease,
        upstream,
        endpoint,
        endpointEpoch,
      });
      recorded.routeId = lease.routeId;
      return {
        kind: 'opened',
        routeId: lease.routeId,
        child: {
          baseUrl: lease.baseUrl,
          authToken: LOOPBACK_BROKER_AUTH_TOKEN,
          routeSecret,
        },
      };
    },
    release: ({ executionId, owner, routeId }): boolean => {
      const held = routes.get(routeId);
      const parsed = parseWorkspaceContext(owner);
      if (
        !held ||
        !parsed ||
        held.binding.executionId !== executionId ||
        held.owner !== serializeWorkspaceContext(parsed)
      )
        return false;
      return drop(routeId);
    },
    releaseExecution: (executionId): number => {
      let released = 0;
      for (const [routeId, held] of [...routes])
        if (held.binding.executionId === executionId && drop(routeId))
          released += 1;
      return released;
    },
    routeCount: (executionId): number =>
      executionId === undefined
        ? routes.size
        : [...routes.values()].filter(
            (held) => held.binding.executionId === executionId,
          ).length,
    shutdown: async (): Promise<void> => {
      closed = true;
      unsubscribe?.();
      authorization.dispose();
      for (const routeId of [...routes.keys()]) drop(routeId);
      // Every route is withdrawn, so open requests have nothing left to serve.
      await options.proxy.shutdown({ closeActiveConnections: true });
    },
  };
}
