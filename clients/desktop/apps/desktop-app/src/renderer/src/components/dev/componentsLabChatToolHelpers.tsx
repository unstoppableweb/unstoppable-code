import type { JSX } from 'react';
import {
  NO_TOOL_APPROVAL_WAIT,
  TOOL_APPROVAL_WAITING_LABEL,
  ToolApprovalWaitProvider,
  getToolDisplayFamily,
  getToolDisplayInfo,
  liveToolCallActivity,
  useToolApprovalWait,
  type ToolApprovalCall,
  type ToolApprovalWait,
} from '@canopy/ui-shared/components';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

// These three modules hold no component of their own: they decide what every
// tool row and live line says. The sheet reads them through small real
// consumers. Captions name the modules <tool-display>, <live-tool-activity>
// and <tool-approval-wait>.
const MODULE_TAGS = '<tool-display> <live-tool-activity> <tool-approval-wait>';

interface SampleCall extends ToolApprovalCall {
  readonly input: string;
  readonly toolUseId: string;
}

const SAMPLE_CALLS: readonly SampleCall[] = [
  {
    toolUseId: 'read-1',
    toolName: 'Read',
    input: JSON.stringify({ file_path: '/repo/src/index.ts' }),
  },
  {
    toolUseId: 'edit-1',
    toolName: 'Edit',
    input: JSON.stringify({
      file_path: '/repo/src/retry.ts',
      old_string: 'a',
      new_string: 'b',
    }),
  },
  {
    toolUseId: 'bash-1',
    toolName: 'Bash',
    input: JSON.stringify({ command: 'rm -rf build && pnpm build' }),
  },
  {
    toolUseId: 'grep-1',
    toolName: 'Grep',
    input: JSON.stringify({ pattern: 'useToolApprovalWait' }),
  },
  {
    toolUseId: 'web-1',
    toolName: 'WebFetch',
    input: JSON.stringify({ url: 'https://example.com/docs' }),
  },
  {
    toolUseId: 'bash-long',
    toolName: 'Bash',
    input: JSON.stringify({
      command:
        'pnpm exec jest packages/ui-shared/src/components/chat --coverage --runInBand --testTimeout=60000',
    }),
  },
  { toolUseId: 'custom-1', toolName: 'SomeCustomTool', input: '{}' },
  { toolUseId: 'broken-1', toolName: 'Read', input: '{not json' },
];

const WAITING_IDS: ReadonlySet<string> = new Set(['bash-1', 'edit-1']);
const WAITING_FILES: ReadonlySet<string> = new Set(['/repo/src/retry.ts']);

const HOLDING: ToolApprovalWait = {
  isCallWaiting: (call) =>
    call.toolUseId !== undefined && WAITING_IDS.has(call.toolUseId),
  isFileWaiting: (path) => WAITING_FILES.has(path),
};

/** What a host's rows say for one call: the wait label, or running. */
function WaitReadout(): JSX.Element {
  const wait = useToolApprovalWait();
  return (
    <ul className="flex w-full flex-col gap-1 text-s">
      {SAMPLE_CALLS.map((call) => {
        const info = getToolDisplayInfo(call.toolName, call.input);
        return (
          <li key={call.toolUseId} className="flex items-center gap-2">
            <span className="fg-secondary">{info.icon}</span>
            <span className="min-w-0 flex-1 truncate">{info.label}</span>
            <span className="fg-tertiary">
              {wait.isCallWaiting(call)
                ? TOOL_APPROVAL_WAITING_LABEL
                : 'Running'}
            </span>
          </li>
        );
      })}
      <li className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate">/repo/src/retry.ts</span>
        <span className="fg-tertiary">
          {wait.isFileWaiting('/repo/src/retry.ts')
            ? TOOL_APPROVAL_WAITING_LABEL
            : 'Pending'}
        </span>
      </li>
    </ul>
  );
}

export function ToolApprovalWaitSpecimen(): JSX.Element {
  return (
    <SpecimenPanel title="What waits for approval" hint={MODULE_TAGS}>
      <SpecimenCell
        label="Bash and Edit are held for approval; the file chip waits too"
        wide
      >
        <ToolApprovalWaitProvider value={HOLDING}>
          <WaitReadout />
        </ToolApprovalWaitProvider>
      </SpecimenCell>
      <SpecimenCell label="Without a provider nothing waits" wide>
        <WaitReadout />
      </SpecimenCell>
      <SpecimenCell label="An explicit empty value reads the same" wide>
        <ToolApprovalWaitProvider value={NO_TOOL_APPROVAL_WAIT}>
          <WaitReadout />
        </ToolApprovalWaitProvider>
      </SpecimenCell>
    </SpecimenPanel>
  );
}

export function LiveToolActivitySpecimen(): JSX.Element {
  return (
    <SpecimenPanel title="Live line of a running call" hint={MODULE_TAGS}>
      {[HOLDING, NO_TOOL_APPROVAL_WAIT].map((wait, index) => (
        <SpecimenCell
          key={index}
          label={
            index === 0
              ? 'Calls held for approval say so without shimmering'
              : 'Nothing waits: every line is a running call'
          }
          wide
        >
          <ul className="flex w-full flex-col gap-1 text-s">
            {SAMPLE_CALLS.map((call) => {
              const live = liveToolCallActivity(call, wait);
              return (
                <li key={call.toolUseId} className="flex items-center gap-2">
                  <span className="fg-secondary">{live.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{live.label}</span>
                  {live.waiting ? (
                    <span className="fg-tertiary">
                      {TOOL_APPROVAL_WAITING_LABEL}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </SpecimenCell>
      ))}
    </SpecimenPanel>
  );
}

const FAMILY_CASES: readonly {
  readonly label: string;
  readonly toolName: string;
  readonly input: string;
  readonly supplied?: Parameters<typeof getToolDisplayFamily>[2];
}[] = [
  { label: 'A name the table knows', toolName: 'Grep', input: '{}' },
  { label: 'A plain MCP tool', toolName: 'mcp__docs__search', input: '{}' },
  { label: 'A delegation tool', toolName: 'WaitDelegates', input: '{}' },
  {
    label: 'A supplied family wins',
    toolName: 'Read',
    input: '{}',
    supplied: 'web',
  },
  {
    label: 'A shell call that only reads is a read',
    toolName: 'Read',
    input: '{}',
    supplied: 'bash',
  },
];

export function ToolDisplaySpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="Icon and label per call" hint={MODULE_TAGS}>
        <SpecimenGrid min={260}>
          {SAMPLE_CALLS.map((call) => {
            const info = getToolDisplayInfo(call.toolName, call.input);
            return (
              <SpecimenCell key={call.toolUseId} label={call.toolName}>
                <span className="flex min-w-0 items-center gap-2 text-s">
                  <span className="fg-secondary">{info.icon}</span>
                  <span className="min-w-0 truncate">{info.label}</span>
                </span>
              </SpecimenCell>
            );
          })}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Call families" hint={MODULE_TAGS}>
        {FAMILY_CASES.map(({ label, toolName, input, supplied }) => (
          <SpecimenCell key={label} label={label} wide>
            <span className="text-s">
              {toolName} → {getToolDisplayFamily(toolName, input, supplied)}
            </span>
          </SpecimenCell>
        ))}
      </SpecimenPanel>
    </div>
  );
}
