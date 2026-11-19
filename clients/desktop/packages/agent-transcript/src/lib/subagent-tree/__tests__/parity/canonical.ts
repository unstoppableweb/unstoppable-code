/**
 * Host-neutral, JSON-stable views of what the subagent panels render, so the
 * desktop and cloud projections can be compared and pinned in one golden.
 *
 * Normalisation here is purely presentational and stated per field:
 * - Transcript rows drop their React `key` and tool-use ids. Keys and ids are
 *   host-minted identities (cloud namespaces a card's child tool ids by task)
 *   that no panel shows.
 * - A desktop `blocks` row holds several display blocks where Portal parts get
 *   one row each; both render one card per block, so rows are flattened.
 * - Desktop renders blocks and the web renders Portal parts, so each content
 *   row is read from its own host's shape into the same fields.
 * - A tool row is compared as the shared tool card labels it (its rendered
 *   label and its family), not by raw name and input: desktop records a Codex
 *   command as `command` with the bare command line, the runner as `bash`
 *   with `{"command"}` arguments, and the shared card renders both alike.
 *   Tool output and its error flag stay exact.
 * Nothing else is dropped: titles, text, statuses, errors and timestamps are
 * compared as each host produced them.
 */
import type { BackgroundTask } from '@canopy/protocol/background-tasks';
import type { RemoteControlChatPart } from '@canopy/protocol/remote-control/shell';
import type { DisplayBlock } from '../../../../message-display';
import { isClaudeAgentRunning } from '../../../agent-block-state';
import type {
  RemoteControlSubagentChatTranscriptItem,
  SubagentChatTranscriptItem,
} from '../../../subagent-chat-transcript';
import type { SubagentTree } from '../../index';
import type { Json } from './golden';

/** A rendered tool label's text, without its markup and styling. */
export function toolLabelText(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** How the shared tool card labels a call: its label text and its family. */
export type DescribeTool = (
  toolName: string,
  input: string,
) => { readonly label: string; readonly family: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value as the golden file stores it: `undefined` fields are dropped. */
export function toJson(value: unknown): Json {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return value;
  if (Array.isArray(value)) return value.map((item: unknown) => toJson(item));
  if (!isRecord(value)) return null;
  const record: { [key: string]: Json } = {};
  for (const [key, field] of Object.entries(value))
    if (field !== undefined) record[key] = toJson(field);
  return record;
}

/** The tree with its node map as an id-sorted array. */
export function canonicalTree(tree: SubagentTree | null | undefined): Json {
  if (!tree) return null;
  return toJson({
    root: tree.root,
    complete: tree.complete,
    rootChildIds: tree.rootChildIds,
    nodes: Array.from(tree.nodes.values()).sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    ),
  });
}

interface CanonicalToolResult {
  readonly output: string;
  readonly isError: boolean;
}

type CanonicalRow =
  | {
      readonly kind: 'task';
      readonly sender: string;
      readonly text: string;
      readonly shownTexts?: readonly string[];
    }
  | {
      readonly kind: 'follow_up';
      readonly sender: string;
      readonly text: string;
    }
  | { readonly kind: 'user'; readonly text: string; readonly steering: boolean }
  | { readonly kind: 'divider'; readonly runGeneration: number }
  | { readonly kind: 'truncated'; readonly omittedSubBlocks: number }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'thinking'; readonly text: string }
  | {
      readonly kind: 'tool';
      readonly label: string;
      readonly family: string;
      readonly result?: CanonicalToolResult;
    }
  | {
      readonly kind: 'agent';
      readonly subagentType: string;
      readonly description: string;
      readonly prompt: string;
      readonly runInBackground: boolean;
      readonly result?: string;
      readonly running: boolean;
      readonly isError: boolean;
      readonly children: readonly CanonicalRow[];
    }
  | {
      readonly kind: 'codex_agent';
      readonly displayName: string;
      readonly description: string;
      readonly prompt: string;
      readonly status: string;
      readonly receiverThreadIds: readonly string[];
      readonly agentsStates: Json;
      readonly children: readonly CanonicalRow[];
    }
  | { readonly kind: 'unsupported'; readonly type: string };

function displayResult(
  result: { readonly output: string; readonly isError: boolean } | undefined,
): { readonly result?: CanonicalToolResult } {
  return result === undefined
    ? {}
    : { result: { output: result.output, isError: result.isError } };
}

function blockRows(
  block: DisplayBlock,
  describeTool: DescribeTool,
): CanonicalRow[] {
  switch (block.type) {
    case 'text':
      return [{ kind: 'text', text: block.text }];
    case 'thinking':
      return [{ kind: 'thinking', text: block.text }];
    case 'tool_use':
      return [
        {
          kind: 'tool',
          ...describeTool(block.toolName, block.input),
          ...displayResult(block.result),
        },
      ];
    case 'agent': {
      const shown = block.taskOutputResult ?? block.result;
      return [
        {
          kind: 'agent',
          subagentType: block.subagentType,
          description: block.description,
          prompt: block.prompt,
          runInBackground: block.runInBackground,
          ...(shown === undefined ? {} : { result: shown.output }),
          running: isClaudeAgentRunning(
            block.runInBackground,
            block.result,
            block.taskOutputResult,
          ),
          isError: shown?.isError === true,
          children: block.subBlocks.flatMap((sub) =>
            blockRows(sub, describeTool),
          ),
        },
      ];
    }
    case 'codex_agent':
      return [
        {
          kind: 'codex_agent',
          displayName: block.displayName,
          description: block.description,
          prompt: block.prompt,
          status: block.status,
          receiverThreadIds: block.receiverThreadIds,
          agentsStates: toJson(block.agentsStates),
          children: block.subBlocks.flatMap((sub) =>
            blockRows(sub, describeTool),
          ),
        },
      ];
    default:
      return [{ kind: 'unsupported', type: block.type }];
  }
}

function stringField(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === 'string' ? value : '';
}

function partRows(
  part: RemoteControlChatPart,
  describeTool: DescribeTool,
): CanonicalRow[] {
  const data = isRecord(part.data) ? part.data : {};
  switch (part.kind) {
    case 'text':
      return [{ kind: 'text', text: stringField(data, 'text') }];
    case 'thinking':
      return [{ kind: 'thinking', text: stringField(data, 'text') }];
    case 'tool_use': {
      const result = data['result'];
      return [
        {
          kind: 'tool',
          ...describeTool(
            stringField(data, 'toolName'),
            stringField(data, 'input'),
          ),
          ...(isRecord(result) &&
          typeof result['output'] === 'string' &&
          typeof result['isError'] === 'boolean'
            ? {
                result: {
                  output: result['output'],
                  isError: result['isError'],
                },
              }
            : {}),
        },
      ];
    }
    case 'agent': {
      const children = Array.isArray(data['subBlocks'])
        ? data['subBlocks'].flatMap((child: unknown) =>
            isRecord(child) && typeof child['kind'] === 'string'
              ? partRows(
                  {
                    kind: remoteControlKind(child['kind']),
                    data: child['data'],
                  },
                  describeTool,
                )
              : [],
          )
        : [];
      if (data['provider'] === 'codex') {
        return [
          {
            kind: 'codex_agent',
            displayName: stringField(data, 'displayName'),
            description: stringField(data, 'description'),
            prompt: stringField(data, 'prompt'),
            status: stringField(data, 'status'),
            receiverThreadIds: Array.isArray(data['receiverThreadIds'])
              ? data['receiverThreadIds'].filter(
                  (id: unknown): id is string => typeof id === 'string',
                )
              : [],
            agentsStates: toJson(data['agentsStates'] ?? {}),
            children,
          },
        ];
      }
      const result = data['result'];
      return [
        {
          kind: 'agent',
          subagentType: stringField(data, 'subagentType'),
          description: stringField(data, 'description'),
          prompt: stringField(data, 'prompt'),
          runInBackground: data['runInBackground'] === true,
          ...(typeof result === 'string' ? { result } : {}),
          running: data['isRunning'] === true,
          isError: data['isError'] === true,
          children,
        },
      ];
    }
    default:
      return [{ kind: 'unsupported', type: part.kind }];
  }
}

const REMOTE_CONTROL_PART_KINDS: readonly RemoteControlChatPart['kind'][] = [
  'text',
  'tool_use',
  'tool_result',
  'thinking',
  'attachment',
  'image',
  'agent',
  'turn_timer',
  'steering',
  'prompt_source',
  'compaction',
  'account_switch',
];

function remoteControlKind(kind: string): RemoteControlChatPart['kind'] {
  return (
    REMOTE_CONTROL_PART_KINDS.find((candidate) => candidate === kind) ?? 'text'
  );
}

/** A desktop subagent transcript (`buildSubagentChatTranscript`). */
export function canonicalDesktopTranscript(
  items: readonly SubagentChatTranscriptItem[],
  describeTool: DescribeTool,
): Json {
  return toJson(
    items.flatMap((item): CanonicalRow[] => {
      switch (item.kind) {
        case 'task':
          return [
            {
              kind: 'task',
              sender: item.sender,
              text: item.text,
              ...(item.shownTexts ? { shownTexts: item.shownTexts } : {}),
            },
          ];
        case 'follow_up':
          return [{ kind: 'follow_up', sender: item.sender, text: item.text }];
        case 'user':
          return [{ kind: 'user', text: item.text, steering: item.steering }];
        case 'divider':
          return [{ kind: 'divider', runGeneration: item.runGeneration }];
        case 'blocks':
          return item.blocks.flatMap((block) => blockRows(block, describeTool));
      }
    }),
  );
}

/** A Portal or cloud subagent transcript (`buildRemoteControlSubagentChatTranscript`). */
export function canonicalRemoteControlTranscript(
  items: readonly RemoteControlSubagentChatTranscriptItem[],
  describeTool: DescribeTool,
): Json {
  return toJson(
    items.flatMap((item): CanonicalRow[] => {
      switch (item.kind) {
        case 'task':
          return [
            {
              kind: 'task',
              sender: item.sender,
              text: item.text,
              ...(item.shownTexts ? { shownTexts: item.shownTexts } : {}),
            },
          ];
        case 'follow_up':
          return [{ kind: 'follow_up', sender: item.sender, text: item.text }];
        case 'user':
          return [{ kind: 'user', text: item.text, steering: item.steering }];
        case 'divider':
          return [{ kind: 'divider', runGeneration: item.runGeneration }];
        case 'truncated':
          return [
            { kind: 'truncated', omittedSubBlocks: item.omittedSubBlocks },
          ];
        case 'part':
          return partRows(item.part, describeTool);
      }
    }),
  );
}

/** A background task list, newest change first as the shared list sorts it. */
export function canonicalBackgroundTasks(
  tasks: readonly BackgroundTask[],
): Json {
  return toJson(tasks);
}
