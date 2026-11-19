// Golden (VIEW-03, CHAT-03, CHAT-06): the live qualification probe
// (scripts/antigravity/qualify-runtime.mjs) records what a real Antigravity
// session reported. This summarizer turns that file into the exact checklist
// statements, so a docs commit cannot claim more than the evidence shows.
import {
  classifyNativeToolCall,
  qualificationPermissionDecision,
  qualificationWorkspaceRoots,
  redactQualificationPaths,
  toolCallFailureDetail,
  qualificationProbeExitCode,
  summarizeQualificationEvidence,
  type AntigravityQualificationEvidence,
} from '../qualification-evidence';

function evidence(
  overrides: Partial<AntigravityQualificationEvidence> = {},
): AntigravityQualificationEvidence {
  return {
    runtimeVersion: '1.5.1',
    capturedAt: '2026-11-17T12:00:00.000Z',
    sessionCapabilities: {},
    toolCallTitles: ['read_file', 'write_file', 'run_command'],
    additionalDirectories: { advertised: false, accepted: null },
    deniedOrFailedToolCalls: [],
    ...overrides,
  };
}

describe('summarizeQualificationEvidence', () => {
  it('reports matching native titles', () => {
    const summary = summarizeQualificationEvidence(
      evidence({
        toolCallTitles: [
          'read_file',
          'write_file',
          'run_command',
          'mcp_gh_list',
        ],
      }),
    );
    expect(summary.nativeTitlesMatch).toBe(true);
    expect(summary.unknownTitles).toEqual([]);
  });

  it('reports unknown titles', () => {
    const summary = summarizeQualificationEvidence(
      evidence({ toolCallTitles: ['readFile', 'run_command'] }),
    );
    expect(summary.nativeTitlesMatch).toBe(false);
    expect(summary.unknownTitles).toEqual(['readFile']);
  });

  it('lists each unknown title once, in first-seen order', () => {
    expect(
      summarizeQualificationEvidence(
        evidence({
          toolCallTitles: ['Shell', 'read_file', 'Shell', 'mcp_', 'mcp_gh'],
        }),
      ).unknownTitles,
    ).toEqual(['Shell', 'mcp_', 'mcp_gh']);
  });

  it('reports additional directories only when advertised and accepted', () => {
    expect(
      summarizeQualificationEvidence(
        evidence({
          additionalDirectories: { advertised: true, accepted: true },
        }),
      ).additionalDirectoriesSupported,
    ).toBe(true);
    expect(
      summarizeQualificationEvidence(
        evidence({
          additionalDirectories: { advertised: false, accepted: null },
        }),
      ).additionalDirectoriesSupported,
    ).toBe(false);
    expect(
      summarizeQualificationEvidence(
        evidence({
          additionalDirectories: { advertised: true, accepted: false },
        }),
      ).additionalDirectoriesSupported,
    ).toBe(false);
  });

  it('produces one statement per row in order', () => {
    expect(
      summarizeQualificationEvidence(
        evidence({
          toolCallTitles: ['read_file', 'write_file', 'run_command'],
          additionalDirectories: { advertised: true, accepted: true },
        }),
      ).statements,
    ).toEqual([
      'VIEW-03: Antigravity 1.5.1 read calls completed: 1; write: 1; execute: 1; titles are the legacy read_file/write_file/run_command names (live evidence 2026-11-17T12:00:00.000Z).',
      'CHAT-03: Antigravity 1.5.1 sent 3 tool calls, every one identified as read, write, execute or mcp_<server>_<tool> (live evidence 2026-11-17T12:00:00.000Z).',
      'CHAT-06: Antigravity 1.5.1 advertised additionalDirectories and accepted a session with one (live evidence 2026-11-17T12:00:00.000Z).',
    ]);
  });

  it('states what is missing when the evidence falls short', () => {
    expect(
      summarizeQualificationEvidence(
        evidence({
          toolCallTitles: ['read_file', 'Shell'],
          additionalDirectories: { advertised: true, accepted: false },
        }),
      ).statements,
    ).toEqual([
      'VIEW-03: Antigravity 1.5.1 read calls completed: 1; write: 0; execute: 0; titles are the legacy read_file/write_file/run_command names (live evidence 2026-11-17T12:00:00.000Z).',
      'CHAT-03: Antigravity 1.5.1 sent 2 tool calls with unrecognized titles: Shell (live evidence 2026-11-17T12:00:00.000Z).',
      'CHAT-06: Antigravity 1.5.1 advertised additionalDirectories but refused a session with one (live evidence 2026-11-17T12:00:00.000Z).',
    ]);
    expect(summarizeQualificationEvidence(evidence()).statements[2]).toBe(
      'CHAT-06: Antigravity 1.5.1 did not advertise additionalDirectories, so the field is omitted (live evidence 2026-11-17T12:00:00.000Z).',
    );
  });
});

describe('denied and failed tool calls', () => {
  it('does not count a denied call toward native titles and names it', () => {
    const summary = summarizeQualificationEvidence(
      evidence({
        toolCallTitles: ['read_file', 'run_command'],
        deniedOrFailedToolCalls: [
          {
            title: 'write_file',
            reason: 'denied: path is outside the temporary workspace',
          },
        ],
      }),
    );
    expect(summary.nativeTitlesMatch).toBe(false);
    expect(summary.unknownTitles).toEqual([]);
    expect(summary.statements.slice(0, 2)).toEqual([
      'VIEW-03: Antigravity 1.5.1 read calls completed: 1; write: 0; execute: 1; titles are the legacy read_file/write_file/run_command names; denied or failed, not counted: write_file (denied: path is outside the temporary workspace) (live evidence 2026-11-17T12:00:00.000Z).',
      'CHAT-03: Antigravity 1.5.1 sent 3 tool calls, every one identified as read, write, execute or mcp_<server>_<tool>; denied or failed, not counted: write_file (denied: path is outside the temporary workspace) (live evidence 2026-11-17T12:00:00.000Z).',
    ]);
  });

  it('does not count a failed call toward native titles and names it', () => {
    const summary = summarizeQualificationEvidence(
      evidence({
        toolCallTitles: ['read_file', 'write_file'],
        deniedOrFailedToolCalls: [{ title: 'run_command', reason: 'failed' }],
      }),
    );
    expect(summary.nativeTitlesMatch).toBe(false);
    expect(summary.statements[0]).toBe(
      'VIEW-03: Antigravity 1.5.1 read calls completed: 1; write: 1; execute: 0; titles are the legacy read_file/write_file/run_command names; denied or failed, not counted: run_command (failed) (live evidence 2026-11-17T12:00:00.000Z).',
    );
  });

  it('names an unrecognized title even when the call was denied', () => {
    expect(
      summarizeQualificationEvidence(
        evidence({
          deniedOrFailedToolCalls: [
            { title: 'list_dir', reason: 'denied: not a recognized request' },
          ],
        }),
      ).unknownTitles,
    ).toEqual(['list_dir']);
  });

  it('says no tool calls were sent rather than claiming every title matched', () => {
    expect(
      summarizeQualificationEvidence(evidence({ toolCallTitles: [] }))
        .statements[1],
    ).toBe(
      'CHAT-03: Antigravity 1.5.1 sent no tool calls (live evidence 2026-11-17T12:00:00.000Z).',
    );
  });
});

// Run 1 (Antigravity 1.5.1, 2026-11-18): titles were human-readable
// ("File README.md") with kind "read" and input key Path; the read in the
// additional directory was denied by the probe's own policy and the other read
// failed with no captured reason.
const run1ToolCalls = [
  {
    title: 'File ../additional/README.md',
    kind: 'read',
    inputKeys: ['Path'],
    status: 'failed',
    decision: {
      decision: 'deny' as const,
      reason: 'path is outside the temporary workspace',
    },
  },
  {
    title: 'File README.md',
    kind: 'read',
    inputKeys: ['Path'],
    status: 'completed',
  },
];

describe('classifyNativeToolCall', () => {
  it('identifies human-readable titles by kind and input keys', () => {
    expect(
      classifyNativeToolCall({
        title: 'File README.md',
        kind: 'read',
        inputKeys: ['Path'],
      }),
    ).toBe('read');
    for (const key of ['TargetFile', 'AbsolutePath'])
      expect(
        classifyNativeToolCall({ title: 'x', kind: 'read', inputKeys: [key] }),
      ).toBe('read');
    expect(
      classifyNativeToolCall({
        title: 'Edit probe.txt',
        kind: 'edit',
        inputKeys: ['Content', 'TargetFile'],
      }),
    ).toBe('write');
    expect(
      classifyNativeToolCall({
        title: 'Run pwd',
        kind: 'execute',
        inputKeys: ['CommandLine', 'Cwd'],
      }),
    ).toBe('execute');
    expect(
      classifyNativeToolCall({
        title: 'Run pwd',
        kind: 'execute',
        inputKeys: ['Command'],
      }),
    ).toBe('execute');
  });

  it('still maps the exact legacy titles and mcp_<server>_<tool>', () => {
    expect(classifyNativeToolCall({ title: 'read_file' })).toBe('read');
    expect(classifyNativeToolCall({ title: 'write_file' })).toBe('write');
    expect(classifyNativeToolCall({ title: 'run_command' })).toBe('execute');
    expect(classifyNativeToolCall({ title: 'mcp_gh_list' })).toBe('mcp');
  });

  it('leaves a kind without its identifying input key unknown', () => {
    expect(
      classifyNativeToolCall({ title: 'File x', kind: 'read', inputKeys: [] }),
    ).toBe('unknown');
    expect(
      classifyNativeToolCall({
        title: 'Run',
        kind: 'execute',
        inputKeys: ['Path'],
      }),
    ).toBe('unknown');
    expect(classifyNativeToolCall({ title: 'Search', kind: 'search' })).toBe(
      'unknown',
    );
    expect(classifyNativeToolCall({ title: 'mcp_' })).toBe('unknown');
  });
});

describe('per-kind native tool summary', () => {
  it('reports run 1 by kind: a completed read, no write or execute', () => {
    const summary = summarizeQualificationEvidence(
      evidence({
        toolCallTitles: ['File README.md'],
        deniedOrFailedToolCalls: [
          {
            title: 'File ../additional/README.md',
            reason: 'denied: path is outside the temporary workspace',
          },
        ],
        toolCalls: run1ToolCalls,
        additionalDirectories: { advertised: true, accepted: true },
      }),
    );
    expect(summary.nativeTools).toEqual({
      read: { observed: true, completed: true },
      write: { observed: false, completed: false },
      execute: { observed: false, completed: false, commandInputKey: null },
    });
    expect(summary.observedTitleFormat).toEqual({
      format: 'human-readable',
      sample: 'File ../additional/README.md',
    });
    expect(summary.unknownTitles).toEqual([]);
    expect(summary.nativeTitlesMatch).toBe(false);
    expect(summary.statements.slice(0, 2)).toEqual([
      'VIEW-03: Antigravity 1.5.1 read calls completed: 1; write: 0; execute: 0; titles are human-readable, kind+input keys identify the tool; denied or failed, not counted: File ../additional/README.md (denied: path is outside the temporary workspace) (live evidence 2026-11-17T12:00:00.000Z).',
      'CHAT-03: Antigravity 1.5.1 sent 2 tool calls, every one identified as read, write, execute or mcp_<server>_<tool>; denied or failed, not counted: File ../additional/README.md (denied: path is outside the temporary workspace) (live evidence 2026-11-17T12:00:00.000Z).',
    ]);
  });

  it('records which command-like key identified an execute call', () => {
    const summary = summarizeQualificationEvidence(
      evidence({
        toolCallTitles: ['Run pwd'],
        toolCalls: [
          {
            title: 'Run pwd',
            kind: 'execute',
            inputKeys: ['Command', 'Cwd'],
            status: 'completed',
          },
        ],
      }),
    );
    expect(summary.nativeTools.execute).toEqual({
      observed: true,
      completed: true,
      commandInputKey: 'Command',
    });
  });

  it('reports legacy titles and keeps unidentified titles named', () => {
    const legacy = summarizeQualificationEvidence(evidence());
    expect(legacy.observedTitleFormat).toEqual({
      format: 'legacy',
      sample: 'read_file',
    });
    expect(legacy.nativeTools.write).toEqual({
      observed: true,
      completed: true,
    });
    const unknown = summarizeQualificationEvidence(
      evidence({
        toolCallTitles: ['Search'],
        toolCalls: [
          {
            title: 'Search',
            kind: 'search',
            inputKeys: ['Query'],
            status: 'completed',
          },
        ],
      }),
    );
    expect(unknown.unknownTitles).toEqual(['Search']);
    expect(unknown.statements[1]).toBe(
      'CHAT-03: Antigravity 1.5.1 sent 1 tool call with unrecognized titles: Search (live evidence 2026-11-17T12:00:00.000Z).',
    );
    expect(
      summarizeQualificationEvidence(evidence({ toolCallTitles: [] }))
        .observedTitleFormat,
    ).toEqual({ format: 'none', sample: null });
  });

  it('does not count a denied call as completed for its kind', () => {
    const summary = summarizeQualificationEvidence(
      evidence({
        toolCallTitles: [],
        toolCalls: [{ ...run1ToolCalls[0], status: 'completed' }],
      }),
    );
    expect(summary.nativeTools.read).toEqual({
      observed: true,
      completed: false,
    });
  });
});

describe('failure detail', () => {
  it('collects text content, rawOutput and error from a failed update', () => {
    expect(
      toolCallFailureDetail({
        status: 'failed',
        content: [
          { type: 'content', content: { type: 'text', text: 'no such file' } },
          { type: 'diff', path: '/x', newText: 'y' },
        ],
        rawOutput: { code: 2 },
        error: 'ENOENT',
      }),
    ).toBe('no such file\nrawOutput: {"code":2}\nerror: ENOENT');
    expect(toolCallFailureDetail({ status: 'failed' })).toBeUndefined();
  });

  it('never throws on output it cannot serialize', () => {
    const circular: Record<string, unknown> = { code: 1 };
    circular.self = circular;
    const detail = toolCallFailureDetail({
      rawOutput: circular,
      error: { size: BigInt(1) },
    });
    expect(detail).toMatch(
      /^rawOutput: \[unserializable: .+\]\nerror: \[unserializable: .+\]$/,
    );
    expect(detail).toBeDefined();
    expect(detail?.length ?? Infinity).toBeLessThanOrEqual(2048);
  });

  it('bounds the detail to 2 KB', () => {
    const detail = toolCallFailureDetail({
      content: [
        { type: 'content', content: { type: 'text', text: 'x'.repeat(5000) } },
      ],
    });
    expect(detail?.length).toBe(2048);
    expect(detail?.endsWith('…')).toBe(true);
  });

  it('names the failure detail in the statements', () => {
    expect(
      summarizeQualificationEvidence(
        evidence({
          toolCallTitles: [],
          deniedOrFailedToolCalls: [
            {
              title: 'File README.md',
              reason: 'failed',
              failureDetail: 'file not found',
            },
          ],
          toolCalls: [
            {
              title: 'File README.md',
              kind: 'read',
              inputKeys: ['Path'],
              status: 'failed',
              failureDetail: 'file not found',
            },
          ],
        }),
      ).statements[0],
    ).toBe(
      'VIEW-03: Antigravity 1.5.1 read calls completed: 0; write: 0; execute: 0; titles are human-readable, kind+input keys identify the tool; denied or failed, not counted: File README.md (failed: file not found) (live evidence 2026-11-17T12:00:00.000Z).',
    );
  });
});

describe('redactQualificationPaths', () => {
  it('replaces the scratch and additional directories in every string', () => {
    const scratch = '/private/var/folders/x/T/antigravity-qualify-ab12';
    expect(
      redactQualificationPaths(
        {
          launchArguments: ['acp', '--gemini-dir', `${scratch}/profile`],
          toolCalls: [
            {
              title:
                'File /var/folders/x/T/antigravity-qualify-ab12/additional/README.md',
              failureDetail: `missing ${scratch}/workspace/a and ${scratch}/additional`,
              inputKeys: ['Path'],
              status: null,
            },
          ],
          count: 2,
          accepted: true,
        },
        scratch,
      ),
    ).toEqual({
      launchArguments: ['acp', '--gemini-dir', '<scratch>/profile'],
      toolCalls: [
        {
          title: 'File <scratch>/additional/README.md',
          failureDetail:
            'missing <scratch>/workspace/a and <scratch>/additional',
          inputKeys: ['Path'],
          status: null,
        },
      ],
      count: 2,
      accepted: true,
    });
  });

  it('leaves a sibling directory with a longer name alone', () => {
    expect(
      redactQualificationPaths('/tmp/q-1 /tmp/q-10/x /tmp/q-1/y', '/tmp/q-1'),
    ).toBe('<scratch> /tmp/q-10/x <scratch>/y');
  });
});

describe('qualificationWorkspaceRoots', () => {
  it('allows reads and writes inside the additional directory', () => {
    const workspaceRoots = qualificationWorkspaceRoots(
      '/private/tmp/q/workspace',
      ['/private/tmp/q/additional'],
    );
    expect(workspaceRoots).toEqual([
      '/private/tmp/q/workspace',
      '/tmp/q/workspace',
      '/private/tmp/q/additional',
      '/tmp/q/additional',
    ]);
    for (const file_path of [
      '../additional/README.md',
      '/tmp/q/additional/README.md',
      '/private/tmp/q/additional/p.txt',
    ])
      expect(
        qualificationPermissionDecision({
          operation: { tool: 'Read', input: { file_path } },
          optionKinds: ['allow_once'],
          workspaceRoots,
        }),
      ).toEqual({ decision: 'allow' });
    expect(
      qualificationPermissionDecision({
        operation: { tool: 'Read', input: { file_path: '../other/x' } },
        optionKinds: ['allow_once'],
        workspaceRoots,
      }),
    ).toEqual({
      decision: 'deny',
      reason: 'path is outside the temporary workspace',
    });
  });
});

describe('qualificationPermissionDecision', () => {
  const workspaceRoots = ['/private/tmp/q/workspace', '/tmp/q/workspace'];
  const offered = ['allow_once', 'allow_always', 'reject_once'];

  it('allows reads and writes inside the workspace and the literal pwd', () => {
    for (const operation of [
      { tool: 'Read', input: { file_path: 'README.md' } },
      { tool: 'Read', input: { file_path: '/tmp/q/workspace/README.md' } },
      { tool: 'Write', input: { file_path: '/private/tmp/q/workspace/p.txt' } },
      { tool: 'Bash', input: { command: ' pwd\n' } },
    ])
      expect(
        qualificationPermissionDecision({
          operation,
          optionKinds: offered,
          workspaceRoots,
        }),
      ).toEqual({ decision: 'allow' });
  });

  it('denies everything else with a reason', () => {
    const decide = (operation?: {
      tool: string;
      input: Record<string, unknown>;
    }): ReturnType<typeof qualificationPermissionDecision> =>
      qualificationPermissionDecision({
        operation,
        optionKinds: offered,
        workspaceRoots,
      });
    expect(decide(undefined)).toEqual({
      decision: 'deny',
      reason: 'not a recognized read_file, write_file or run_command request',
    });
    expect(decide({ tool: 'Bash', input: { command: 'ls' } })).toEqual({
      decision: 'deny',
      reason: 'command is not pwd',
    });
    expect(
      decide({ tool: 'Read', input: { file_path: '/tmp/q/workspace/../x' } }),
    ).toEqual({
      decision: 'deny',
      reason: 'path is outside the temporary workspace',
    });
    expect(decide({ tool: 'Write', input: {} })).toEqual({
      decision: 'deny',
      reason: 'path is outside the temporary workspace',
    });
  });

  it('records the offered kinds when no allow_once option exists', () => {
    expect(
      qualificationPermissionDecision({
        operation: { tool: 'Bash', input: { command: 'pwd' } },
        optionKinds: ['allow_always', 'reject_once'],
        workspaceRoots,
      }),
    ).toEqual({
      decision: 'deny',
      reason:
        'the runtime offered no allow_once option (offered: allow_always, reject_once)',
    });
  });
});

describe('qualificationProbeExitCode', () => {
  it('treats only an end_turn stop as complete evidence', () => {
    expect(qualificationProbeExitCode('end_turn')).toBe(0);
    for (const stopReason of [
      'cancelled',
      'refusal',
      'max_tokens',
      'max_turn_requests',
      undefined,
    ])
      expect(qualificationProbeExitCode(stopReason)).toBe(1);
  });
});
