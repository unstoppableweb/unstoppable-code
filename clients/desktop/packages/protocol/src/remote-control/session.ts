import { z } from 'zod';
import { CanonicalMacSchema } from './security';
import { DEVICE_PLATFORMS, DEVICE_KINDS } from '../device-relay/index';
import { CanopyRetryDirectiveSchema } from '../canopy-core/errors';
import {
  REMOTE_SURFACES,
  ACCOUNT_PROXY_SIGN_IN_STATE_PATTERN,
} from './constants';

/**
 * Messages exchanged inside an encrypted session between a controlling
 * computer and the computer it controls.
 */
export const REMOTE_METHODS = {
  /** Controller → host: identify the host once the session opens. */
  hello: 'session.hello',
  /** Controller → host: run one tunneled IPC call. */
  invoke: 'ipc.invoke',
  /** Controller → host: store a file attached from the controller's disk. */
  uploadPut: 'upload.put',
  /**
   * Controller → host: read part of a host file the controller opens in its
   * own default app. Hosts released before it answer with an unknown-method
   * error, which the controller treats as "not supported".
   */
  fileRead: 'file.read',
  /** Host → controller: show a picker for a handler's file dialog. */
  dialogOpen: 'dialog.open',
  /**
   * Host → controller: show, create hidden, or hide the controller's App
   * Advisor window for the host.
   */
  appAdvisorWindow: 'appAdvisor.window',
  /**
   * Host → controller: open an account proxy sign-in page in the
   * controller's browser and catch its redirect on the controller's loopback
   * port. Controllers released before it answer with an unknown-method
   * error, and the host asks the user to update or sign in on the host.
   */
  accountProxySignInOpen: 'account-proxy.sign-in.open',
  /** Controller → host: the redirect caught for that sign-in. */
  accountProxySignInCallback: 'account-proxy.sign-in.callback',
  /** Controller → host, pairing sessions only: ask to be allowed in. */
  pairRequest: 'pair.request',
  /**
   * Controller → host, control sessions: remove the caller's own pairing (a
   * delegated hosted session removes the root it is attributed to) and end
   * its sessions. Hosts advertise it with `features.pairRevoke`; older hosts
   * answer with an unknown-method error.
   */
  pairRevoke: 'pair.revoke',
  /**
   * Controller → host: run one core operation the host lists in its hello
   * `coreOperations`. Served before the protocol check: the operation's own
   * version is the contract. Hosts released before it answer with an
   * unknown-method error.
   */
  coreCall: 'core.call',
  /** Controller → host: open a listed core stream; items come as `core.event`. */
  coreSubscribe: 'core.subscribe',
  /** Controller → host: close a stream opened with `core.subscribe`. */
  coreUnsubscribe: 'core.unsubscribe',
} as const;

export const REMOTE_EVENTS = {
  /** Host → controller: stop listening for an account proxy sign-in. */
  accountProxySignInEnded: 'account-proxy.sign-in.ended',
  /** Controller → host: fire-and-forget IPC send. */
  ipcSend: 'ipc.send',
  /** Host → controller: a push the host's main sent toward its renderers. */
  push: 'ipc.push',
  /**
   * Host → controller, right before the host closes the session on purpose,
   * so the controller does not reconnect on its own.
   */
  ended: 'session.ended',
  /**
   * Controller → host: the controller's App Advisor window for the host
   * opened, closed, gained or lost focus.
   */
  appAdvisorWindowState: 'appAdvisor.windowState',
  /** Host → controller: one frame of a core stream. */
  coreEvent: 'core.event',
} as const;

/**
 * Version of the contract between a controlling computer and the computer it
 * controls: the session messages in this file and the shapes of every
 * tunneled IPC channel. The window showing another computer runs this
 * computer's renderer against the other computer's handlers, so two computers
 * may connect only when this matches.
 *
 * Bump it in any change that an older peer would misread: a tunneled
 * channel's arguments, result or push payload changing incompatibly, a channel
 * a controller now relies on being removed or renamed, or a session message
 * changing. Additive changes an older peer tolerates do not need a bump.
 * Version 1 is every release before this check. After a bump, run
 * `pnpm run remote-control:contract:write`; see docs/remote-control-protocol.md.
 */
export const REMOTE_PROTOCOL_VERSION = 20;

/**
 * The oldest host protocol the web's browser and hosted controllers accept,
 * sent as `session.hello.controller.minVersion`. It is separate from
 * `REMOTE_PROTOCOL_VERSION` because the web deploys ahead of the desktops it
 * controls: many bumps change only what a desktop controller reads, such as
 * a Labs snapshot key, and holding the web to its own version locked it out
 * of every desktop one release behind.
 *
 * What pins it, so a bump's author can tell whether the floor must move:
 * - 19 (CAN-6187): `pipelines:execute`, a browser channel, takes `targetId`.
 *   An older host ignores it and would run a cloud run on that computer.
 * - 17: controller profiles. Host features (`controllerProfiles`,
 *   `pairingProof`, `hostedDelegation`) are checked separately.
 *
 * Raise it only when a host below the new floor would misread or mishandle
 * what the web sends or relies on, and add the reason above; never just
 * because `REMOTE_PROTOCOL_VERSION` went up. It never exceeds
 * `REMOTE_PROTOCOL_VERSION` (docs/remote-control-protocol.md, "The web
 * controller floor").
 */
export const WEB_CONTROLLER_MIN_PROTOCOL_VERSION = 19;

/** What a computer runs, as the other computer of a session sees it. */
export const RemoteVersionSchema = z.object({
  protocolVersion: z.number().int().positive(),
  /** Shown to the user only; compatibility follows `protocolVersion`. */
  appVersion: z.string().min(1).max(64),
});
export type RemoteVersion = z.infer<typeof RemoteVersionSchema>;

/**
 * Session transport features, offered in the controller's hello and
 * accepted in the host's answer. `resume: 1` is session resume across relay
 * drops (docs/remote-control-protocol.md, "Session resume"). Optional and
 * stripped by older peers, so it needs no protocol bump.
 */
export const REMOTE_TRANSPORT_RESUME_VERSION = 1;
export const RemoteTransportFeaturesSchema = z.object({
  resume: z.number().int().positive().optional(),
});
export type RemoteTransportFeatures = z.infer<
  typeof RemoteTransportFeaturesSchema
>;

/** Controller → host: the controller's version, checked before any call. */
export const HelloParamsSchema = z.object({
  version: RemoteVersionSchema,
  controller: z
    .object({
      kind: z.enum(DEVICE_KINDS),
      minVersion: z.number().int().min(1),
    })
    .optional(),
  transport: RemoteTransportFeaturesSchema.optional(),
  /** This controller understands the exact worktree-base catalogue. */
  exactWorktreeBaseBranch: z.boolean().optional(),
});
export type HelloParams = z.infer<typeof HelloParamsSchema>;

export const SessionEndedParamsSchema = z.object({
  reason: z.enum(['disconnected', 'revoked']),
});

export type RemoteSessionEndReason = z.infer<
  typeof SessionEndedParamsSchema
>['reason'];

export const RemoteSurfaceSchema = z.enum(REMOTE_SURFACES);

/**
 * A tunneled call or send, and a push. `surface` names the controller's
 * window: a call's sender, a push's only recipient. A call without one comes
 * from the main window; a push without one goes to every window.
 */
export const InvokeParamsSchema = z.object({
  channel: z.string().min(1).max(256),
  args: z.array(z.unknown()),
  surface: RemoteSurfaceSchema.optional(),
});

export const AppAdvisorWindowParamsSchema = z.object({
  /** `focus_main` brings forward the window showing this computer. */
  action: z.enum(['open', 'ensure', 'close', 'focus_main']),
  focus: z.boolean().optional(),
  /** Reveal without taking focus from another app. */
  background: z.boolean().optional(),
});
export type AppAdvisorWindowParams = z.infer<
  typeof AppAdvisorWindowParamsSchema
>;

export const AppAdvisorWindowStateParamsSchema = z.object({
  open: z.boolean(),
  focused: z.boolean(),
});
export type AppAdvisorWindowStateParams = z.infer<
  typeof AppAdvisorWindowStateParamsSchema
>;

export const UploadPutParamsSchema = z.object({
  fileName: z.string().max(1024),
  bytes: z.instanceof(Uint8Array),
});

export const UploadPutResultSchema = z.object({ path: z.string() });

/**
 * Bytes one `file.read` returns at most. Each read is one session message,
 * and the controller asks for the next part only after storing this one.
 */
export const REMOTE_FILE_READ_CHUNK_BYTES = 4 * 1024 * 1024;

/** Largest host file a controller copies to open in its own default app. */
export const REMOTE_FILE_OPEN_MAX_BYTES = 240 * 1024 * 1024;

export const REMOTE_FILE_OPEN_TOO_LARGE_MESSAGE =
  'File is too large to open from the other computer.';

/** The file a remote window asked to open, as `file:open-external` names it. */
export const RemoteFileTargetSchema = z.object({
  absolutePath: z.string().min(1).max(4096),
  projectId: z.string().min(1).max(256).optional(),
  worktreeId: z.string().min(1).max(256).optional(),
});
export type RemoteFileTarget = z.infer<typeof RemoteFileTargetSchema>;

export const FileReadParamsSchema = RemoteFileTargetSchema.extend({
  offset: z.number().int().nonnegative().max(REMOTE_FILE_OPEN_MAX_BYTES),
  length: z.number().int().positive().max(REMOTE_FILE_READ_CHUNK_BYTES),
});
export type FileReadParams = z.infer<typeof FileReadParamsSchema>;

export const FileReadResultSchema = z.object({
  /** The file's own name, after symbolic links are followed. */
  fileName: z.string().min(1).max(1024),
  sizeBytes: z.number().int().nonnegative(),
  modifiedAtMs: z.number(),
  bytes: z.instanceof(Uint8Array),
});
export type FileReadResult = z.infer<typeof FileReadResultSchema>;

/**
 * The core operations a host serves over any session, before the protocol
 * check, and their versions. A paired computer on another protocol can still
 * read and drive this computer's updates. Changes here are additive only:
 * an operation leaves the list only when its version is retired.
 */
export const REMOTE_CORE_OPERATIONS = {
  'core.update.status.get': 1,
  'core.update.events': 1,
  'core.update.check': 1,
  'core.update.download': 1,
  'core.update.apply': 1,
  'core.update.apply.cancel': 1,
} as const;
export type RemoteCoreOperation = keyof typeof REMOTE_CORE_OPERATIONS;

export const HelloResultSchema = z.object({
  name: z.string(),
  platform: z.enum(DEVICE_PLATFORMS),
  appVersion: z.string(),
  /** Missing from hosts that predate the version check. */
  version: RemoteVersionSchema.optional(),
  /** Missing from hosts that serve no core operations over the session. */
  coreOperations: z
    .record(z.string().min(1).max(256), z.number().int().positive())
    .optional(),
  features: z
    .object({
      controllerProfiles: z.boolean(),
      pairingProof: z.boolean(),
      hostedDelegation: z.boolean(),
      /** The host serves `pair.revoke`. Absent means unsupported. */
      pairRevoke: z.boolean().optional(),
      /** Both peers support explicit local:/remote: worktree base refs. */
      exactWorktreeBaseBranch: z.boolean().optional(),
    })
    .optional(),
  /** The transport features the host accepted from the hello's offer. */
  transport: RemoteTransportFeaturesSchema.optional(),
});
export type HelloResult = z.infer<typeof HelloResultSchema>;

const CoreOperationRefSchema = z.object({
  operation: z.string().min(1).max(256),
  version: z.number().int().positive(),
});

export const CoreCallParamsSchema = CoreOperationRefSchema.extend({
  params: z.unknown(),
});
export type CoreCallParams = z.infer<typeof CoreCallParamsSchema>;

/**
 * A core operation's outcome. Errors travel as their typed payload, so a
 * controller branches on `kind` and `code` as a local caller would.
 */
export const CoreCallResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      kind: z.string().min(1).max(64),
      message: z.string().max(8192),
      code: z.string().max(512).optional(),
      details: z.unknown().optional(),
      /** When and how to retry; hosts before it leave it out. */
      retry: CanopyRetryDirectiveSchema.optional(),
    }),
  }),
]);
export type CoreCallResult = z.infer<typeof CoreCallResultSchema>;

export const CoreSubscribeParamsSchema = CoreCallParamsSchema.extend({
  /** Chosen by the controller; names the stream in every `core.event`. */
  subscriptionKey: z.string().min(1).max(128),
});
export type CoreSubscribeParams = z.infer<typeof CoreSubscribeParamsSchema>;

export const CoreUnsubscribeParamsSchema = z.object({
  subscriptionKey: z.string().min(1).max(128),
});

/** One dispatcher frame: an item with its cursor, or the stream's end. */
export const CoreEventParamsSchema = z.object({
  subscriptionKey: z.string().min(1).max(128),
  frame: z.unknown(),
});
export type CoreEventParams = z.infer<typeof CoreEventParamsSchema>;

export const DialogOpenParamsSchema = z.object({
  title: z.string().max(200).optional(),
  properties: z.array(z.string()).max(16),
});
export type DialogOpenParams = z.infer<typeof DialogOpenParamsSchema>;

export const DialogOpenResultSchema = z.object({
  canceled: z.boolean(),
  filePaths: z.array(z.string()),
});
export type DialogOpenResult = z.infer<typeof DialogOpenResultSchema>;

const AccountProxySignInStateSchema = z
  .string()
  .regex(ACCOUNT_PROXY_SIGN_IN_STATE_PATTERN);

export const AccountProxySignInOpenParamsSchema = z.object({
  provider: z.enum(['claude', 'codex']),
  url: z.string().min(1).max(4096),
  state: AccountProxySignInStateSchema,
});
export type AccountProxySignInOpenParams = z.infer<
  typeof AccountProxySignInOpenParamsSchema
>;

export const AccountProxySignInCallbackParamsSchema = z
  .object({
    state: AccountProxySignInStateSchema,
    code: z.string().min(1).max(4096).nullable(),
    error: z.string().min(1).max(1024).nullable(),
  })
  .refine((value) => value.code !== null || value.error !== null);
export type AccountProxySignInCallbackParams = z.infer<
  typeof AccountProxySignInCallbackParamsSchema
>;

export const AccountProxySignInEndedParamsSchema = z.object({
  state: AccountProxySignInStateSchema,
});

export const PairRequestParamsSchema = z.object({
  kind: z.enum(DEVICE_KINDS).optional(),
  proof: CanonicalMacSchema.optional(),
  name: z.string().min(1).max(120),
  platform: z.enum(DEVICE_PLATFORMS),
});
export type PairRequestParams = z.infer<typeof PairRequestParamsSchema>;

export const PairRequestResultSchema = z.object({
  approved: z.boolean(),
  name: z.string().min(1).max(120),
  platform: z.enum(DEVICE_PLATFORMS),
});
export type PairRequestResult = z.infer<typeof PairRequestResultSchema>;

/** `pair.revoke` takes no parameters. */
export const PairRevokeParamsSchema = z.object({}).strict();
export type PairRevokeParams = z.infer<typeof PairRevokeParamsSchema>;

export const PairRevokeResultSchema = z.object({ revoked: z.literal(true) });
export type PairRevokeResult = z.infer<typeof PairRevokeResultSchema>;

export const REMOTE_PROTOCOL_MISMATCH_CODE = 'remote_protocol_mismatch';

/** A host refusing a controller on another protocol version. */
export class RemoteProtocolMismatchError extends Error {
  readonly code = REMOTE_PROTOCOL_MISMATCH_CODE;
  constructor(message: string) {
    super(message);
    this.name = 'RemoteProtocolMismatchError';
  }
}

export const CONTROLLER_REFUSED_CODE = 'remote_controller_refused';

/**
 * A host refusing a hello whose `controller` profile does not match the kind
 * the relay authenticated, or a method the controller's profile excludes.
 */
export class RemoteControllerRefusedError extends Error {
  readonly code = CONTROLLER_REFUSED_CODE;
  constructor(message: string) {
    super(message);
    this.name = 'RemoteControllerRefusedError';
  }
}

export const REMOTE_FILE_TOO_LARGE_CODE = 'remote_file_too_large';

export class RemoteFileTooLargeError extends Error {
  readonly code = REMOTE_FILE_TOO_LARGE_CODE;
  constructor() {
    super(REMOTE_FILE_OPEN_TOO_LARGE_MESSAGE);
    this.name = 'RemoteFileTooLargeError';
  }
}

export const UNKNOWN_METHOD_CODE = 'remote_unknown_method';

export function unknownMethodMessage(method: string): string {
  return `Unknown remote method ${method}.`;
}

export class UnknownRemoteMethodError extends Error {
  readonly code = UNKNOWN_METHOD_CODE;
  constructor(method: string) {
    super(unknownMethodMessage(method));
    this.name = 'UnknownRemoteMethodError';
  }
}

export const CHANNEL_UNAVAILABLE_CODE = 'remote_channel_unavailable';

export class RemoteChannelUnavailableError extends Error {
  readonly code = CHANNEL_UNAVAILABLE_CODE;
  constructor(channel: string) {
    super(`"${channel}" is not available while controlling another computer.`);
    this.name = 'RemoteChannelUnavailableError';
  }
}
