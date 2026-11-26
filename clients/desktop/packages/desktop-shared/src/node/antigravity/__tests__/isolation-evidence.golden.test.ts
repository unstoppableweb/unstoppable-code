// Golden (CAP-02, CAN-6714): the isolation probe
// (scripts/antigravity/qualify-isolation.mjs) records what real Antigravity
// sessions launched as the Canopy agent saw: repository canaries, the host's
// own instructions, the tool surface and the host gate. This summarizer turns
// that file into the statements, so no doc can claim more than the probe saw.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ANTIGRAVITY_RUNTIME_VERSION } from '../runtime-metadata';
import {
  isolationProbeExitCode,
  summarizeIsolationEvidence,
  type AntigravityIsolationCase,
  type AntigravityIsolationEvidence,
  type AntigravityIsolationSummary,
} from '../isolation-evidence';

const HIDDEN = {
  skill: false,
  rule: false,
  workflow: false,
  agentsMd: false,
  geminiMd: false,
};

function isolationCase(
  name: AntigravityIsolationCase['name'],
  overrides: Partial<AntigravityIsolationCase> = {},
): AntigravityIsolationCase {
  return {
    name,
    markersSeen: { ...HIDDEN },
    hostInstructionsSeen: name === 'top-level',
    toolsReported:
      name === 'top-level'
        ? ['write_file', 'read_file', 'run_command', 'manage_task']
        : [],
    permissionRequests: name === 'top-level' ? ['pwd'] : [],
    toolCalls:
      name === 'top-level'
        ? [
            { title: 'mcp_probe_canopy_probe_echo', status: 'completed' },
            { title: 'pwd', status: 'completed' },
          ]
        : [],
    mcpToolCompleted: name === 'top-level' ? true : null,
    ...(name === 'plan-mode' ? { repositoryWriteObserved: false } : {}),
    commandsAdvertised: [],
    repositorySkillAdvertised: false,
    stopReason: 'end_turn',
    ...overrides,
  };
}

function evidence(
  cases: AntigravityIsolationCase[] = [
    isolationCase('top-level'),
    isolationCase('resume'),
    isolationCase('plan-mode'),
    isolationCase('child'),
  ],
): AntigravityIsolationEvidence {
  return {
    runtimeVersion: '1.5.1',
    capturedAt: '2026-11-19T12:00:00.000Z',
    launchArguments: ['acp', '--agent', 'canopy'],
    executableSource: 'managed',
    cases,
  };
}

function replaced(
  name: AntigravityIsolationCase['name'],
  overrides: Partial<AntigravityIsolationCase>,
): AntigravityIsolationEvidence {
  return evidence(
    evidence().cases.map((entry) =>
      entry.name === name ? isolationCase(name, overrides) : entry,
    ),
  );
}

const BOOLEANS = [
  'repositoryContentHidden',
  'hostInstructionsDelivered',
  'toolSurfaceBounded',
  'hostGateReached',
  'mcpDelivered',
  'planModeWroteNothing',
  'resumeHidden',
  'childHidden',
] as const;

describe('summarizeIsolationEvidence', () => {
  it('meets every statement when every case hid the repository', () => {
    const summary = summarizeIsolationEvidence(evidence());
    for (const key of BOOLEANS) expect(summary[key]).toBe(true);
    expect(summary.toolSurface).toEqual([
      'manage_task',
      'read_file',
      'run_command',
      'write_file',
    ]);
    expect(summary.statements).toHaveLength(10);
    for (const statement of summary.statements.slice(0, 9))
      expect(statement).toMatch(/: met$/);
    expect(summary.repositorySkillAdvertised).toBe(false);
    expect(summary.statements[9]).toMatch(
      /slash-command list did not name the repository skill or workflow entry; the app never shows that list and the model saw no marker .*: informational$/,
    );
    expect(isolationProbeExitCode(summary)).toBe(0);
  });

  it('reports the advertised repository skill without failing the exit code', () => {
    const advertised = {
      commandsAdvertised: ['canary-0a1b2c3d', 'help'],
      repositorySkillAdvertised: true,
    };
    const summary = summarizeIsolationEvidence(
      evidence([
        isolationCase('top-level', advertised),
        isolationCase('resume', advertised),
        isolationCase('plan-mode'),
        isolationCase('child'),
      ]),
    );
    expect(summary.repositorySkillAdvertised).toBe(true);
    expect(summary.statements[9]).toMatch(
      /slash-command list named the repository skill or workflow entry in top-level, resume; the app never shows that list and the model saw no marker .*: informational$/,
    );
    for (const key of BOOLEANS) expect(summary[key]).toBe(true);
    expect(isolationProbeExitCode(summary)).toBe(0);
  });

  it('does not claim the model saw no marker when it saw one', () => {
    const summary = summarizeIsolationEvidence(
      replaced('child', {
        markersSeen: { ...HIDDEN, skill: true },
        repositorySkillAdvertised: true,
      }),
    );
    expect(summary.statements[9]).toMatch(
      /named the repository skill or workflow entry in child; the app never shows that list and the first statement reports the markers the model saw/,
    );
    expect(isolationProbeExitCode(summary)).toBe(1);
  });

  it('reports a rule the model saw', () => {
    const summary = summarizeIsolationEvidence(
      replaced('resume', { markersSeen: { ...HIDDEN, rule: true } }),
    );
    expect(summary.repositoryContentHidden).toBe(false);
    expect(summary.resumeHidden).toBe(false);
    expect(summary.statements[0]).toMatch(/resume: rule.*: not met$/);
    expect(isolationProbeExitCode(summary)).toBe(1);
  });

  it('reports a tool outside the Canopy agent', () => {
    const summary = summarizeIsolationEvidence(
      replaced('top-level', {
        toolsReported: ['read_file', 'invoke_subagent', 'run_command'],
      }),
    );
    expect(summary.toolSurfaceBounded).toBe(false);
    expect(summary.toolSurface).toEqual([
      'invoke_subagent',
      'read_file',
      'run_command',
    ]);
    expect(summary.statements[3]).toMatch(/invoke_subagent.*: not met$/);
    expect(isolationProbeExitCode(summary)).toBe(1);
  });

  it('accepts the MCP resource tools only in a case with an MCP server', () => {
    const resources = ['read_file', 'list_resources', 'read_resource'];
    const attached = summarizeIsolationEvidence(
      replaced('top-level', { toolsReported: resources }),
    );
    expect(attached.toolSurfaceBounded).toBe(true);
    expect(attached.toolSurface).toEqual([
      'list_resources',
      'read_file',
      'read_resource',
    ]);
    expect(isolationProbeExitCode(attached)).toBe(0);
    const detached = summarizeIsolationEvidence(
      replaced('child', { toolsReported: resources }),
    );
    expect(detached.toolSurfaceBounded).toBe(false);
    expect(detached.statements[3]).toMatch(
      /outside: child: list_resources, child: read_resource.*: not met$/,
    );
    expect(isolationProbeExitCode(detached)).toBe(1);
  });

  it("counts any other MCP server, or the probe's without its server", () => {
    const other = summarizeIsolationEvidence(
      replaced('child', { toolsReported: ['read_file', 'mcp_other_tool'] }),
    );
    expect(other.toolSurfaceBounded).toBe(false);
    expect(other.statements[3]).toMatch(/outside: child: mcp_other_tool/);
    expect(isolationProbeExitCode(other)).toBe(1);
    const unrouted = summarizeIsolationEvidence(
      replaced('top-level', {
        toolsReported: ['read_file', 'mcp_github_create_issue'],
      }),
    );
    expect(unrouted.toolSurfaceBounded).toBe(false);
    const detachedProbe = summarizeIsolationEvidence(
      replaced('resume', {
        toolsReported: ['read_file', 'mcp_probe_canopy_probe_echo'],
      }),
    );
    expect(detachedProbe.toolSurfaceBounded).toBe(false);
  });

  it("leaves the probe's own MCP tools out of the native tool surface", () => {
    const summary = summarizeIsolationEvidence(
      replaced('top-level', {
        toolsReported: [
          'read_file',
          'mcp_probe_canopy_probe_echo',
          'canopy_probe_echo',
        ],
      }),
    );
    expect(summary.toolSurface).toEqual(['read_file']);
    expect(summary.toolSurfaceBounded).toBe(true);
  });

  it('names a missing child case', () => {
    const summary = summarizeIsolationEvidence(
      evidence(evidence().cases.filter((entry) => entry.name !== 'child')),
    );
    expect(summary.childHidden).toBe(false);
    expect(summary.statements[8]).toMatch(/child case is missing.*: not met$/);
    expect(isolationProbeExitCode(summary)).toBe(1);
  });

  it('does not count a case that never ended its turn', () => {
    const summary = summarizeIsolationEvidence(
      replaced('child', { stopReason: 'cancelled' }),
    );
    expect(summary.childHidden).toBe(false);
    expect(summary.repositoryContentHidden).toBe(false);
  });

  it('reports host instructions, gate and MCP the top-level case missed', () => {
    const summary = summarizeIsolationEvidence(
      replaced('top-level', {
        hostInstructionsSeen: false,
        permissionRequests: [],
        mcpToolCompleted: false,
      }),
    );
    expect(summary.hostInstructionsDelivered).toBe(false);
    expect(summary.hostGateReached).toBe(false);
    expect(summary.mcpDelivered).toBe(false);
    expect(isolationProbeExitCode(summary)).toBe(1);
  });

  it('reports a plan-mode turn that reached the host or completed a tool', () => {
    const asked = summarizeIsolationEvidence(
      replaced('plan-mode', { permissionRequests: ['File hello.txt'] }),
    );
    expect(asked.planModeWroteNothing).toBe(false);
    expect(asked.statements[6]).toMatch(/File hello\.txt.*: not met$/);
    const completed = summarizeIsolationEvidence(
      replaced('plan-mode', {
        toolCalls: [{ title: 'File hello.txt', status: 'completed' }],
      }),
    );
    expect(completed.planModeWroteNothing).toBe(false);
    const written = summarizeIsolationEvidence(
      replaced('plan-mode', { repositoryWriteObserved: true }),
    );
    expect(written.planModeWroteNothing).toBe(false);
    expect(written.statements[6]).toMatch(/file written: yes.*: not met$/);
    const unrecorded = summarizeIsolationEvidence(
      replaced('plan-mode', { repositoryWriteObserved: undefined }),
    );
    expect(unrecorded.planModeWroteNothing).toBe(false);
    expect(unrecorded.statements[6]).toMatch(/file written: not recorded/);
  });

  it('fails the exit code whenever any statement is not met', () => {
    for (const key of BOOLEANS) {
      const summary = {
        ...summarizeIsolationEvidence(evidence()),
        [key]: false,
      };
      expect(isolationProbeExitCode(summary)).toBe(1);
    }
  });
});

describe('committed isolation evidence', () => {
  it('the committed 1.5.14 evidence meets every isolation statement', () => {
    const committed = JSON.parse(
      readFileSync(
        join(
          __dirname,
          '../../../../../../docs/planning/2026-11-12-antigravity-parity/evidence/isolation-1.5.14.json',
        ),
        'utf8',
      ),
    ) as AntigravityIsolationEvidence & {
      summary: AntigravityIsolationSummary;
    };
    expect(committed.runtimeVersion).toBe(ANTIGRAVITY_RUNTIME_VERSION);
    expect(committed.executableSource).toBe('managed');
    expect(committed.launchArguments.slice(-2)).toEqual(['--agent', 'canopy']);
    const { summary: stored, ...observed } = committed;
    const summary = summarizeIsolationEvidence(observed);
    // The docs quote summary.statements, so the stored copy must be current.
    expect(stored).toEqual(summary);
    expect(isolationProbeExitCode(summary)).toBe(0);
  });
});
