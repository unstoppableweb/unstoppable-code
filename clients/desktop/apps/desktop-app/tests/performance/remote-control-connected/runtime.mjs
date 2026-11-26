/**
 * The run-wide pieces of `--remote-control` (CAN-7852): one device relay and
 * one scripted-peer bundle per run, and the scripted peers each scenario
 * starts: paired computers (`scripted-host.mjs`) for the controller role.
 * `run.mjs`
 * starts the runtime next to the mock server and stops it when the run ends;
 * scenarios start and stop their own peers.
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { SUPERVISOR_GRACE_MS } from '../process-tree-supervisor.mjs';
import { startDeviceRelay } from '../remote-access/desktops.mjs';
import { bundleTransportEntry } from '../remote-control/bundle.mjs';
import { PEER_LINE_PREFIX } from './peer-protocol.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR_ENTRY = path.join(here, '../process-tree-supervisor.mjs');
/** The scripted peer each role connects the scenario app to. */
const PEER_ENTRIES = Object.freeze({
  controller: 'scripted-host',
});
const PEER_COMMAND_TIMEOUT_MS = 10_000;
const MAX_PEER_OUTPUT_LINES = 400;

/**
 * The scripted computers run on the same Electron binary as the measured
 * app, which `launchCanopy` takes from this runner's `electron` package, as
 * plain Node (`ELECTRON_RUN_AS_NODE`), never as an app: the transport's
 * message codec uses `v8.serialize`, and a desktop's V8 writes a serializer
 * version an older system Node cannot read, so a peer must run the same V8
 * as the app it talks to, as a real paired desktop's main process does.
 */
/**
 * Starts the run's device relay and bundles `role`'s scripted peer against
 * `buildRoot`, the checkout whose app is measured, so the peers speak that
 * checkout's transport and protocol version, on the app's own Electron.
 */
export async function startRemoteControlRuntime({ buildRoot, role }) {
  const entry = PEER_ENTRIES[role];
  if (!entry) throw new Error(`Unknown --remote-control role ${String(role)}`);
  const executable = electronPath;
  const relay = await startDeviceRelay();
  let peerBundle;
  try {
    peerBundle = await bundleTransportEntry(
      buildRoot,
      path.join(here, `${entry}.mjs`),
      { prefix: 'canopy-perf-remote-peer-', outName: `${entry}.cjs` },
    );
  } catch (error) {
    await relay.stop();
    throw error;
  }
  return {
    role,
    relay,
    peerBundle,
    executable,
    async stop() {
      await relay.stop();
      rmSync(path.dirname(peerBundle), { recursive: true, force: true });
    },
  };
}

/**
 * Starts one scripted paired computer (controller role) under the
 * process-tree supervisor, which ends it if this runner dies. Resolves once
 * it is on the relay.
 */
export function startScriptedHost(
  runtime,
  { apiKey, name, tasks, statusIntervalMs, mockBaseUrl },
) {
  return startScriptedPeer(runtime, {
    name,
    label: 'Scripted computer',
    config: { mockBaseUrl, apiKey, name, tasks, statusIntervalMs },
  });
}

async function startScriptedPeer(runtime, { name, label, config }) {
  const child = spawn(
    process.execPath,
    [SUPERVISOR_ENTRY, runtime.peerBundle],
    {
      env: {
        ...process.env,
        CANOPY_PERF_REMOTE_CONTROL_PEER: JSON.stringify(config),
        NODE_ENV: 'production',
        // Plain Node on the app's own Electron and V8.
        ELECTRON_RUN_AS_NODE: '1',
        CANOPY_E2E_OWNER_PID: String(process.pid),
        CANOPY_E2E_SUPERVISED_EXECUTABLE: runtime.executable,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  const peer = new ScriptedPeer(child, name, label);
  try {
    const ready = await peer.waitFor(
      (message) => message.type === 'ready',
      30_000,
      'reach the relay',
    );
    peer.deviceId = ready.deviceId;
    return peer;
  } catch (error) {
    await peer.stop();
    throw error;
  }
}

class ScriptedPeer {
  constructor(child, name, label) {
    this.child = child;
    this.name = name;
    this.label = label;
    this.deviceId = null;
    this.messages = [];
    this.output = [];
    this.waiters = new Set();
    this.nextCommandId = 1;
    this.exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        this.exit = { code, signal };
        for (const waiter of this.waiters) waiter.fail();
        resolve(this.exit);
      });
    });
    let pending = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        this.handleLine(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => this.record(chunk));
    // A runner that writes after the peer exited must not crash on EPIPE.
    child.stdin.on('error', () => undefined);
  }

  record(text) {
    this.output.push(String(text));
    if (this.output.length > MAX_PEER_OUTPUT_LINES) this.output.shift();
  }

  handleLine(line) {
    if (!line.startsWith(PEER_LINE_PREFIX)) {
      if (line.trim()) this.record(`${line}\n`);
      return;
    }
    let message;
    try {
      message = JSON.parse(line.slice(PEER_LINE_PREFIX.length));
    } catch {
      this.record(`${line}\n`);
      return;
    }
    this.messages.push(message);
    for (const waiter of Array.from(this.waiters)) waiter.check(message);
  }

  /** The first message (already received or later) matching `predicate`. */
  waitFor(predicate, timeoutMs, what) {
    const found = this.messages.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = {
        check: (message) => {
          if (!predicate(message)) return;
          done();
          resolve(message);
        },
        fail: () => {
          done();
          reject(
            new Error(
              `${this.label} ${this.name} exited before it could ${what} (${JSON.stringify(this.exit)}):\n${this.output.join('')}`,
            ),
          );
        },
      };
      const timer = setTimeout(() => {
        done();
        reject(
          new Error(
            `${this.label} ${this.name} did not ${what} within ${timeoutMs} ms:\n${this.output.join('')}`,
          ),
        );
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
      };
      this.waiters.add(waiter);
      if (this.exit) waiter.fail();
    });
  }

  send(command) {
    if (this.exit || this.child.stdin.destroyed) return false;
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
    return true;
  }

  /**
   * Runs one command the peer answers with `done` (the scripted
   * controller's `pair` and `connect`); returns its result or throws its
   * error.
   */
  async command(type, payload, timeoutMs) {
    const id = this.nextCommandId;
    this.nextCommandId += 1;
    if (!this.send({ ...payload, type, id }))
      throw new Error(`${this.label} ${this.name} has exited.`);
    const reply = await this.waitFor(
      (message) => message.type === 'done' && message.id === id,
      timeoutMs,
      `finish ${type}`,
    );
    if (reply.error !== undefined)
      throw new Error(
        `${this.label} ${this.name} could not ${type}: ${reply.error}\n${this.output.join('')}`,
      );
    return reply.result;
  }

  /** The peer's counters now. */
  async stats() {
    const id = this.nextCommandId;
    this.nextCommandId += 1;
    if (!this.send({ type: 'stats', id }))
      throw new Error(`${this.label} ${this.name} has exited.`);
    const reply = await this.waitFor(
      (message) => message.type === 'stats' && message.id === id,
      PEER_COMMAND_TIMEOUT_MS,
      'report its counters',
    );
    return reply.stats;
  }

  /**
   * Stops the computer and waits for its process tree to end; returns its
   * final counters, or null when it could not report them. Never throws.
   */
  async stop() {
    let stats = null;
    if (!this.exit && this.send({ type: 'stop' })) {
      stats = await this.waitFor(
        (message) => message.type === 'stopped',
        PEER_COMMAND_TIMEOUT_MS,
        'stop',
      )
        .then((message) => message.stats)
        .catch(() => null);
    }
    if (!this.exit) {
      const exited = await Promise.race([
        this.exited.then(() => true),
        new Promise((resolve) =>
          setTimeout(() => resolve(false), SUPERVISOR_GRACE_MS + 1_000),
        ),
      ]);
      if (!exited) {
        this.child.kill('SIGTERM');
        const stopped = await Promise.race([
          this.exited.then(() => true),
          new Promise((resolve) =>
            setTimeout(() => resolve(false), SUPERVISOR_GRACE_MS + 1_000),
          ),
        ]);
        if (!stopped) this.child.kill('SIGKILL');
      }
    }
    return stats;
  }
}
