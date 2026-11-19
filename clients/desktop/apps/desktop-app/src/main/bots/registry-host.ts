import { readFile, readdir, rename, unlink } from 'node:fs/promises';
import { getBotsRegistryFilePath } from '../lib/paths';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { isBotsExperimentEnabled } from './gate';
import { savedLocalProjectExists } from './saved-projects';
import type { BotRegistryStoreDependencies } from './registry-store';

export function botRegistryHostDependencies(): BotRegistryStoreDependencies {
  return {
    filePath: getBotsRegistryFilePath(),
    now: (): Date => new Date(),
    isEnabled: isBotsExperimentEnabled,
    projectExists: savedLocalProjectExists,
    fileSystem: {
      readFile: async (filePath: string, encoding: 'utf8'): Promise<string> =>
        readFile(filePath, encoding),
      rename: async (oldPath: string, newPath: string): Promise<void> =>
        rename(oldPath, newPath),
      readdir: async (directoryPath: string): Promise<string[]> =>
        readdir(directoryPath),
      unlink: async (filePath: string): Promise<void> => unlink(filePath),
    },
    log: (message: string, error: unknown): void =>
      logMainProcessWarn(`[bots] ${message}`, error),
  };
}
