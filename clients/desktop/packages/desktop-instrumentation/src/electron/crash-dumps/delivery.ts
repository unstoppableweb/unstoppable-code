import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  CLIENT_FEATURE_FLAGS,
  type FeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { writeFileAtomicallySync } from '@canopy/execution-engine/node/lib/atomic-file';

export type MainCrashCapturePolicy = 'allow' | 'deny' | 'unavailable';

const CRASH_DUMP_NAME = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.dmp$/i;

export function isMainCrashDumpName(name: string): boolean {
  return CRASH_DUMP_NAME.test(name);
}

function missingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function persistCrashState(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileAtomicallySync(path, JSON.stringify(value), {
    mode: 0o600,
    durable: true,
  });
}

interface MainCrashDeliveryReceipts {
  read(): Promise<ReadonlySet<string>>;
  save(receipts: ReadonlySet<string>): void;
  retryPending(): void;
}

/** Records acknowledged dump UUIDs independently of the filesystem clock. */
export function createMainCrashDeliveryReceipts(
  getPath: () => string,
): MainCrashDeliveryReceipts {
  let pending: ReadonlySet<string> | undefined;

  function writePending(): void {
    if (!pending) return;
    persistCrashState(getPath(), [...pending].sort());
    pending = undefined;
  }

  function retryPending(): void {
    try {
      writePending();
    } catch {
      // Keep the acknowledged IDs in memory for another write attempt.
    }
  }

  return {
    async read(): Promise<ReadonlySet<string>> {
      if (pending) return new Set(pending);
      try {
        const raw: unknown = JSON.parse(await readFile(getPath(), 'utf8'));
        if (!Array.isArray(raw))
          throw new Error('Invalid crash delivery receipts');
        const receipts = new Set<string>();
        for (const id of raw) {
          if (typeof id !== 'string' || !isMainCrashDumpName(id))
            throw new Error('Invalid crash delivery receipt');
          receipts.add(id.toLowerCase());
        }
        return receipts;
      } catch (error) {
        if (!missingFile(error)) throw error;
        return new Set<string>();
      }
    },
    save(receipts): void {
      pending = new Set(receipts);
      writePending();
    },
    retryPending,
  };
}

export interface MainCrashAnnotation {
  readonly start: () => void;
  readonly refresh: () => void;
  readonly readPolicy: () => MainCrashCapturePolicy;
  readonly suspendForOptOut: () => void;
  readonly resumeAfterOptIn: () => void;
}

/** Process-local marker. Startup never authorizes a marker before policy loads. */
export function createMainCrashAnnotation(
  readPolicy: () => MainCrashCapturePolicy,
  writeMarker: (eligible: boolean) => void,
): MainCrashAnnotation {
  let started = false;
  let optOutPending = false;
  let marked = false;

  const currentPolicy = (): MainCrashCapturePolicy => {
    if (optOutPending) return 'deny';
    if (!started) return 'unavailable';
    try {
      return readPolicy();
    } catch {
      return 'unavailable';
    }
  };

  function refresh(): void {
    const eligible = currentPolicy() === 'allow';
    if (eligible === marked) return;
    try {
      writeMarker(eligible);
      marked = eligible;
    } catch {
      // A Crashpad failure must not block the shared preference save.
    }
  }

  return {
    start(): void {
      started = true;
      refresh();
    },
    refresh,
    readPolicy: currentPolicy,
    suspendForOptOut(): void {
      optOutPending = true;
      refresh();
    },
    resumeAfterOptIn(): void {
      optOutPending = false;
      refresh();
    },
  };
}

interface MainCrashUsagePolicy {
  preferenceOptOut: boolean;
  organizationOptOut: boolean;
  contextResolved: boolean;
  effective: boolean;
}

export function resolveMainCrashCapturePolicy(
  flag: Pick<FeatureFlagSnapshot, 'status' | 'values'>,
  usage: MainCrashUsagePolicy,
  liveCaptureValue: boolean | undefined,
): MainCrashCapturePolicy {
  if (
    usage.preferenceOptOut ||
    (usage.contextResolved && usage.organizationOptOut)
  )
    return 'deny';
  if (flag.status !== 'ready' && flag.status !== 'not_configured')
    return 'unavailable';
  const effectiveCapture =
    flag.values[CLIENT_FEATURE_FLAGS.canopyPostHogCaptureEnabled.key];
  const evaluated =
    flag.status === 'ready' ? liveCaptureValue : effectiveCapture;
  if (evaluated === false) return 'deny';
  if (evaluated === undefined || !effectiveCapture) return 'unavailable';
  return usage.contextResolved && usage.effective ? 'allow' : 'unavailable';
}
