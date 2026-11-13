import { dirname } from 'node:path';
import { worktreeListProcessLock } from '@canopy/execution-engine/node/w5-host-cohort/process-file-lock';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { windowsW5ConfinedFileReader } from '@canopy/core-platform/w5-confined-read';
import {
  W5CommitLogRequestHandler as W5PortableRequestHandler,
  type W5CommitLog,
  type W5CommitLogRequest,
  type W5CommitLogWorkerHost,
  type W5RecoveryReport,
} from '@canopy/core-runtime/node/w5/commit-log';
import { desktopW5Durability } from '@canopy/desktop-shared/node/w5-commit-log/durability';
import type { DesktopW5CommitLogWorkerData } from './commit-log-worker-contract';

export {
  MALFORMED_REQUEST_MESSAGE,
  toW5CommitLogWorkerError,
} from '@canopy/core-runtime/node/w5/commit-log';

/**
 * What the desktop worker supplies the portable worker body: the desktop's
 * durability, its trusted OS and, on win32, reads confined through the
 * owned-child addon the host names. The addon loads on the first capture;
 * without it Windows capture refuses.
 */
export function desktopW5CommitLogWorkerHost(
  confinementAddon: string | undefined,
  dataRoot?: string,
): W5CommitLogWorkerHost {
  const os = hostOperatingSystem();
  return {
    durability: desktopW5Durability,
    ...(dataRoot === undefined
      ? {}
      : { processLock: worktreeListProcessLock(dataRoot) }),
    os,
    confinedReader: windowsW5ConfinedFileReader(os, confinementAddon),
  };
}

/** The portable request handler over {@link desktopW5CommitLogWorkerHost}. */
export class W5CommitLogRequestHandler {
  private readonly handler: W5PortableRequestHandler;

  constructor(
    log: W5CommitLog,
    data: DesktopW5CommitLogWorkerData,
    recovery: W5RecoveryReport,
  ) {
    const host = desktopW5CommitLogWorkerHost(
      data.confinementAddon,
      data.dataRoot ?? dirname(data.root),
    );
    this.handler = new W5PortableRequestHandler(
      log,
      data,
      recovery,
      host.durability,
      host.os,
      host.confinedReader,
      host.processLock,
    );
  }

  run(request: W5CommitLogRequest): Promise<unknown> {
    return this.handler.run(request);
  }
}
