// Owned test process for the CAN-4498 multi-process golden. Each mode runs one
// real host admission or maintenance entry against the test's data root and
// reports JSON lines on stdout; with `hold` it stays alive until stdin closes.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { acquireW5RootPresence } from '@canopy/core-platform/w5-root-presence';
import { ExclusiveMaintenanceRefusedError } from '@canopy/core-runtime/node/maintenance/exclusive-window';
import { registerW5Host } from '@canopy/execution-engine/node/w5-host-cohort';
import { createElectronItemStoreQuiesce } from '../../item-store-maintenance';
import { admitDesktopW5Host } from '../../w5-host-admission';
import { runW5Maintenance } from '../../w5-maintenance';
import { createW5RecoveryMaintenanceContext } from '../../w5-recovery-maintenance';

// Resolves once flushed: pipe writes are asynchronous on macOS.
function write(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise((resolve) => stream.write(text, () => resolve()));
}

function report(value: unknown): Promise<void> {
  return write(process.stdout, `${JSON.stringify(value)}\n`);
}

// A refusal's reason; any other failure reports its message instead.
function reason(error: unknown): unknown {
  const value: unknown =
    typeof error === 'object' && error !== null
      ? Reflect.get(error, 'reason')
      : undefined;
  return value ?? String(error);
}

function released(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.once('end', resolve);
    process.stdin.resume();
  });
}

async function main(): Promise<number> {
  const [mode, dataRoot, arg, hold] = process.argv.slice(2);
  if (!mode || !dataRoot) throw new Error('Missing test-owned arguments');
  if (mode === 'electron') {
    // Electron's admission slot; a refusal exits 1 as exitForW5HostRefusal does.
    const admission = await admitDesktopW5Host(dataRoot);
    if (admission.kind === 'refused') {
      await report({ refused: reason(admission.error.underlying) });
      await write(process.stderr, `${admission.message}\n`);
      return 1;
    }
    // An admitted host's store write; `-` writes nothing.
    if (arg && arg !== '-') {
      mkdirSync(dirname(arg), { recursive: true });
      writeFileSync(arg, '{"version":1,"admitted":true}');
    }
  } else if (mode === 'daemon') {
    // The daemon's own presence join (core-daemon daemon.ts).
    await acquireW5RootPresence(dataRoot, 'host', 'daemon');
  } else if (mode === 'cohort') {
    await registerW5Host({ dataRoot, hostKind: 'cli' });
  } else if (mode === 'failed-window') {
    // A window whose `op` fails; `arg` says whether it may write.
    const failure: unknown = await createElectronItemStoreQuiesce(dataRoot, {
      mutating: arg === 'mutating',
    })(() => Promise.reject(new Error('uncertain step'))).catch(
      (error: unknown) => error,
    );
    await report({
      reason: reason(failure),
      held:
        failure instanceof ExclusiveMaintenanceRefusedError
          ? failure.held
          : undefined,
    });
    if (hold === 'hold') await released();
    return 0;
  } else if (mode === 'window') {
    // A window whose `op` reports it holds; with `hold` it waits for release.
    const outcome: unknown = await createElectronItemStoreQuiesce(dataRoot, {
      mutating: arg === 'mutating',
    })(async () => {
      await report({ held: true });
      if (hold === 'hold') await released();
      return 'released';
    }).catch((error: unknown) => error);
    await report(
      outcome === 'released'
        ? { released: true }
        : outcome instanceof ExclusiveMaintenanceRefusedError
          ? { reason: outcome.reason, held: outcome.held, peers: outcome.peers }
          : { reason: reason(outcome) },
    );
    return 0;
  } else if (mode === 'w5-maintenance') {
    if (!arg) throw new Error('Missing worker entry');
    let paused = false;
    const context = createW5RecoveryMaintenanceContext(dataRoot, {
      workerEntry: arg,
      // Pauses once, after its CAN-3797 record is published under the claim
      // and presence EXCLUSIVE; otherwise a no-op qualification on POSIX.
      offlineMigration:
        hold === 'hold'
          ? async (): Promise<void> => {
              if (
                paused ||
                !existsSync(join(dataRoot, 'runtime/w5-maintenance.json'))
              )
                return;
              paused = true;
              await report({ held: true });
              await released();
            }
          : undefined,
    });
    try {
      const result = await runW5Maintenance(context, {
        source: 'offline_maintenance',
        mode: 'diagnose',
      });
      await report({ completed: result.mode });
    } catch (error) {
      await report({ refused: reason(error) });
    }
    return 0;
  } else throw new Error(`Unknown mode ${mode}`);
  await report({ admitted: true });
  if (hold === 'hold') await released();
  return 0;
}

void main().then(
  (code) => process.exit(code),
  async (error: unknown) => {
    await write(
      process.stderr,
      `${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exit(2);
  },
);
