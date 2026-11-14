// Ordinary canonical hosting is permanently daemon-only. This fence preserves
// release-skip startup/quit ordering; bootstrap has its own separately drained host.
export {
  W5CommitLogHost,
  W5CommitLogHostError,
  type W5CommitLogHostFailure,
  type W5CommitLogHostOptions,
} from '@canopy/core-runtime/node/w5/commit-log-host';
let shutDown = false;
export function shutdownW5CommitLogHost(): Promise<void> {
  shutDown = true;
  return Promise.resolve();
}
export function isW5CommitLogHostShutDown(): boolean {
  return shutDown;
}
export function runningW5CommitLogWorkers(): number {
  return 0;
}
