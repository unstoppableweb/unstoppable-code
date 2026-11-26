import { createHash } from 'node:crypto';
import { app } from 'electron';
import {
  CanopyClientError,
  createCanopyClient,
  type CanopyClient,
} from '@canopy/core-client';
import {
  CORE_INTEGRATION_SHARED_CONNECTION_INSTRUCTION_DEFINITIONS,
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  CORE_TRANSPORT_QUERY_DEFINITIONS,
  SharedConnectionSessionIssueResultSchema,
  composeCanopyInstructionRegistries,
  composeCanopyQueryRegistries,
  type SharedConnectionSessionIssueResult,
} from '@canopy/protocol/canopy-core';
import { resolveCanopyCloudCredentialContext } from '../canopy-cloud/client';
import { connectWebCore } from '../canopy-cloud/web-core-connection';
import { desktopWebCoreBindingOptions } from '../ipc/cloud-chats';

// ---------------------------------------------------------------------------
// Shared connections in desktop chats (CAN-6243, CAN-6246, CAN-6247).
//
// A chat in an organization project asks the web core for a claim
// (`core.integration.sharedConnection.session.issue`) and sends it with every
// call to the project's shared connections. The web core decides whether the
// person may use them and pins the chat to the project; the hosted proxy
// re-checks every call. This copy is only what to bind: it never widens
// access, because a stale or tampered list cannot pass the proxy.
//
// Claims are kept per signed-in key and chat for a few minutes, so every turn
// of a chat does not open a web core connection. A claim is bound to the key
// that asked for it, so another key (a new sign-in, another account) never
// reuses it. A removed person or connection is refused by the proxy at once;
// a connection added to the project is picked up by asking again (`fresh`).
// ---------------------------------------------------------------------------

/**
 * `unavailable`: the web core does not offer shared connections (an older
 * web); `refused`: the person may not use them here, with the web core's
 * reason to show.
 */
export type SharedConnectionSessionRead =
  | { readonly kind: 'ok'; readonly value: SharedConnectionSessionIssueResult }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'refused'; readonly message: string };

/**
 * A scheduled run's claim (CAN-6252): no one attends it, so it may call
 * read-only tools and these writes (tool names by connection id) only.
 */
export interface ScheduledClaimRequest {
  readonly writes?: Readonly<Record<string, readonly string[]>>;
}

export interface SharedConnectionCalls {
  issue(
    projectId: string,
    chatId: string,
    scheduled?: ScheduledClaimRequest,
  ): Promise<SharedConnectionSessionRead>;
}

const OPERATION = 'core.integration.sharedConnection.session.issue';
const CALL_TIMEOUT_MS = 30_000;
const REFUSALS = new Set([
  'not_found',
  'permission_denied',
  'failed_precondition',
]);

const DEFINITIONS = {
  queries: composeCanopyQueryRegistries(CORE_TRANSPORT_QUERY_DEFINITIONS),
  instructions: composeCanopyInstructionRegistries(
    CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
    CORE_INTEGRATION_SHARED_CONNECTION_INSTRUCTION_DEFINITIONS,
  ),
  streams: {},
};

type Client = CanopyClient<
  (typeof DEFINITIONS)['queries'],
  (typeof DEFINITIONS)['instructions']
>;

export function createWebCoreSharedConnectionCalls(): SharedConnectionCalls {
  return {
    async issue(projectId, chatId, scheduled) {
      // Not behind the cloud chats flag: the web core gates the call itself.
      const binding = {
        ...desktopWebCoreBindingOptions(),
        isEnabled: (): boolean => true,
      };
      const signal = AbortSignal.timeout(CALL_TIMEOUT_MS);
      try {
        const client: Client = await createCanopyClient({
          connection: await connectWebCore(binding, signal),
          clientName: 'canopy-desktop-shared-connections',
          clientVersion: app.getVersion(),
          definitions: DEFINITIONS,
          signal,
        });
        try {
          if (!client.manifest.has('operations', OPERATION))
            return { kind: 'unavailable' };
          return {
            kind: 'ok',
            value: SharedConnectionSessionIssueResultSchema.parse(
              await client.instruction(OPERATION, {
                projectId,
                chatId,
                ...(scheduled === undefined
                  ? {}
                  : {
                      run: 'scheduled' as const,
                      ...(scheduled.writes === undefined
                        ? {}
                        : {
                            writes: Object.fromEntries(
                              Object.entries(scheduled.writes).map(
                                ([id, tools]) => [id, [...tools]],
                              ),
                            ),
                          }),
                    }),
              }),
            ),
          };
        } finally {
          await client.close();
        }
      } catch (error) {
        if (
          error instanceof CanopyClientError &&
          REFUSALS.has(error.payload.kind)
        )
          return { kind: 'refused', message: error.payload.message };
        // A web from before scheduled claims refuses their fields; to it,
        // scheduled runs have no shared connections.
        if (
          scheduled !== undefined &&
          error instanceof CanopyClientError &&
          error.payload.kind === 'invalid_argument'
        )
          return { kind: 'unavailable' };
        throw error;
      }
    },
  };
}

/** How long a chat's claim and connection list are reused. */
const REUSE_MS = 5 * 60_000;
/** Ask again well before a claim expires. */
const EXPIRY_MARGIN_MS = 60 * 60_000;

export interface SharedConnectionSessions {
  /**
   * The chat's claim and the project's connections in force. `fresh` asks
   * the web core again instead of reusing a kept claim, for a connection the
   * project's setup names that the kept list does not hold yet.
   */
  forChat(
    projectId: string,
    chatId: string,
    options?: {
      readonly fresh?: boolean;
      /** A scheduled run's claim, with its allowed writes (CAN-6252). */
      readonly scheduled?: ScheduledClaimRequest;
    },
  ): Promise<SharedConnectionSessionRead>;
}

export function createSharedConnectionSessions(deps: {
  calls: SharedConnectionCalls;
  /** Who is signed in: a claim is kept only for the key that asked for it. */
  owner: () => Promise<string>;
  now?: () => number;
}): SharedConnectionSessions {
  const now = deps.now ?? Date.now;
  const kept = new Map<
    string,
    { readonly until: number; readonly read: SharedConnectionSessionRead }
  >();
  const inFlight = new Map<string, Promise<SharedConnectionSessionRead>>();
  return {
    async forChat(projectId, chatId, options) {
      const scheduled = options?.scheduled;
      // An attended and a scheduled claim, or two write lists, never share
      // a kept claim.
      const run =
        scheduled === undefined
          ? 'attended'
          : Object.keys(scheduled.writes ?? {})
              .sort()
              .map((id) => [id, [...(scheduled.writes?.[id] ?? [])].sort()]);
      const key = JSON.stringify([await deps.owner(), projectId, chatId, run]);
      const cached = kept.get(key);
      if (options?.fresh !== true && cached && cached.until > now())
        return cached.read;
      const running = inFlight.get(key);
      if (running) return running;
      const pending = deps.calls
        .issue(projectId, chatId, scheduled)
        .then((read) => {
          // Only an issued claim is kept: a refusal is asked again next time,
          // so a person added to the project gets the connections at once.
          if (read.kind === 'ok') {
            const expires = Date.parse(read.value.expiresAt);
            const until = Math.min(
              now() + REUSE_MS,
              Number.isFinite(expires) ? expires - EXPIRY_MARGIN_MS : 0,
            );
            if (until > now()) kept.set(key, { until, read });
          } else kept.delete(key);
          return read;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
      return pending;
    },
  };
}

let production: SharedConnectionSessions | null = null;

/** The app's shared connection sessions, over the web core. */
export function sharedConnectionSessions(): SharedConnectionSessions {
  production ??= createSharedConnectionSessions({
    calls: createWebCoreSharedConnectionCalls(),
    owner: async () => {
      const credentials = await resolveCanopyCloudCredentialContext();
      return createHash('sha256')
        .update(JSON.stringify([credentials.baseUrl, credentials.apiKey]))
        .digest('hex');
    },
  });
  return production;
}
