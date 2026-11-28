/**
 * Device-to-device Remote Control recovery run (CAN-7876), restored from the
 * `remote-access-recovery` spec that commit 5c15612d262 deleted.
 *
 * Remote Control must recover on its own from everything that breaks a
 * long-lived connection, with no action from the person: the network
 * dropping, a corrupted packet in either direction, a link that stalls with
 * its sockets still open, the relay restarting, and either computer
 * restarting. After each one, the controller's window
 * on the host works again (a terminal command runs on the host), and the
 * run records how long that took.
 */
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { closeCanopy } from '../../electron/launchCanopy.mjs';
import { registerScenario } from '../../electron/seeders/registerScenario.mjs';
import { currentMockBaseUrl } from '../mock-server.mjs';
import {
  launchDesktop,
  openRemoteWindow,
  pairDevices,
  remoteState,
  runRemoteTerminal,
  startDeviceRelay,
  startProxy,
} from './desktops.mjs';

const PROJECT_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const RECOVERY_TIMEOUT_MS = 90_000;
/** How long the stalled-socket case keeps the link silent. */
const STALL_MS = 20_000;

export async function runRecovery({ progress = {} } = {}) {
  const relay = await startDeviceRelay();
  let proxy = null;
  const running = new Map();
  const recoveredInMs = {};
  // Faults recovered so far, written to the artifact if a later one fails.
  progress.recoveredInMs = recoveredInMs;
  try {
    proxy = await startProxy({ targetPort: relay.port });
    const apiKey = `csk_remote_recovery_${randomUUID()}`;
    await registerScenario(currentMockBaseUrl(), apiKey, {
      cloud: {
        deviceRelay: {
          url: proxy.url,
          secret: relay.secret,
          userId: 'remote-access-recovery-user',
        },
      },
    });
    let host = await launchDesktop({
      label: 'b',
      demoApp: 'ts-pnpm-vite',
      apiKey,
    });
    running.set('b', host);
    let controller = await launchDesktop({ label: 'a', apiKey });
    running.set('a', controller);
    await pairDevices(controller, host);
    let remote = await openRemoteWindow(controller, host);

    /**
     * Waits until a terminal command runs on the host through the remote
     * window, retrying while the window reconnects and reloads.
     */
    let attempt = 0;
    const expectWorking = async (name, faultAt = Date.now()) => {
      // One deadline from the fault: time spent restarting, pairing and
      // reopening the window counts against it too.
      const remainingMs = faultAt + RECOVERY_TIMEOUT_MS - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          `${name} did not recover within ${String(RECOVERY_TIMEOUT_MS / 1_000)} s`,
        );
      }
      await expect
        .poll(
          async () => {
            // Each attempt prints its own marker, upper-cased by the shell,
            // so neither an earlier attempt nor the echoed command matches.
            attempt += 1;
            const marker = `done-${name}-${String(attempt)}`;
            try {
              await runRemoteTerminal(remote.window, {
                projectId: PROJECT_ID,
                worktreeId: WORKTREE_ID,
                command: `echo ${marker} | tr a-z A-Z; sleep 1`,
                marker: marker.toUpperCase(),
                timeoutMs: 15_000,
              });
              return true;
            } catch {
              return false;
            }
          },
          { timeout: remainingMs, intervals: [500, 1_000] },
        )
        .toBe(true);
      // From the fault to the first command that ran again.
      recoveredInMs[name] = Date.now() - faultAt;
    };

    /**
     * Bounds one step of a restart by the fault's deadline, so a slow
     * relaunch, pairing or window cannot run past it. A desktop that finishes
     * launching late is still closed by the run's cleanup registry.
     */
    const withinRecovery = (name, faultAt, step) => {
      step.catch(() => undefined);
      let timer;
      return Promise.race([
        step,
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `${name} did not recover within ${String(RECOVERY_TIMEOUT_MS / 1_000)} s`,
                ),
              ),
            Math.max(0, faultAt + RECOVERY_TIMEOUT_MS - Date.now()),
          );
        }),
      ]).finally(() => clearTimeout(timer));
    };

    /** Streams terminal output from the host so frames are in flight. */
    const streamOutput = (name) =>
      runRemoteTerminal(remote.window, {
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        command: `seq 1 20000; echo done-${name} | tr a-z A-Z; sleep 1`,
        marker: `DONE-${name.toUpperCase()}`,
        timeoutMs: 15_000,
      }).catch(() => null);

    await expectWorking('baseline');

    // The network goes away under both computers at once.
    let faultAt = Date.now();
    proxy.dropConnections();
    await expectWorking('network-drop', faultAt);

    // A corrupted packet toward the controller, then toward the relay. Each
    // recovery is timed from the corruption itself, as soon as the proxy
    // made it, without waiting for the command that carried it.
    proxy.corruptNext('toDesktop');
    const towardDesktop = streamOutput('stream-1');
    await expect.poll(() => proxy.corrupted(), { timeout: 30_000 }).toBe(1);
    await expectWorking('bad-packet-to-desktop', proxy.corruptionTimes()[0]);
    await towardDesktop;
    proxy.corruptNext('toRelay');
    // Desktops send little toward the relay, so send a large command from
    // the controller: its frames carry the second corruption.
    const towardRelay = runRemoteTerminal(remote.window, {
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      command: `echo ${'x'.repeat(4_000)} > /dev/null; echo done-stream-2 | tr a-z A-Z; sleep 1`,
      marker: 'DONE-STREAM-2',
      timeoutMs: 15_000,
    }).catch(() => null);
    await expect.poll(() => proxy.corrupted(), { timeout: 30_000 }).toBe(2);
    await expectWorking('bad-packet-to-relay', proxy.corruptionTimes()[1]);
    await towardRelay;

    // The link goes silent with every socket still open, longer than the
    // relay client's 10 s ping interval. Recovery is timed from when the
    // link carries traffic again.
    const resumedAt = await proxy.stall(STALL_MS);
    await expectWorking('stalled-socket', resumedAt);

    // The relay restarts.
    faultAt = Date.now();
    await withinRecovery('relay-restart', faultAt, relay.restart(1_000));
    await expectWorking('relay-restart', faultAt);

    // The host restarts, keeping its data.
    faultAt = Date.now();
    await withinRecovery(
      'host-restart',
      faultAt,
      closeCanopy(host.electronApp, host.userDataDir, { keepUserData: true }),
    );
    running.delete('b');
    host = await withinRecovery(
      'host-restart',
      faultAt,
      launchDesktop({
        label: 'b',
        demoApp: 'ts-pnpm-vite',
        apiKey,
        userDataDir: host.userDataDir,
      }),
    );
    running.set('b', host);
    host.deviceId = (
      await withinRecovery('host-restart', faultAt, remoteState(host.window))
    ).thisDevice.deviceId;
    await expectWorking('host-restart', faultAt);

    // The controller restarts: it is still paired and opens the host again.
    const hostId = host.deviceId;
    faultAt = Date.now();
    await withinRecovery(
      'controller-restart',
      faultAt,
      closeCanopy(controller.electronApp, controller.userDataDir, {
        keepUserData: true,
      }),
    );
    running.delete('a');
    controller = await withinRecovery(
      'controller-restart',
      faultAt,
      launchDesktop({
        label: 'a',
        apiKey,
        userDataDir: controller.userDataDir,
      }),
    );
    running.set('a', controller);
    await withinRecovery(
      'controller-restart',
      faultAt,
      expect
        .poll(
          async () =>
            (await remoteState(controller.window)).hosts.map(
              (entry) => entry.deviceId,
            ),
          { timeout: RECOVERY_TIMEOUT_MS },
        )
        .toContain(hostId),
    );
    remote = await withinRecovery(
      'controller-restart',
      faultAt,
      openRemoteWindow(controller, host),
    );
    await expectWorking('controller-restart', faultAt);
    await expect
      .poll(
        async () =>
          (await remoteState(host.window)).controllers.every(
            (entry) => entry.connected,
          ),
        { timeout: 30_000 },
      )
      .toBe(true);

    return { recoveredInMs, corruptedChunks: proxy.corrupted(), problems: [] };
  } finally {
    for (const desktop of running.values()) {
      await closeCanopy(desktop.electronApp, desktop.userDataDir);
    }
    await proxy?.stop();
    await relay.stop();
  }
}
