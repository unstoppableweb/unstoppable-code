import { win32 } from 'node:path';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';

/**
 * Project-storage directory name the pinned Cursor CLI derives from a working
 * directory when it looks for `<profile>/projects/<encoded>/.cursor/hooks.json`.
 *
 * This is a version-specific workaround for the CLI's hook-discovery behavior
 * (see docs/cursor-chat.md). The chat provider and the approval-check
 * diagnostic must use this one implementation: a drift between them would
 * silently stop the approval hook from being discovered on one path.
 */
export function encodeCursorProjectDir(cwd: string): string {
  return cwd
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Windows cannot use long paths as a process cwd, even with long-path I/O enabled. */
export function assertCursorHookPathBudget(
  profile: string,
  cwd: string,
  platform: NodeJS.Platform | null = hostOperatingSystem(),
): void {
  if (platform !== 'win32') return;
  const length = win32.join(
    profile,
    'projects',
    encodeCursorProjectDir(cwd),
  ).length;
  if (length >= 248) {
    // Reconnecting cannot shorten either path. Report the measured cause before
    // the CLI can replace it with a generic missing-approval-hook failure.
    throw new Error(
      `Couldn't start Cursor because its approval folder path is too long for Windows (${length} characters, maximum 247). Use a shorter data folder or workspace path, or choose another model.`,
    );
  }
}
