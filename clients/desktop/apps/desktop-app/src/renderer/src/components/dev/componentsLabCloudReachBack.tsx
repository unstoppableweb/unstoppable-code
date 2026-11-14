import type { JSX } from 'react';
import {
  CloudReachBackSection,
  ReachBackApprovalDialog,
  type CloudReachBackCall,
  type CloudReachBackTool,
} from '@canopy/ui-app/capability';
import { SpecimenCell, SpecimenPanel } from './componentsLabParts';

/** Fixture tools and calls; nothing reaches main. */
const TOOLS: readonly CloudReachBackTool[] = [
  { name: 'list_issues' },
  { name: 'create_issue' },
  { name: 'delete_repo' },
];
const loadTools = (): Promise<readonly CloudReachBackTool[]> =>
  Promise.resolve(TOOLS);
const done = (): Promise<void> => Promise.resolve();

const CALLS: readonly CloudReachBackCall[] = [
  {
    at: '2026-11-10T19:04:00.000Z',
    chatTitle: 'Plan the launch',
    toolName: 'create_issue',
    decision: 'asked_allowed',
  },
  {
    at: '2026-11-10T19:02:00.000Z',
    chatTitle: 'Plan the launch',
    toolName: 'list_issues',
    decision: 'allowed_without_asking',
  },
  {
    at: '2026-11-10T18:55:00.000Z',
    chatTitle: 'Triage bugs',
    toolName: 'delete_repo',
    decision: 'tool_not_allowed',
  },
];

const formatTimestamp = (iso: string): string =>
  new Date(iso).toISOString().slice(11, 16);

/**
 * Cloud chats on a desktop MCP server (CAN-6176 PR 7c), rendered from
 * fixtures: the MCP server page's row while off and while on with recent
 * calls. Allow… opens the opt-in dialog.
 */
export function CloudReachBackSpecimen(): JSX.Element {
  return (
    <SpecimenPanel title="CloudReachBackSection (fixture render)">
      <SpecimenCell label="Off: cloud chats can't reach this server" wide>
        <div className="w-full" data-testid="lab-reach-back-off">
          <CloudReachBackSection
            serverName="Tracker"
            state={null}
            loadTools={loadTools}
            onAllow={done}
            onTurnOff={done}
            calls={[]}
            formatTimestamp={formatTimestamp}
          />
        </div>
      </SpecimenCell>
      <SpecimenCell
        label="On with two tools, one running without asking, and recent calls"
        wide
      >
        <div className="w-full" data-testid="lab-reach-back-on">
          <CloudReachBackSection
            serverName="Tracker"
            state={{
              enabledTools: ['list_issues', 'create_issue'],
              allowWithoutAsking: ['list_issues'],
            }}
            loadTools={loadTools}
            onAllow={done}
            onTurnOff={done}
            calls={CALLS}
            formatTimestamp={formatTimestamp}
          />
        </div>
      </SpecimenCell>
    </SpecimenPanel>
  );
}

/** The main window's reach-back prompt, rendered from a fixture request. */
export function CloudReachBackPromptSpecimen(): JSX.Element {
  return (
    <SpecimenPanel title="ReachBackApprovalDialog (fixture render)">
      <ReachBackApprovalDialog
        pending={{
          requestId: 'lab-reach-back',
          title: 'Plan the launch wants to run create_issue on this computer',
          description:
            'From the Tracker server. It runs here and its result goes to the cloud chat.',
          details: {
            kind: 'tool',
            toolName: 'create_issue',
            inputSummary: '{"title":"Launch checklist","labels":["release"]}',
          },
        }}
        onRespond={done}
      />
    </SpecimenPanel>
  );
}
