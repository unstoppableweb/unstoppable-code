// Compatibility import for CLI and desktop composition; the daemon uses the platform owner.
export {
  withW5ProcessFileLocks,
  worktreeListProcessLock,
  W5ProcessFileLockTimeoutError,
} from '@canopy/core-platform/w5-process-file-lock';
