import { createHash, randomUUID } from 'node:crypto';
import { app } from 'electron';
import {
  CANOPY_JSON_RPC_PROTOCOL_ERROR_CODES,
  CORE_CLIENT_TOOL_INSTRUCTION_DEFINITIONS,
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  CORE_TRANSPORT_QUERY_DEFINITIONS,
  CanopyCallerDescriptorSchema,
  CoreRuntimeInitializeResultSchema,
  composeCanopyOperationEnvelopes,
  encodeCanopyError,
  type CanopyCallerDescriptor,
  type CanopyErrorPayload,
  type CanopyInstructionDefinition,
  type CanopyQueryDefinition,
  type CanopyStreamDefinition,
  type CanopyJsonRpcId,
  type CanopyJsonRpcMessage,
  type CanopyJsonRpcRequest,
  type CanopyOperationEnvelopes,
  type CanopySchemaOutput,
  type CoreClientToolsRegisterParamsSchema,
  type CoreClientToolsRegisterResult,
  type CoreClientToolsUnregisterParamsSchema,
  type CoreClientToolsUnregisterResult,
} from '@canopy/protocol/canopy-core';
import {
  CanopyOperationError,
  createInProcessCanopyClient,
  paramsDeclareMeta,
  type CanopyStreamHandle,
  type InProcessCanopyClient,
} from '@canopy/core-runtime';
import {
  createInMemoryFramedPair,
  type CanopyFramedConnection,
  CanopyTransportError,
} from '@canopy/core-transport';
import { stableStringify } from '@canopy/protocol/plans';
import type { DesktopCanopyDispatcher } from '../desktop-runtime';
import {
  CAPABILITIES_REGISTER,
  RELAY_DEFINITIONS,
  TOOLS_REGISTER,
  TOOLS_UNREGISTER,
  type RelayBindingProvider,
} from './definitions';

// Interim: no renderer surface calls a daemon-served operation yet, so the
// relay keeps this in-process provider until the W3 exit (CAN-3166); the
// Files read reaches the daemon through the file-tree IPC handlers
// (CAN-4305). Durable capability ownership and leases land with CAN-3767.
// Nothing here persists.

const INITIALIZE = 'core.runtime.initialize';
const HEALTH = 'core.runtime.health.get';
const MANAGE_GRANT = 'core.client.manage';
const MAX_IN_FLIGHT = 64;
const MAX_STREAMS = 32;
// Outcomes live for the connection; past this, new keys are refused.
const MAX_REMEMBERED_KEYS = 32;
// Wire frames carry envelope headroom above the relay's 1 MiB value cap.
const MAX_FRAME_BYTES = 2 * 1024 * 1024;

const registerDefinition =
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS[CAPABILITIES_REGISTER];
type RegisterParams = CanopySchemaOutput<(typeof registerDefinition)['params']>;
type RegisterResult = CanopySchemaOutput<(typeof registerDefinition)['result']>;
export type RelayCapabilities = RegisterParams['capabilities'];

export interface InterimInMemoryBindingOptions {
  /** Connection-scoped forwarding; `[]` drops the set when the connection ends. */
  onCapabilities?: (
    caller: CanopyCallerDescriptor,
    capabilities: RelayCapabilities,
  ) => Promise<void> | void;
  /**
   * Lease-bound tool registrations (CAN-4131), with the WebContents the
   * connection serves. Absent: both methods are not found.
   */
  onTools?: {
    register(
      caller: CanopyCallerDescriptor,
      params: CanopySchemaOutput<typeof CoreClientToolsRegisterParamsSchema>,
      webContentsId: number,
    ): CoreClientToolsRegisterResult;
    unregister(
      caller: CanopyCallerDescriptor,
      params: CanopySchemaOutput<typeof CoreClientToolsUnregisterParamsSchema>,
      webContentsId: number,
    ): CoreClientToolsUnregisterResult;
  };
}

const isToolMethod = (name: string): boolean =>
  name === TOOLS_REGISTER || name === TOOLS_UNREGISTER;

type RelayClient = InProcessCanopyClient<
  (typeof RELAY_DEFINITIONS)['queries'],
  (typeof RELAY_DEFINITIONS)['instructions'],
  (typeof RELAY_DEFINITIONS)['streams']
>;
interface Route {
  kind: 'query' | 'instruction' | 'stream';
  requiredGrants: readonly string[];
  envelopes: CanopyOperationEnvelopes;
  /** Keyed definitions that declare `_meta` in params keep it there. */
  paramsKeepMeta: boolean;
}

const initializeEnvelopes = composeCanopyOperationEnvelopes(
  INITIALIZE,
  CORE_TRANSPORT_QUERY_DEFINITIONS[INITIALIZE],
);
const routes = new Map<string, Route>();
function addRoutes(
  kind: Route['kind'],
  map: Readonly<
    Record<
      string,
      | CanopyQueryDefinition
      | CanopyInstructionDefinition
      | CanopyStreamDefinition
    >
  >,
): void {
  for (const [name, definition] of Object.entries(map))
    routes.set(name, {
      kind,
      requiredGrants: definition.requiredGrants,
      envelopes: composeCanopyOperationEnvelopes(name, definition),
      paramsKeepMeta: paramsDeclareMeta(definition.params),
    });
}
addRoutes('query', RELAY_DEFINITIONS.queries);
addRoutes('instruction', RELAY_DEFINITIONS.instructions);
addRoutes('stream', RELAY_DEFINITIONS.streams);

function error(
  kind: CanopyErrorPayload['kind'],
  message: string,
  extra: Pick<CanopyErrorPayload, 'code' | 'retry'> = {
    retry: { kind: 'never' },
  },
): CanopyOperationError {
  return new CanopyOperationError({ kind, message, ...extra });
}

const oversized = (keyed = false): CanopyOperationError =>
  error('resource_exhausted', 'The value exceeds the relay frame cap.', {
    retry: keyed
      ? { kind: 'same_idempotency_key' }
      : { kind: 'after_refresh', resource: 'relay.frame' },
  });

const exhausted = (resource: string): CanopyOperationError =>
  error('resource_exhausted', `Too many concurrent ${resource}.`, {
    retry: { kind: 'after_refresh', resource: `relay.${resource}` },
  });

class RelayConnection {
  private initialized = false;
  private inFlight = 0;
  /** Open server handles by their wire `subscriptionId`. */
  private readonly streams = new Map<
    string,
    CanopyStreamHandle<unknown, unknown>
  >();
  /** Opens admitted against `MAX_STREAMS` that have not settled yet. */
  private opening = 0;
  private readonly grants: ReadonlySet<string>;
  private readonly client: RelayClient;
  private revision = 0;
  private registered = false;
  private registering: Promise<unknown> | null = null;
  private readonly keys = new Map<
    string,
    { canonical: string; result: RegisterResult }
  >();

  constructor(
    private readonly server: CanopyFramedConnection,
    private readonly dispatcher: DesktopCanopyDispatcher,
    private readonly caller: CanopyCallerDescriptor,
    private readonly webContentsId: number,
    private readonly options: InterimInMemoryBindingOptions,
  ) {
    this.grants = new Set(caller.grants);
    this.client = createInProcessCanopyClient(dispatcher, caller);
  }

  async serve(): Promise<void> {
    try {
      for (;;) {
        const message = await this.server.receive().catch(() => null);
        if (!message) return;
        if (!('method' in message) || !('id' in message)) continue;
        if (!this.initialized) {
          await this.initialize(message);
          continue;
        }
        if (this.inFlight >= MAX_IN_FLIGHT) {
          void this.fail(message.id, exhausted('requests'));
          continue;
        }
        this.inFlight += 1;
        void this.handle(message)
          .catch(() => undefined)
          .finally(() => (this.inFlight -= 1));
      }
    } finally {
      this.server.close();
      Array.from(this.streams.keys()).forEach((id) => this.releaseStream(id));
      void this.dropCapabilities();
    }
  }

  /** An oversized frame fails alone; any other send failure ends the connection. */
  private transmit(
    message: CanopyJsonRpcMessage,
  ): Promise<'sent' | 'oversized' | 'closed'> {
    return this.server.send(message).then(
      () => 'sent',
      (cause: unknown) => {
        if (
          cause instanceof CanopyTransportError &&
          cause.payload.kind === 'resource_exhausted' &&
          !this.server.signal.aborted
        )
          return 'oversized';
        this.server.close();
        return 'closed';
      },
    );
  }

  private async deliver(message: CanopyJsonRpcMessage): Promise<boolean> {
    return (await this.transmit(message)) === 'sent';
  }

  private async respond(
    id: CanopyJsonRpcId,
    result: unknown,
    keyed = false,
  ): Promise<void> {
    if ((await this.transmit({ jsonrpc: '2.0', id, result })) === 'oversized')
      await this.fail(id, oversized(keyed));
  }

  private fail(id: CanopyJsonRpcId, cause: unknown): Promise<boolean> {
    // Only typed operation payloads cross; anything else is redacted.
    const payload =
      cause instanceof CanopyOperationError
        ? cause.payload
        : error('internal', 'The operation failed.').payload;
    return this.deliver({
      jsonrpc: '2.0',
      id,
      error: encodeCanopyError(payload),
    });
  }

  /** Installed, granted, and (for registration) backed by a host hook. */
  private routable(name: string, route: Route): boolean {
    return (
      route.requiredGrants.every((grant) => this.grants.has(grant)) &&
      (name !== CAPABILITIES_REGISTER || !!this.options.onCapabilities) &&
      (!isToolMethod(name) || !!this.options.onTools)
    );
  }

  private async initialize(request: CanopyJsonRpcRequest): Promise<void> {
    const { id } = request;
    if (request.method !== INITIALIZE) {
      await this.fail(
        id,
        error('failed_precondition', 'Initialize the connection first.'),
      );
      return;
    }
    const parsed = initializeEnvelopes.request.safeParse(request);
    const offered = request.params.client;
    if (
      !parsed.success ||
      !(offered instanceof Object) ||
      !('protocolVersions' in offered) ||
      !Array.isArray(offered.protocolVersions)
    ) {
      await this.fail(id, error('invalid_argument', 'Invalid initialize.'));
      return;
    }
    try {
      // The descriptor read is the host's own, not a renderer grant.
      const health = await this.dispatcher.query(
        HEALTH,
        {},
        { caller: { ...this.caller, grants: ['core.runtime.read'] } },
      );
      const supported = health.runtime.protocolVersions;
      const selected = Math.max(
        ...offered.protocolVersions.filter(
          (version): version is number =>
            typeof version === 'number' && supported.includes(version),
        ),
      );
      if (!Number.isFinite(selected)) {
        await this.fail(
          id,
          error(
            'failed_precondition',
            `Protocol version mismatch: core supports ${supported.join(', ')}.`,
            { code: 'core.runtime.invalidState', retry: { kind: 'never' } },
          ),
        );
        this.server.close();
        return;
      }
      const names = (kinds: readonly Route['kind'][]): string[] =>
        Array.from(routes)
          .filter(
            ([name, route]) =>
              kinds.includes(route.kind) && this.routable(name, route),
          )
          .map(([name]) => name);
      const result = CoreRuntimeInitializeResultSchema.parse({
        runtime: { ...health.runtime, buildVersion: app.getVersion() },
        selectedProtocolVersion: selected,
        capabilities: {
          operations: names(['query', 'instruction']),
          events: [],
          streams: names(['stream']),
        },
        limits: {
          maxInFlightRequests: MAX_IN_FLIGHT,
          maxStreams: MAX_STREAMS,
          maxFrameBytes: MAX_FRAME_BYTES,
        },
        authentication: { required: true, methods: [] },
      });
      this.initialized = await this.deliver({ jsonrpc: '2.0', id, result });
    } catch (cause) {
      await this.fail(id, cause);
    }
  }

  private async handle(request: CanopyJsonRpcRequest): Promise<void> {
    const { id, method } = request;
    const route = routes.get(method);
    if (
      !route ||
      (method === CAPABILITIES_REGISTER && !this.options.onCapabilities) ||
      (isToolMethod(method) && !this.options.onTools)
    ) {
      await this.deliver({
        jsonrpc: '2.0',
        id,
        error: {
          code: CANOPY_JSON_RPC_PROTOCOL_ERROR_CODES.methodNotFound,
          message: 'Method not found.',
        },
      });
      return;
    }
    try {
      if (!route.envelopes.request.safeParse(request).success)
        throw error(
          'invalid_argument',
          `Invalid ${method} parameters or request metadata.`,
        );
      if (method === CAPABILITIES_REGISTER) {
        const result = await this.register(request.params);
        await this.respond(id, result, true);
        return;
      }
      if (isToolMethod(method)) {
        await this.respond(
          id,
          this.registerTools(method, request.params),
          true,
        );
        return;
      }
      const { _meta: metadata, ...rest } = request.params;
      const params = route.paramsKeepMeta ? request.params : rest;
      if (route.kind === 'query') {
        const result = await this.client.query(method, params, {
          metadata,
          signal: this.server.signal,
        });
        await this.respond(id, result);
      } else if (route.kind === 'instruction') {
        // Disconnect does not cancel durable work.
        const result = await this.client.instruction(method, params, {
          metadata,
        });
        await this.respond(
          id,
          result,
          RELAY_DEFINITIONS.instructions[method]?.idempotency === 'keyed',
        );
      } else await this.openStream(id, method, params, metadata);
    } catch (cause) {
      await this.fail(id, cause);
    }
  }

  /**
   * Host-local cancellation (the wire has none): closes the matching
   * in-process handle and frees its slot now. Unknown ids are a no-op.
   */
  releaseStream(subscriptionId: string): void {
    const handle = this.streams.get(subscriptionId);
    if (!handle) return;
    this.streams.delete(subscriptionId);
    handle.close();
  }

  private async openStream(
    id: CanopyJsonRpcId,
    method: CanopyJsonRpcRequest['method'],
    params: Record<string, unknown>,
    metadata: CanopyJsonRpcRequest['params']['_meta'],
  ): Promise<void> {
    if (this.streams.size + this.opening >= MAX_STREAMS)
      throw exhausted('streams');
    this.opening += 1;
    let handle: CanopyStreamHandle<unknown, unknown>;
    try {
      handle = await this.client.openStream(method, params, {
        metadata,
        signal: this.server.signal,
      });
    } finally {
      this.opening -= 1;
    }
    const { subscriptionId } = handle.openResult;
    if (this.server.signal.aborted || this.streams.has(subscriptionId)) {
      handle.close();
      throw error('internal', 'The stream could not be opened.');
    }
    // Routable before the open response, so a release can never miss it.
    this.streams.set(subscriptionId, handle);
    if (
      !(await this.deliver({ jsonrpc: '2.0', id, result: handle.openResult }))
    )
      return this.releaseStream(subscriptionId);
    void this.pump(method, handle)
      .catch(() => undefined)
      .finally(() => {
        if (this.streams.get(subscriptionId) === handle)
          this.releaseStream(subscriptionId);
      });
  }

  /** One frame on the wire at a time; the dispatcher bounds what waits. */
  private async pump(
    method: CanopyJsonRpcRequest['method'],
    handle: CanopyStreamHandle<unknown, unknown>,
  ): Promise<void> {
    const { subscriptionId, acceptedCursor } = handle.openResult;
    let delivered = acceptedCursor;
    for await (const frame of handle.frames) {
      // A released stream's remaining frames have no reader.
      if (this.streams.get(subscriptionId) !== handle) return;
      const params =
        frame.kind === 'item'
          ? {
              subscriptionId,
              cursor: frame.cursor,
              itemId: `${frame.cursor.daemonEpoch}#${frame.cursor.sequence}`,
              occurredAt: new Date().toISOString(),
              item: frame.item,
            }
          : {
              ...Object.fromEntries(
                Object.entries(frame).filter(([key]) => key !== 'kind'),
              ),
              subscriptionId,
            };
      const suffix = frame.kind === 'item' ? 'item' : 'end';
      const sent = await this.transmit({
        jsonrpc: '2.0',
        method: `${method}.${suffix}`,
        params,
      });
      if (sent === 'closed') return;
      if (sent === 'oversized') {
        // Ends at the last delivered cursor, so a resume retries this frame.
        const cursor = delivered ?? {
          daemonEpoch: frame.cursor.daemonEpoch,
          sequence: 0,
        };
        this.releaseStream(subscriptionId);
        await this.deliver({
          jsonrpc: '2.0',
          method: `${method}.end`,
          params: {
            subscriptionId,
            cursor,
            outcome: 'error',
            error: oversized().payload,
          },
        });
        return;
      }
      delivered = frame.cursor;
    }
  }

  private registerTools(
    method: string,
    raw: unknown,
  ): CoreClientToolsRegisterResult | CoreClientToolsUnregisterResult {
    if (!this.grants.has(MANAGE_GRANT))
      throw error('permission_denied', 'The caller cannot register tools.');
    const onTools = this.options.onTools;
    if (method === TOOLS_REGISTER) {
      const parsed =
        CORE_CLIENT_TOOL_INSTRUCTION_DEFINITIONS[
          TOOLS_REGISTER
        ].params.safeParse(raw);
      if (!parsed.success || !onTools)
        throw error('invalid_argument', 'Invalid tool registration.');
      return onTools.register(this.caller, parsed.data, this.webContentsId);
    }
    const parsed =
      CORE_CLIENT_TOOL_INSTRUCTION_DEFINITIONS[
        TOOLS_UNREGISTER
      ].params.safeParse(raw);
    if (!parsed.success || !onTools)
      throw error('invalid_argument', 'Invalid tool registration.');
    return onTools.unregister(this.caller, parsed.data, this.webContentsId);
  }

  private async register(raw: unknown): Promise<RegisterResult> {
    if (!this.grants.has(MANAGE_GRANT))
      throw error(
        'permission_denied',
        'The caller cannot register capabilities.',
      );
    const parsed = registerDefinition.params.safeParse(raw);
    const onCapabilities = this.options.onCapabilities;
    if (!parsed.success || !onCapabilities)
      throw error('invalid_argument', 'Invalid capability registration.');
    const { capabilities, _meta } = parsed.data;
    // A digest of the key-order-independent value keeps retained history small.
    const canonical = createHash('sha256')
      .update(stableStringify(capabilities))
      .digest('hex');
    const prior = this.keys.get(_meta.idempotencyKey);
    if (prior) {
      if (prior.canonical === canonical) return prior.result;
      throw error(
        'conflict',
        'The idempotency key was used with other capabilities.',
        {
          retry: { kind: 'after_refresh', resource: CAPABILITIES_REGISTER },
        },
      );
    }
    if (this.registering)
      throw error('conflict', 'A capability registration is in progress.', {
        code: 'core.client.capabilities.revisionConflict',
        retry: { kind: 'after_refresh', resource: CAPABILITIES_REGISTER },
      });
    const names = capabilities.map((capability) => capability.name);
    if (new Set(names).size !== names.length)
      throw error('invalid_argument', 'Capability names must be unique.');
    // Evicting an outcome would let its key re-forward stale capabilities.
    if (this.keys.size >= MAX_REMEMBERED_KEYS)
      throw error(
        'resource_exhausted',
        'This connection has used all its registration keys; reconnect to register again.',
      );
    const forwarding = Promise.resolve().then(() =>
      onCapabilities(this.caller, capabilities),
    );
    this.registering = forwarding.catch(() => undefined);
    try {
      await forwarding;
    } catch {
      throw error('internal', 'The capability registration failed.');
    } finally {
      this.registering = null;
    }
    this.registered = true;
    this.revision += 1;
    const result = {
      registrationRevision: this.revision,
      effectiveCapabilities: names,
    };
    this.keys.set(_meta.idempotencyKey, { canonical, result });
    return result;
  }

  /** Waits for an in-flight forward so the drop is the host's last word. */
  private async dropCapabilities(): Promise<void> {
    await this.registering;
    if (!this.registered || !this.options.onCapabilities) return;
    this.registered = false;
    try {
      await this.options.onCapabilities(this.caller, []);
    } catch {
      // The connection is gone; a failing host hook has no one to report to.
    }
  }
}

/**
 * Interim in-memory binding: one framed L0 pair per call, served by the
 * in-process dispatcher under the bound caller. Closes when `signal` aborts.
 */
export function createInterimInMemoryBindingProvider(
  dispatcher: DesktopCanopyDispatcher,
  options: InterimInMemoryBindingOptions = {},
): RelayBindingProvider {
  return async ({ caller, webContentsId, signal }) => {
    const cancelled = (): CanopyOperationError =>
      error('cancelled', 'The relay connection was cancelled.');
    if (signal.aborted) throw cancelled();
    const parsedCaller = CanopyCallerDescriptorSchema.safeParse(caller);
    if (!parsedCaller.success)
      throw error('unauthenticated', 'Caller authentication is invalid.');
    const pair = await createInMemoryFramedPair({
      secret: randomUUID(),
      maxFrameBytes: MAX_FRAME_BYTES,
    });
    const { client } = pair;
    const close = (): void => client.close(cancelled().payload);
    signal.addEventListener('abort', close, { once: true });
    client.signal.addEventListener(
      'abort',
      () => signal.removeEventListener('abort', close),
      { once: true },
    );
    const relay = new RelayConnection(
      pair.server,
      dispatcher,
      parsedCaller.data,
      webContentsId,
      options,
    );
    void relay.serve().catch(() => undefined);
    if (signal.aborted) close();
    return {
      connectionId: client.connectionId,
      signal: client.signal,
      send: (message, sendOptions) => client.send(message, sendOptions),
      receive: (receiveOptions) => client.receive(receiveOptions),
      openChannel: (request) => client.openChannel(request),
      onChannel: (listener, channelOptions) =>
        client.onChannel(listener, channelOptions),
      close: (closeError) => client.close(closeError),
      releaseStream: (subscriptionId) => relay.releaseStream(subscriptionId),
    };
  };
}
