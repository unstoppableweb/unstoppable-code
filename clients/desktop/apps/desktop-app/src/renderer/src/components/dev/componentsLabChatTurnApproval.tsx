import { useState, type JSX } from 'react';
import type { ApprovalPromptRequest } from '@canopy/protocol/approvals';
import {
  Button,
  ToolApprovalCard,
  ToolApprovalDock,
} from '@canopy/ui-shared/components';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const respond = (): Promise<void> => Promise.resolve();

const LONG_COMMAND = `bash -c '${Array.from({ length: 30 }, (_, index) => `echo "step ${index + 1}"`).join('\n')}'`;

const COMMAND: ApprovalPromptRequest = {
  requestId: 'command',
  title: 'Run command',
  details: { kind: 'command', command: 'rm -rf build && pnpm build' },
  suggestedTarget: { kind: 'command', pattern: 'rm -rf build*' },
};

const REQUESTS: readonly {
  readonly label: string;
  readonly request: ApprovalPromptRequest;
}[] = [
  { label: 'Command', request: COMMAND },
  {
    label: 'Command with a folder and the agent’s reason',
    request: {
      requestId: 'command-reason',
      title: 'Run command',
      description: 'The agent wants to reset the build output.',
      details: {
        kind: 'command',
        command: 'rm -rf build',
        cwd: '/workspace/app',
        reason: 'The build output is stale after the dependency bump.',
      },
      suggestedTarget: { kind: 'command', pattern: 'rm -rf build*' },
    },
  },
  {
    label: 'Long command: the preview is cut and opens in full',
    request: {
      requestId: 'command-long',
      title: 'Run command',
      details: { kind: 'command', command: LONG_COMMAND },
      suggestedTarget: { kind: 'command', pattern: 'bash -c *' },
    },
  },
  {
    label: 'File edit: old and new text',
    request: {
      requestId: 'file-edit',
      title: 'Edit file',
      details: {
        kind: 'file-write',
        path: '/workspace/app/src/routes.ts',
        displayPath: 'src/routes.ts',
        change: {
          kind: 'edit',
          oldText: "export const base = '/v1';",
          newText: "export const base = '/v2';",
        },
      },
      suggestedTarget: { kind: 'file-write', path: 'src/routes.ts' },
    },
  },
  {
    label: 'File edit that replaces every match',
    request: {
      requestId: 'file-edit-all',
      title: 'Edit file',
      details: {
        kind: 'file-write',
        path: '/workspace/app/src/routes.ts',
        displayPath: 'src/routes.ts',
        change: {
          kind: 'edit',
          oldText: 'oldName',
          newText: 'newName',
          replaceAll: true,
        },
      },
      suggestedTarget: { kind: 'file-write', path: 'src/routes.ts' },
    },
  },
  {
    label: 'New file',
    request: {
      requestId: 'file-write',
      title: 'Write file',
      details: {
        kind: 'file-write',
        path: '/workspace/app/docs/notes.md',
        displayPath: 'docs/notes.md',
        change: { kind: 'write', content: '# Notes\n\nFirst draft.\n' },
      },
      suggestedTarget: { kind: 'file-write', path: 'docs/notes.md' },
    },
  },
  {
    label: 'Large change: the preview says it was cut',
    request: {
      requestId: 'file-truncated',
      title: 'Write file',
      details: {
        kind: 'file-write',
        path: '/workspace/app/data/seed.json',
        displayPath: 'data/seed.json',
        change: {
          kind: 'write',
          content: Array.from(
            { length: 60 },
            (_, index) => `{ "id": ${index + 1} },`,
          ).join('\n'),
          truncated: true,
        },
      },
      suggestedTarget: { kind: 'file-write', path: 'data/seed.json' },
    },
  },
  {
    label: 'File write with no preview and a very long path',
    request: {
      requestId: 'file-path',
      title: 'Write file',
      details: {
        kind: 'file-write',
        path: `/workspace/app/${'nested-directory/'.repeat(8)}generated-output.ts`,
      },
    },
  },
  {
    label: 'MCP tool call',
    request: {
      requestId: 'mcp',
      title: 'Use a connected tool',
      details: {
        kind: 'mcp',
        server: 'tracker',
        tool: 'create_issue',
        paramsDisplay:
          '{\n  "title": "Flaky checkout test",\n  "team": "web"\n}',
      },
      suggestedTarget: { kind: 'mcp', server: 'tracker', tool: 'create_issue' },
    },
  },
  {
    label: 'Network access',
    request: {
      requestId: 'network',
      title: 'Allow network access',
      details: { kind: 'network', host: 'registry.example.com' },
      suggestedTarget: { kind: 'network', host: 'registry.example.com' },
    },
  },
  {
    label: 'Read a file',
    request: {
      requestId: 'tool-read',
      title: 'Claude wants to use Read',
      details: {
        kind: 'tool',
        toolName: 'Read',
        path: '/Users/sam/projects/storefront/src/checkout/cart-summary.tsx',
        displayPath: 'src/checkout/cart-summary.tsx',
      },
      suggestedTarget: { kind: 'tool', toolName: 'Read' },
    },
  },
  {
    label: 'Other tool',
    request: {
      requestId: 'tool',
      title: 'Use a tool',
      details: {
        kind: 'tool',
        toolName: 'ScheduleWakeup',
        inputSummary: 'Wake in 20 minutes to check the deploy.',
      },
      suggestedTarget: { kind: 'tool', toolName: 'ScheduleWakeup' },
    },
  },
  {
    label: 'Browser upload',
    request: {
      requestId: 'upload',
      title: 'Upload files',
      details: {
        kind: 'browser-upload',
        origin: 'https://forms.example.com',
        topOrigin: 'https://portal.example.com',
        files: [
          { displayPath: 'exports/report.csv', sizeBytes: 48_213 },
          { displayPath: 'exports/summary.pdf', sizeBytes: 3_400_000 },
        ],
      },
      suggestedTarget: {
        kind: 'browser-upload',
        origin: 'https://forms.example.com',
      },
    },
  },
  {
    label: 'Browser file request: the person chooses',
    request: {
      requestId: 'file-request',
      title: 'Choose files',
      details: {
        kind: 'browser-file-request',
        origin: 'https://forms.example.com',
        purpose: 'Attach your receipt to the expense form.',
        multiple: true,
      },
    },
  },
  {
    label: 'Asked by a subagent',
    request: { ...COMMAND, requestId: 'subagent', subagentId: 'sub-1' },
  },
];

export function ToolApprovalCardSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="Every kind of request">
        {REQUESTS.map(({ label, request }) => (
          <SpecimenCell key={request.requestId} label={label} wide>
            <div className="w-full">
              <ToolApprovalCard
                pending={request}
                onRespond={respond}
                ruleScopes
                denyReason
                denyAndStop
              />
            </div>
          </SpecimenCell>
        ))}
      </SpecimenPanel>
      <SpecimenPanel title="What the host can serve">
        <SpecimenCell
          label="No remembered rules, no reason, no stop: Allow once and Deny only"
          wide
        >
          <div className="w-full">
            <ToolApprovalCard
              pending={COMMAND}
              onRespond={respond}
              ruleScopes={false}
              denyReason={false}
              denyAndStop={false}
            />
          </div>
        </SpecimenCell>
        <SpecimenCell
          label="Read-only viewer: a hint in place of the actions"
          wide
        >
          <div className="w-full">
            <ToolApprovalCard
              pending={COMMAND}
              onRespond={respond}
              readOnlyHint={
                <span className="text-xs fg-secondary">
                  Only the chat’s owner can answer this request.
                </span>
              }
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Reason limited to 40 characters" wide>
          <div className="w-full">
            <ToolApprovalCard
              pending={COMMAND}
              onRespond={respond}
              ruleScopes
              denyReason
              reasonMaxLength={40}
            />
          </div>
        </SpecimenCell>
      </SpecimenPanel>
    </div>
  );
}

function request(id: string, command: string): ApprovalPromptRequest {
  return {
    requestId: id,
    title: `Run command ${id}`,
    details: { kind: 'command', command },
    suggestedTarget: { kind: 'command', pattern: `${command}*` },
  };
}

const QUEUE: readonly ApprovalPromptRequest[] = [
  request('1', 'pnpm install'),
  request('2', 'pnpm test'),
  request('3', 'git push origin main'),
];

/** A dock whose answered approvals leave the queue, with a way to refill it. */
function QueueDock({
  initial,
  chatKey,
}: {
  readonly initial: readonly ApprovalPromptRequest[];
  readonly chatKey: string;
}): JSX.Element {
  const [pending, setPending] = useState(initial);
  return (
    <div className="flex w-full flex-col gap-2">
      <ToolApprovalDock
        chatKey={chatKey}
        pending={pending}
        ruleScopes
        denyReason
        denyAndStop
        onRespond={(requestId): Promise<void> => {
          setPending((current) =>
            current.filter((entry) => entry.requestId !== requestId),
          );
          return Promise.resolve();
        }}
      />
      {pending.length === 0 ? (
        <div className="flex items-center gap-2 text-xs fg-tertiary">
          <span>Nothing waiting: the dock is empty.</span>
          <Button
            variant="secondary"
            size="compact"
            onClick={(): void => setPending(initial)}
          >
            Refill
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function ToolApprovalDockSpecimen(): JSX.Element {
  return (
    <SpecimenPanel title="The dock above the composer">
      <SpecimenGrid min={320}>
        <SpecimenCell label="One approval: the card alone">
          <QueueDock chatKey="lab-one" initial={QUEUE.slice(0, 1)} />
        </SpecimenCell>
        <SpecimenCell label="Three approvals: count and arrows; answering moves on">
          <QueueDock chatKey="lab-three" initial={QUEUE} />
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}
