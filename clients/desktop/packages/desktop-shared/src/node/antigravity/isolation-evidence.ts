import type { AntigravityExecutableSource } from './qualification-evidence';

/**
 * What one live session launched as the Canopy agent reported to
 * `scripts/antigravity/qualify-isolation.mjs`. Markers are random words the
 * probe planted in the scratch repository's skill, always-on rule, workflow,
 * AGENTS.md and GEMINI.md; a marker counts as seen when it appears in the
 * agent's text. The runtime's `available_commands_update` list is recorded
 * apart from the markers: it is a client-side list the app never shows and
 * the model does not read.
 */
export interface AntigravityIsolationCase {
  name: 'top-level' | 'resume' | 'plan-mode' | 'child';
  markersSeen: {
    skill: boolean;
    rule: boolean;
    workflow: boolean;
    agentsMd: boolean;
    geminiMd: boolean;
  };
  /** The marker Canopy injected itself through systemPrompt.append. */
  hostInstructionsSeen: boolean;
  /**
   * Tool names the model listed when asked, as it wrote them. With an MCP
   * server attached, 1.5.1 also offers its generic MCP resource tools
   * `list_resources` and `read_resource`; the host PreToolUse hook denies
   * both, since neither is a gated native tool nor `mcp_<routed server>_…`.
   */
  toolsReported: string[];
  /** Tool-call titles whose permission request reached the host. */
  permissionRequests: string[];
  toolCalls: { title: string; status: string | null }[];
  /** Null when the case sends no MCP server. */
  mcpToolCompleted: boolean | null;
  /**
   * Plan-mode case only: whether the file it asked for existed in the
   * workspace after the turn. Absent from every other case.
   */
  repositoryWriteObserved?: boolean;
  /** Every command name the runtime's `available_commands_update` named. */
  commandsAdvertised: string[];
  /**
   * Whether any advertised name is, or starts with, `canary-<hex>`, the name
   * the planted skill and workflow share, so the two cannot be told apart. Informational: the app never shows that list.
   */
  repositorySkillAdvertised: boolean;
  stopReason: string | null;
}

export interface AntigravityIsolationEvidence {
  runtimeVersion: string;
  capturedAt: string;
  launchArguments: string[];
  executableSource: AntigravityExecutableSource;
  cases: AntigravityIsolationCase[];
}

export interface AntigravityIsolationSummary {
  /** Every case ended its turn and saw none of the repository markers. */
  repositoryContentHidden: boolean;
  /** The top-level case saw the marker the host injected. */
  hostInstructionsDelivered: boolean;
  /** The top-level case's reported native tools, sorted, MCP tools left out. */
  toolSurface: string[];
  /**
   * Every case's reported native tools are within the Canopy agent's tools
   * plus manage_task, and, for a case with an MCP server attached, the
   * hook-denied MCP resource tools.
   */
  toolSurfaceBounded: boolean;
  /** The top-level `pwd` permission request reached the host. */
  hostGateReached: boolean;
  mcpDelivered: boolean;
  planModeWroteNothing: boolean;
  resumeHidden: boolean;
  childHidden: boolean;
  /**
   * Informational, not part of the exit code: the runtime's slash-command list
   * named the planted repository skill or workflow entry in at least one case. That list is
   * client-side; the app never shows it and the model does not read it.
   */
  repositorySkillAdvertised: boolean;
  /**
   * One line per field above, in order. The first nine end `: met` or
   * `: not met`; the tenth, on the slash-command list, ends `: informational`.
   */
  statements: string[];
}

/** The stdio MCP server the probe's top-level case delivers. */
export const ISOLATION_PROBE_MCP_SERVER = 'probe';

/** That server's one tool. */
export const ISOLATION_PROBE_MCP_TOOL = 'canopy_probe_echo';

/**
 * The tools the Canopy agent lists (ANTIGRAVITY_AGENT_DEFINITION in
 * runtime.ts) plus `manage_task`, which `excludeDefaultComponents` keeps.
 */
const BOUNDED_TOOLS = ['manage_task', 'read_file', 'run_command', 'write_file'];

/**
 * Offered by 1.5.1 only while an MCP server is attached; the host PreToolUse
 * hook denies both.
 */
const MCP_RESOURCE_TOOLS = ['list_resources', 'read_resource'];

/** The tools a case may report: MCP resource tools only with a server. */
function boundedToolsFor(entry: AntigravityIsolationCase): string[] {
  return entry.mcpToolCompleted === null
    ? BOUNDED_TOOLS
    : [...BOUNDED_TOOLS, ...MCP_RESOURCE_TOOLS];
}

/** 1.5.1 titles a run_command call with its command line. */
const RUN_COMMAND_TITLES = ['run_command', 'pwd'];

const MARKER_PHRASE: Record<
  keyof AntigravityIsolationCase['markersSeen'],
  string
> = {
  skill: 'skill',
  rule: 'rule',
  workflow: 'workflow',
  agentsMd: 'AGENTS.md',
  geminiMd: 'GEMINI.md',
};

const EXECUTABLE_SOURCE_PHRASE: Record<AntigravityExecutableSource, string> = {
  managed: 'managed copy',
  override: 'ANTIGRAVITY_EXECUTABLE copy',
  path: 'PATH copy',
};

/**
 * The probe's own MCP tools, left out of the native surface only in a case
 * that attached the probe's server: `mcp_probe_…` as the runtime routes it,
 * or the bare tool name. Any other `mcp_` name, or the probe's in a case
 * without the server, counts against the bound.
 */
function isProbeMcpTool(
  entry: AntigravityIsolationCase,
  name: string,
): boolean {
  return (
    entry.mcpToolCompleted !== null &&
    (name.startsWith(`mcp_${ISOLATION_PROBE_MCP_SERVER}_`) ||
      name === ISOLATION_PROBE_MCP_TOOL)
  );
}

/** A case's reported tools, deduplicated, without the probe's MCP tools. */
function nativeToolsOf(entry: AntigravityIsolationCase): string[] {
  return [
    ...new Set(
      entry.toolsReported.filter((name) => !isProbeMcpTool(entry, name)),
    ),
  ];
}

function seenMarkers(entry: AntigravityIsolationCase): string[] {
  return (Object.keys(MARKER_PHRASE) as (keyof typeof MARKER_PHRASE)[])
    .filter((key) => entry.markersSeen[key])
    .map((key) => MARKER_PHRASE[key]);
}

function ended(entry: AntigravityIsolationCase): boolean {
  return entry.stopReason === 'end_turn';
}

/** Why a case does not count, or undefined when it ended its turn. */
function unfinished(
  name: AntigravityIsolationCase['name'],
  entry: AntigravityIsolationCase | undefined,
): string | undefined {
  if (!entry) return `the ${name} case is missing`;
  if (!ended(entry))
    return `the ${name} case ended with ${entry.stopReason ?? 'no stop reason'}, not end_turn`;
  return undefined;
}

function verdict(met: boolean): string {
  return met ? 'met' : 'not met';
}

function hiddenStatement(
  name: 'resume' | 'child',
  entry: AntigravityIsolationCase | undefined,
): { met: boolean; detail: string } {
  const missing = unfinished(name, entry);
  if (missing !== undefined || !entry)
    return { met: false, detail: missing ?? '' };
  const seen = seenMarkers(entry);
  return seen.length === 0
    ? { met: true, detail: 'no repository marker seen' }
    : { met: false, detail: `saw ${seen.join(', ')}` };
}

export function summarizeIsolationEvidence(
  evidence: AntigravityIsolationEvidence,
): AntigravityIsolationSummary {
  const byName = (
    name: AntigravityIsolationCase['name'],
  ): AntigravityIsolationCase | undefined =>
    evidence.cases.find((entry) => entry.name === name);
  const top = byName('top-level');
  const plan = byName('plan-mode');

  const leaks = evidence.cases
    .map((entry) => ({ name: entry.name, seen: seenMarkers(entry) }))
    .filter((entry) => entry.seen.length > 0);
  const unended = evidence.cases.filter((entry) => !ended(entry));
  const repositoryContentHidden =
    evidence.cases.length > 0 && leaks.length === 0 && unended.length === 0;

  const topMissing = unfinished('top-level', top);
  const hostInstructionsDelivered =
    topMissing === undefined && top?.hostInstructionsSeen === true;
  const toolSurface = top ? nativeToolsOf(top).sort() : [];
  const outside = evidence.cases.flatMap((entry) => {
    const allowed = boundedToolsFor(entry);
    return nativeToolsOf(entry)
      .filter((name) => !allowed.includes(name))
      .sort()
      .map((name) => `${entry.name}: ${name}`);
  });
  const toolSurfaceBounded = outside.length === 0;
  const hostGateReached = (top?.permissionRequests ?? []).some((title) =>
    RUN_COMMAND_TITLES.includes(title.trim()),
  );
  const mcpDelivered =
    topMissing === undefined && top?.mcpToolCompleted === true;

  const planMissing = unfinished('plan-mode', plan);
  const planCompleted = (plan?.toolCalls ?? []).filter(
    (call) => call.status === 'completed',
  );
  const planModeWroteNothing =
    planMissing === undefined &&
    (plan?.permissionRequests.length ?? 0) === 0 &&
    planCompleted.length === 0 &&
    plan?.repositoryWriteObserved === false;

  const advertisedIn = evidence.cases
    .filter((entry) => entry.repositorySkillAdvertised === true)
    .map((entry) => entry.name);
  const repositorySkillAdvertised = advertisedIn.length > 0;

  const resume = hiddenStatement('resume', byName('resume'));
  const child = hiddenStatement('child', byName('child'));

  const executable = EXECUTABLE_SOURCE_PHRASE[evidence.executableSource];
  const prefix = `CAP-02: Antigravity ${evidence.runtimeVersion} (${executable}) as the Canopy agent`;
  const source = `(isolation evidence ${evidence.capturedAt})`;
  const caseList = evidence.cases.map((entry) => entry.name).join(', ');

  const statements = [
    `${prefix}: repository skill, rule, workflow, AGENTS.md and GEMINI.md hidden in every case (${caseList || 'none'})${
      leaks.length === 0
        ? ''
        : `; seen: ${leaks.map((entry) => `${entry.name}: ${entry.seen.join(', ')}`).join('; ')}`
    }${
      unended.length === 0
        ? ''
        : `; not ended: ${unended.map((entry) => `${entry.name} (${entry.stopReason ?? 'none'})`).join(', ')}`
    } ${source}: ${verdict(repositoryContentHidden)}`,
    `${prefix}: host instructions appended through systemPrompt reached the model${
      topMissing ? `; ${topMissing}` : ''
    } ${source}: ${verdict(hostInstructionsDelivered)}`,
    `${prefix}: the model reported its native tools: ${
      toolSurface.join(', ') || 'none'
    } ${source}: ${verdict(toolSurface.length > 0)}`,
    `${prefix}: every case's native tools stay within ${BOUNDED_TOOLS.join(', ')} (plus ${MCP_RESOURCE_TOOLS.join(', ')} with an MCP server attached)${
      outside.length === 0 ? '' : `; outside: ${outside.join(', ')}`
    } ${source}: ${verdict(toolSurfaceBounded)}`,
    `${prefix}: the run_command permission request reached the host${
      top
        ? `; requests: ${top.permissionRequests.join(', ') || 'none'}`
        : '; the top-level case is missing'
    } ${source}: ${verdict(hostGateReached)}`,
    `${prefix}: the delivered stdio MCP tool ${ISOLATION_PROBE_MCP_TOOL} completed${
      topMissing ? `; ${topMissing}` : ''
    } ${source}: ${verdict(mcpDelivered)}`,
    `${prefix}: plan mode sent no permission request, completed no tool call and left no file in the workspace${
      planMissing
        ? `; ${planMissing}`
        : `; requests: ${plan?.permissionRequests.join(', ') || 'none'}; completed: ${
            planCompleted.map((call) => call.title).join(', ') || 'none'
          }; file written: ${
            plan?.repositoryWriteObserved === undefined
              ? 'not recorded'
              : plan.repositoryWriteObserved
                ? 'yes'
                : 'no'
          }`
    } ${source}: ${verdict(planModeWroteNothing)}`,
    `${prefix}: a resumed session stays hidden; ${resume.detail} ${source}: ${verdict(resume.met)}`,
    `${prefix}: a delegate child (subagent owner, <profile>/native) stays hidden; ${child.detail} ${source}: ${verdict(child.met)}`,
    `${prefix}: the runtime's slash-command list ${
      repositorySkillAdvertised
        ? `named the repository skill or workflow entry in ${advertisedIn.join(', ')}`
        : 'did not name the repository skill or workflow entry'
    }; the app never shows that list and ${
      repositoryContentHidden
        ? 'the model saw no marker'
        : 'the first statement reports the markers the model saw'
    } ${source}: informational`,
  ];

  return {
    repositoryContentHidden,
    hostInstructionsDelivered,
    toolSurface,
    toolSurfaceBounded,
    hostGateReached,
    mcpDelivered,
    planModeWroteNothing,
    resumeHidden: resume.met,
    childHidden: child.met,
    repositorySkillAdvertised,
    statements,
  };
}

/**
 * 0 only when every gated statement is met, including a non-empty tool
 * surface. `repositorySkillAdvertised` is informational and never counts.
 */
export function isolationProbeExitCode(
  summary: AntigravityIsolationSummary,
): 0 | 1 {
  return summary.repositoryContentHidden &&
    summary.hostInstructionsDelivered &&
    summary.toolSurface.length > 0 &&
    summary.toolSurfaceBounded &&
    summary.hostGateReached &&
    summary.mcpDelivered &&
    summary.planModeWroteNothing &&
    summary.resumeHidden &&
    summary.childHidden
    ? 0
    : 1;
}
