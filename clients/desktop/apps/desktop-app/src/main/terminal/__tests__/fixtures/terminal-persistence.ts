import type {
  PersistedWorktreeTerminalStateFile,
  TerminalSession,
} from '@canopy/desktop-shared/types';

export function session(id: string, worktreeId = 'w'): TerminalSession {
  return {
    id,
    projectId: 'p',
    worktreeId,
    shell: '/bin/zsh',
    shellBasename: 'zsh',
    cwd: '/workspace',
    createdAt: 1,
  };
}
export function fixture(
  duplicates = false,
): PersistedWorktreeTerminalStateFile {
  return {
    version: 1,
    drawerCollapsed: false,
    groups: duplicates
      ? [
          {
            id: 'g',
            terminalIds: ['a', 'a', 'b'],
            focusedTerminalId: 'a',
            splitSizes: [0.2, 0.3, 0.5],
          },
          {
            id: 'g',
            terminalIds: ['a'],
            focusedTerminalId: 'a',
            splitSizes: [1],
          },
        ]
      : [
          {
            id: 'g',
            terminalIds: ['a', 'b'],
            focusedTerminalId: 'b',
            splitSizes: [0.25, 0.75],
          },
        ],
    activeGroupId: 'g',
    groupOrdinals: { g: 7 },
    nextGroupOrdinal: 8,
    terminalCustomNames: { a: 'API', b: 'Build' },
    groupCustomNames: { g: 'Development' },
    terminals: (duplicates
      ? [
          ['a', 'first-a'],
          ['a', 'second-a'],
          ['b', 'B0'],
          ['u', 'ungrouped'],
        ]
      : [
          ['a', 'A0'],
          ['b', 'B0'],
        ]
    ).map(([id, text]) => ({
      session: session(id),
      scrollbackLines: [text],
      exitCode: null,
      signal: null,
    })),
  };
}
