/**
 * One scripted paired computer for `--remote-control controller`
 * (CAN-7852): a Node process, not Electron, that the scenario app pairs with
 * and holds in one-window mode. Each peer runs in its own process, so it
 * neither delays nor is delayed by Playwright or the app.
 *
 * It runs the desktop app's own transport, bundled from the measured
 * checkout by `bundleTransportEntry` (`canopy-transport/*` imports): the relay
 * client, device keys, the encrypted handshake, resume and the RPC peer, over
 * the real `apps/device-relay` the runner starts. It answers what a desktop
 * host answers for the one-window sidebar and nothing more:
 *
 * - `pair.request` from any computer of the account, approved at once, as a
 *   person approving the prompt would; control sessions only from the
 *   controller that paired.
 * - `session.hello` in one-window mode, announcing the `sidebar` capability
 *   (the session snapshot and its stale push) and resume when offered.
 * - `ipc.invoke` of `desktop:session-snapshot`: a session snapshot holding
 *   `tasks` tasks across a few projects.
 * - Every `statusIntervalMs`, one task's status flips and the stale push
 *   `desktop:session-snapshot-stale` goes out, as the host's own snapshot
 *   invalidation sends it.
 *
 * The runner talks to it over newline-delimited JSON: lines it writes to
 * stdout start with `PEER_LINE_PREFIX`; it reads commands from stdin.
 * Configuration comes in `CANOPY_PERF_REMOTE_CONTROL_PEER` (JSON).
 */
import { generateDeviceKeyPair } from 'canopy-transport/device-key';
import { RelayClient } from 'canopy-transport/relay-client';
import {
  HelloParamsSchema,
  InvokeRequestParamsSchema,
  PairRequestParamsSchema,
  REMOTE_EVENTS,
  REMOTE_METHODS,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_TRANSPORT_RESUME_VERSION,
  DESKTOP_ONE_WINDOW_MODE,
} from 'canopy-transport/remote-protocol';
import { RpcPeer } from 'canopy-transport/rpc-peer';
import { RemoteSessionManager } from 'canopy-transport/session-manager';
import {
  PEER_LINE_PREFIX,
  SESSION_SNAPSHOT_CHANNEL,
  SESSION_SNAPSHOT_STALE_CHANNEL,
} from './peer-protocol.mjs';

const config = JSON.parse(process.env.CANOPY_PERF_REMOTE_CONTROL_PEER ?? '{}');
const { mockBaseUrl, apiKey, name, tasks, statusIntervalMs } = config;
if (
  typeof mockBaseUrl !== 'string' ||
  typeof apiKey !== 'string' ||
  typeof name !== 'string' ||
  !Number.isInteger(tasks) ||
  !Number.isInteger(statusIntervalMs)
) {
  throw new Error('CANOPY_PERF_REMOTE_CONTROL_PEER is missing or invalid.');
}

const APP_VERSION = '0.0.0-perf-peer';
const PLATFORM = 'linux';
const PROJECTS = 4;

function emit(message) {
  process.stdout.write(`${PEER_LINE_PREFIX}${JSON.stringify(message)}\n`);
}

const identity = generateDeviceKeyPair();
/** The controller key that paired; control sessions only from it. */
let pairedControllerKey = null;
/** Control sessions in their hello or serving, by RPC peer. */
const controlPeers = new Set();
let statusTimer = null;
let flips = 0;

const stats = {
  relayConnects: 0,
  relayStatusChanges: [],
  pairRequests: 0,
  controlSessions: 0,
  hellos: 0,
  snapshotsServed: 0,
  /** Bytes of the last snapshot as JSON; the wire carries it compressed. */
  lastSnapshotJsonBytes: null,
  pushesSent: 0,
  pushesRefused: 0,
  refusedRequests: [],
  sessionStates: [],
  sessionsClosed: [],
};

// ------------------------------------------------------------------ snapshot

const createdAt = new Date().toISOString();
const workspaces = Array.from({ length: PROJECTS }, (_, index) => ({
  localId: `perf-rc-project-${index + 1}`,
  name: `Perf project ${index + 1}`,
  type: 'single-repo',
  order: index,
}));
const taskStates = Array.from({ length: tasks }, (_, index) => ({
  running: false,
  lastActivityAt: createdAt,
  insertions: (index * 7) % 120,
  deletions: (index * 3) % 40,
  index,
}));

function sessionSnapshot({ includeChatSummaries = false } = {}) {
  const worktrees = taskStates.map((task) => ({
    localId: `perf-rc-task-${task.index + 1}`,
    workspaceLocalId: workspaces[task.index % PROJECTS].localId,
    branch: `perf/task-${task.index + 1}`,
    label: `Task ${task.index + 1}`,
    order: Math.floor(task.index / PROJECTS),
    status: task.running ? 'running' : 'idle',
    busy: task.running,
    isStreaming: task.running,
    createdAt,
    lastActivityAt: task.lastActivityAt,
    diffStats: { insertions: task.insertions, deletions: task.deletions },
  }));
  // Like the desktop host, only a request that asks for chat summaries gets
  // them; the default overview (`{}`) leaves them out.
  const chatSummaries = !includeChatSummaries
    ? []
    : taskStates.map((task) => ({
        localId: `perf-rc-chat-${task.index + 1}`,
        chatId: `perf-rc-chat-${task.index + 1}`,
        scope: 'worktree',
        workspaceLocalId: workspaces[task.index % PROJECTS].localId,
        worktreeLocalId: `perf-rc-task-${task.index + 1}`,
        title: `Task ${task.index + 1} chat`,
        createdAt,
        lastMessageAt: task.lastActivityAt,
        lastMessageRole: 'assistant',
        turnActive: task.running,
      }));
  return {
    workspaces,
    worktrees,
    chatProjects: [],
    standaloneChats: [],
    scriptDescriptors: [],
    scriptRuns: [],
    hookDescriptors: [],
    hookRuns: [],
    plans: [],
    pipelines: [],
    pipelineRuns: [],
    chatMessages: [],
    chatSummaries,
    terminalSessions: [],
    terminalBuffers: {},
    changedFiles: {},
    diffSnapshots: {},
    prStatuses: {},
    fileRoots: [],
    fileTree: {},
    filePreviews: {},
    refreshing: false,
    connectionStatus: 'active',
  };
}

/** Flips one task, round-robin, and tells every controller to re-read. */
function flipStatus() {
  const task = taskStates[flips % taskStates.length];
  flips += 1;
  task.running = !task.running;
  task.lastActivityAt = new Date().toISOString();
  for (const rpc of controlPeers) {
    if (!rpc.greeted) continue;
    const sent = rpc.peer.notify(REMOTE_EVENTS.push, {
      channel: SESSION_SNAPSHOT_STALE_CHANNEL,
      args: [],
    });
    if (sent) stats.pushesSent += 1;
    else stats.pushesRefused += 1;
  }
}

function syncStatusTimer() {
  const serving = Array.from(controlPeers).some((entry) => entry.greeted);
  if (serving && statusTimer === null) {
    statusTimer = setInterval(flipStatus, statusIntervalMs);
  } else if (!serving && statusTimer !== null) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
}

// ----------------------------------------------------------------- sessions

function helloResult() {
  return {
    name,
    platform: PLATFORM,
    appVersion: APP_VERSION,
    version: {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      appVersion: APP_VERSION,
    },
    features: {
      controllerProfiles: true,
      pairingProof: true,
      hostedDelegation: true,
      pairRevoke: true,
      // Only what this computer serves: the sidebar's two channels.
      oneWindow: { capabilities: ['sidebar'] },
    },
  };
}

function handlePairing(session) {
  let requested = false;
  return new RpcPeer(session, {
    onEvent: () => undefined,
    onRequest: async (method, params) => {
      // Identity only, as a desktop host answers on a pairing session.
      if (method === REMOTE_METHODS.hello) {
        HelloParamsSchema.parse(params);
        const hello = helloResult();
        delete hello.features.oneWindow;
        return hello;
      }
      if (method !== REMOTE_METHODS.pairRequest || requested) {
        throw new Error(`Unexpected pairing method ${method}.`);
      }
      requested = true;
      const request = PairRequestParamsSchema.parse(params);
      stats.pairRequests += 1;
      pairedControllerKey = session.handshake.peerPublicKey;
      emit({
        type: 'paired',
        controllerDeviceId: session.peerDeviceId,
        controllerName: request.name,
      });
      return { approved: true, name, platform: PLATFORM };
    },
  });
}

function handleControl(session) {
  stats.controlSessions += 1;
  const entry = { peer: null, greeted: false };
  session.onStateChange((state) => {
    stats.sessionStates.push({ atMs: Date.now(), state });
    emit({ type: 'session-state', state });
  });
  entry.peer = new RpcPeer(session, {
    onEvent: () => undefined,
    onRequest: async (method, params) => {
      if (method === REMOTE_METHODS.hello) {
        stats.hellos += 1;
        const hello = HelloParamsSchema.parse(params);
        if (
          hello.controller?.kind !== 'desktop' ||
          hello.controller.mode !== DESKTOP_ONE_WINDOW_MODE
        ) {
          session.setResumeNegotiated(false);
          throw new Error('This computer serves one-window controllers only.');
        }
        const resume =
          (hello.transport?.resume ?? 0) >= REMOTE_TRANSPORT_RESUME_VERSION;
        // Before the answer is sealed, as the desktop host does, so every
        // frame from here on is held for resume.
        session.setResumeNegotiated(resume);
        entry.greeted = true;
        syncStatusTimer();
        emit({ type: 'connected', controllerDeviceId: session.peerDeviceId });
        return resume
          ? {
              ...helloResult(),
              transport: { resume: REMOTE_TRANSPORT_RESUME_VERSION },
            }
          : helloResult();
      }
      if (method === REMOTE_METHODS.invoke && entry.greeted) {
        const invoke = InvokeRequestParamsSchema.parse(params);
        if (invoke.channel === SESSION_SNAPSHOT_CHANNEL) {
          const [request] = Array.isArray(invoke.args) ? invoke.args : [];
          const snapshot = sessionSnapshot(request ?? {});
          stats.snapshotsServed += 1;
          if (stats.snapshotsServed === 1)
            stats.lastSnapshotJsonBytes = Buffer.byteLength(
              JSON.stringify(snapshot),
            );
          return snapshot;
        }
        stats.refusedRequests.push(`${method}:${invoke.channel}`);
        throw new Error(`This computer does not serve ${invoke.channel}.`);
      }
      stats.refusedRequests.push(method);
      throw new Error(`Unknown remote method ${method}.`);
    },
  });
  controlPeers.add(entry);
  entry.peer.onClose((reason) => {
    controlPeers.delete(entry);
    stats.sessionsClosed.push({ atMs: Date.now(), reason });
    emit({ type: 'session-closed', reason });
    syncStatusTimer();
  });
}

const relay = new RelayClient({
  fetchToken: async () => {
    const response = await fetch(`${mockBaseUrl}/api/v1/device-relay/token`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ deviceId: identity.deviceId }),
    });
    if (!response.ok)
      throw new Error(`Relay token request failed: ${response.status}`);
    return response.json();
  },
  deviceInfo: () => ({
    deviceId: identity.deviceId,
    name,
    platform: PLATFORM,
    appVersion: APP_VERSION,
    publicKey: identity.publicKey,
    acceptsRemoteControl: true,
  }),
  onStatusChange: (status) => {
    stats.relayStatusChanges.push({ atMs: Date.now(), status });
    if (status !== 'connected') return;
    stats.relayConnects += 1;
    if (stats.relayConnects === 1)
      emit({ type: 'ready', deviceId: identity.deviceId });
  },
});

const manager = new RemoteSessionManager({
  transport: relay,
  identity: () => identity,
  authorize: (request) => {
    const grant = {
      kind: 'desktop',
      kindAuthenticated: false,
      rootDeviceId: null,
      expiresAt: null,
    };
    if (request.delegation) return null;
    if (request.purpose === 'pair') return grant;
    return pairedControllerKey !== null &&
      request.initiatorKey === pairedControllerKey
      ? grant
      : null;
  },
  onIncomingSession: (session) => {
    if (session.purpose === 'pair') handlePairing(session);
    else handleControl(session);
  },
});

relay.start();

// -------------------------------------------------------------- the runner

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  if (statusTimer !== null) clearInterval(statusTimer);
  for (const entry of controlPeers) entry.peer.close('closed');
  manager.dispose();
  relay.stop();
  emit({ type: 'stopped', stats });
  // Let stdout drain before the process ends.
  setTimeout(() => process.exit(0), 50);
}

let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  for (;;) {
    const newline = pending.indexOf('\n');
    if (newline < 0) break;
    const line = pending.slice(0, newline).trim();
    pending = pending.slice(newline + 1);
    if (!line) continue;
    let command;
    try {
      command = JSON.parse(line);
    } catch {
      continue;
    }
    if (command.type === 'stats')
      emit({ type: 'stats', id: command.id, stats });
    else if (command.type === 'stop') stop();
  }
});
// The runner went away: nothing will ask again.
process.stdin.on('end', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
