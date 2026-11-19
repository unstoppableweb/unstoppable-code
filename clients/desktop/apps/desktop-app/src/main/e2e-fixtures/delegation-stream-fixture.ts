import { isE2eBuild } from '../lib/e2e-gate';
import type { ChatStateService } from '../services/chat-state-service';
import type {
  DelegatedAgentCallBlock,
  DelegationChildRow,
} from '@canopy/agent-transcript';
import type {
  ChatTranscriptBlocksPage,
  PersistedChatBlock,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { delegationQueueIdentity } from '@canopy/desktop-shared/node/delegation/broker';
import {
  DELEGATION_TRANSCRIPT_CHAT_LOG,
  DELEGATION_TRANSCRIPT_CHAT_STREAM,
  isAgentDelegationTranscript,
  type AgentDelegationTranscript,
  type AgentDelegationTranscriptItem,
} from '@canopy/protocol/delegation';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DelegationLiveFrames } from '../agents/delegation/item-changes';
import { getWorktreeDataDir } from '../lib/paths';
import { sendToAllWindows } from '../lib/window-send';

interface FixtureSpec {
  version: 1;
  projectId: string;
  worktreeId: string;
  chatId: string;
  scenario?: 'startup-repair' | 'lab-transcript';
}

interface StartupRepairSnapshot {
  runGeneration: number;
  descriptor: {
    status: 'open' | 'settled';
    committedRowCount: number;
    streamRevision: number;
    cardStatus: string | undefined;
    cardRevision: number | undefined;
  } | null;
  card: { status: string; runGeneration: number } | null;
  childRows: Array<{ id: string; itemRevision: number; final: boolean }>;
}

declare global {
  var __CANOPY_E2E_STARTUP_STREAM_REPAIR_QUERY__:
    | (() => Promise<StartupRepairSnapshot>)
    | undefined;
}

function parseSpec(value: unknown): FixtureSpec {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('projectId' in value) ||
    typeof value.projectId !== 'string' ||
    !value.projectId ||
    !('worktreeId' in value) ||
    typeof value.worktreeId !== 'string' ||
    !value.worktreeId ||
    !('chatId' in value) ||
    typeof value.chatId !== 'string' ||
    !value.chatId
  ) {
    throw new Error('Invalid E2E stream fixture spec');
  }
  const scenario = 'scenario' in value ? value.scenario : undefined;
  if (
    scenario !== undefined &&
    scenario !== 'startup-repair' &&
    scenario !== 'lab-transcript'
  ) {
    throw new Error('Invalid E2E stream fixture scenario');
  }
  return {
    version: 1,
    projectId: value.projectId,
    worktreeId: value.worktreeId,
    chatId: value.chatId,
    ...(scenario === 'startup-repair' || scenario === 'lab-transcript'
      ? { scenario }
      : {}),
  };
}

const CREATED_AT = 1_788_825_601_000;
const STARTUP_REPAIR_DELEGATION_ID = '00000000-0000-4000-8000-000000000036';
const STARTUP_REPAIR_CALL_KEY = '6'.repeat(64);
const STARTUP_REPAIR_REQUEST_HASH = '7'.repeat(64);
const SECOND_PAGE = 'second content page sentinel\n';
const PRIMARY_STORED_TAIL = 'primary stored tail sentinel';
const PRIMARY_INLINE_TAIL = 'primary inline tail sentinel';

// A second run whose newest child row exceeds the page budget, so its page
// carries `blocksOmitted` and the reader must open its blocks page by page.
export const PAGED_BLOCK_COUNT = 46;
const PAGED_FILLER = 'B'.repeat(24_000);

// A third run that stays open: its newest row is paged too, and a release
// control appends a row and publishes a committed card update after mount.
const LIVE_BLOCK_COUNT = 42;
const LIVE_RELEASE_KEY = '__CANOPY_E2E_STREAM_LIVE_RELEASE__';
const LIVE_PROGRESS_KEY = '__CANOPY_E2E_STREAM_LIVE_PROGRESS__';
const LIVE_PROGRESS_STEPS = [
  'queued',
  'approval',
  'output',
  'output-more',
  'settled',
  'late-frame',
] as const;
const OUTPUT_1 = 'Live progress output sentinel';
const OUTPUT_2 = 'Live progress output sentinel, continued';
const LATE = 'Late live frame sentinel';
const PROGRESS_CREATION_SEQUENCE = 4;

function fixtureCard(
  spec: FixtureSpec,
  run: RunName,
  description: string,
): DelegatedAgentCallBlock {
  const delegationId = `${spec.chatId}-${run}`;
  const agentBlockId = `delegated-agent-${delegationId}`;
  return {
    type: 'delegated_agent_call',
    delegationId,
    agentBlockId,
    runGeneration: 1,
    status: 'completed',
    outputTruncated: false,
    transcriptStore: 'chat-stream-v2',
    sequence: {
      child: 1,
      blocks: 2,
      live: 3,
      progress: PROGRESS_CREATION_SEQUENCE,
    }[run],
    parentHarnessId: 'claude',
    parentTurnId: 'stream-request',
    parentToolCallId: `stream-spawn-${run}`,
    selectedModelId: 'sonnet',
    runtimeModelId: 'claude-sonnet-4-6',
    targetHarnessId: 'claude',
    routeSnapshot: {
      selectedModelId: 'sonnet',
      runtimeModelId: 'claude-sonnet-4-6',
      harnessId: 'claude',
      runtimeKind: 'local-sdk',
      runnerRegistrationId: 'claude-local',
      runtimeVersion: '1',
      adapterVersion: '1',
      modelSource: 'test',
      providerType: 'test',
      assignmentRevision: 'a1',
      billingAuthority: 'native',
      aiCreditsRouted: false,
      capabilities: ['read'],
      supportedThinkingLevels: ['low'],
      capabilitySnapshotHash: 'c1',
      capabilityGeneration: 1,
      policyRevision: 'p1',
    },
    description,
    prompt: `${description}.`,
    executionMode: 'background',
    createdAt: CREATED_AT,
    finalText: 'Stream review complete.',
  };
}

function fixtureTab(spec: FixtureSpec): PersistedChatTab {
  const card = fixtureCard(spec, 'child', 'Review retained stream evidence');
  const blocksCard = fixtureCard(spec, 'blocks', 'Review paged evidence');
  const liveCard = fixtureCard(spec, 'live', 'Review live evidence');
  const progressCard = fixtureCard(spec, 'progress', 'Review live progress');
  return {
    id: spec.chatId,
    title: 'Retained stream review',
    providerType: 'claude',
    createdAt: new Date(CREATED_AT).toISOString(),
    messages: [
      {
        id: 'stream-request',
        role: 'user',
        timestamp: CREATED_AT - 1000,
        blocks: [
          { type: 'text', text: 'Review the retained stream evidence.' },
        ],
      },
      {
        id: card.agentBlockId,
        role: 'assistant',
        timestamp: CREATED_AT,
        blocks: [card],
      },
      {
        id: 'stale-inline',
        role: 'assistant',
        parentBlockId: card.agentBlockId,
        timestamp: CREATED_AT + 1,
        blocks: [{ type: 'text', text: 'stale inline child sentinel' }],
      },
      {
        id: blocksCard.agentBlockId,
        role: 'assistant',
        timestamp: CREATED_AT + 2,
        blocks: [blocksCard],
      },
      {
        id: liveCard.agentBlockId,
        role: 'assistant',
        timestamp: CREATED_AT + 3,
        blocks: [liveCard],
      },
      {
        id: progressCard.agentBlockId,
        role: 'assistant',
        timestamp: CREATED_AT + 4,
        blocks: [progressCard],
      },
      // Primary tool results: one stored by reference and paired in its row,
      // and one inline result longer than the Portal preview, paired across rows.
      {
        id: 'primary-read',
        role: 'assistant',
        timestamp: CREATED_AT + 10,
        blocks: [
          { type: 'text', text: 'Reading the primary evidence.' },
          {
            type: 'tool_use',
            toolUseId: 'primary-read-call',
            toolName: 'Read',
            input: JSON.stringify({ file_path: 'primary-evidence.txt' }),
          },
          {
            type: 'tool_result',
            toolUseId: 'primary-read-call',
            toolName: 'Read',
            isError: false,
            output: 'P'.repeat(70_000) + PRIMARY_STORED_TAIL,
          },
        ],
      },
      {
        id: 'primary-grep-call',
        role: 'assistant',
        timestamp: CREATED_AT + 11,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'primary-grep',
            toolName: 'Grep',
            input: JSON.stringify({ pattern: 'evidence' }),
          },
        ],
      },
      {
        id: 'primary-grep-result',
        role: 'user',
        timestamp: CREATED_AT + 12,
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'primary-grep',
            toolName: 'Grep',
            isError: false,
            output: 'G'.repeat(6_000) + PRIMARY_INLINE_TAIL,
          },
        ],
      },
      {
        id: 'stream-answer',
        role: 'assistant',
        timestamp: CREATED_AT + 2000,
        blocks: [{ type: 'text', text: 'Stream review complete.' }],
      },
    ],
  };
}

function fixtureRows(spec: FixtureSpec): DelegationChildRow[] {
  return Array.from(
    { length: 501 },
    (_, index): DelegationChildRow => ({
      id: `stream-row-${index}`,
      role: 'assistant',
      timestamp: CREATED_AT + index,
      parentBlockId: `delegated-agent-${spec.chatId}-child`,
      delegationSequence: index,
      itemRevision: 0,
      final: true,
      blocks: [
        { type: 'text', text: `Retained child row ${index}` },
        ...(index === 500
          ? [
              {
                type: 'tool_use' as const,
                toolUseId: 'stream-large-result',
                toolName: 'Read',
                input: JSON.stringify({ file_path: 'retained-evidence.txt' }),
              },
              {
                type: 'tool_result' as const,
                toolUseId: 'stream-large-result',
                toolName: 'Read',
                isError: false,
                output: 'A'.repeat(65_536) + SECOND_PAGE.repeat(3000),
              },
            ]
          : []),
      ],
    }),
  );
}

function pagedRows(spec: FixtureSpec): DelegationChildRow[] {
  const parentBlockId = `delegated-agent-${spec.chatId}-blocks`;
  const filler = Array.from({ length: 40 }, (_, index) => ({
    type: 'text' as const,
    text: `${index === 20 ? 'paged block middle sentinel ' : ''}${PAGED_FILLER}`,
  }));
  return [
    {
      id: 'blocks-row-0',
      role: 'assistant',
      timestamp: CREATED_AT,
      parentBlockId,
      delegationSequence: 0,
      itemRevision: 0,
      final: true,
      blocks: [{ type: 'text', text: 'Paged review started.' }],
    },
    {
      id: 'blocks-row-1',
      role: 'assistant',
      timestamp: CREATED_AT + 1,
      parentBlockId,
      delegationSequence: 1,
      itemRevision: 0,
      final: true,
      blocks: [
        { type: 'text', text: 'paged block first sentinel' },
        ...filler,
        {
          type: 'tool_use',
          toolUseId: 'paged-dup',
          toolName: 'Read',
          input: JSON.stringify({ file_path: 'paged-evidence.txt' }),
        },
        {
          type: 'tool_result',
          toolUseId: 'paged-dup',
          toolName: 'Read',
          isError: false,
          output: 'R'.repeat(70_000) + 'paged stored tail sentinel',
        },
        {
          type: 'tool_use',
          toolUseId: 'paged-dup',
          toolName: 'Read',
          input: JSON.stringify({ file_path: 'paged-evidence-2.txt' }),
        },
        {
          type: 'tool_result',
          toolUseId: 'paged-dup',
          toolName: 'Read',
          isError: false,
          output: 'second duplicate result',
        },
        { type: 'text', text: 'paged block last sentinel' },
      ],
    },
  ];
}

function liveRows(spec: FixtureSpec): DelegationChildRow[] {
  const parentBlockId = `delegated-agent-${spec.chatId}-live`;
  return [
    {
      id: 'live-row-0',
      role: 'assistant',
      timestamp: CREATED_AT,
      parentBlockId,
      delegationSequence: 0,
      itemRevision: 0,
      final: true,
      blocks: [{ type: 'text', text: 'Live review started.' }],
    },
    {
      id: 'live-row-1',
      role: 'assistant',
      timestamp: CREATED_AT + 1,
      parentBlockId,
      delegationSequence: 1,
      itemRevision: 0,
      final: true,
      blocks: [
        { type: 'text', text: 'live block first sentinel' },
        ...Array.from({ length: LIVE_BLOCK_COUNT - 2 }, () => ({
          type: 'text' as const,
          text: PAGED_FILLER,
        })),
        { type: 'text', text: 'live block last sentinel' },
      ],
    },
  ];
}

function progressRows(spec: FixtureSpec): DelegationChildRow[] {
  return [
    {
      id: 'progress-row-0',
      role: 'assistant',
      timestamp: CREATED_AT,
      parentBlockId: `delegated-agent-${spec.chatId}-progress`,
      delegationSequence: 0,
      itemRevision: 0,
      final: true,
      blocks: [{ type: 'text', text: 'Live progress started.' }],
    },
  ];
}

type RunName = 'child' | 'blocks' | 'live' | 'progress';

interface RunSpec {
  readonly run: RunName;
  readonly prompt: string;
  readonly rows: DelegationChildRow[];
  readonly cardStatus?: 'pending' | 'running';
}

type CardDraft = Parameters<
  ChatStateService['updateCardState']
>[1]['cardDraft'];

function runningDraft(
  prompt: string,
  status: 'pending' | 'running' = 'running',
): CardDraft {
  return {
    version: 2,
    status,
    outputTruncated: false,
    prompt,
    nestedDelegation: 'not_enabled',
    childDelegationIds: [],
    routeSnapshot: {
      selectedModelId: 'sonnet',
      selectedModelLabel: 'Claude Sonnet',
      runtimeModelId: 'claude-sonnet-4-6',
      runtimeModelLabel: 'Claude Sonnet 4.6',
      harnessId: 'claude',
      runtimeKind: 'local-sdk',
      runnerRegistrationId: 'claude-local',
      runtimeVersion: '1',
      adapterVersion: '1',
      modelSource: 'test',
      providerType: 'test',
      assignmentRevision: 'a1',
      billingAuthority: 'native',
      aiCreditsRouted: false,
      capabilities: ['read'],
      supportedThinkingLevels: ['low'],
      capabilitySnapshotHash: 'c1',
      capabilityGeneration: 1,
      policyRevision: 'p1',
    },
  };
}

async function seedRun(
  service: ChatStateService,
  scope: { projectId: string; worktreeId: string },
  spec: FixtureSpec,
  run: RunSpec,
): Promise<{
  kind: 'delegation';
  chatId: string;
  delegationId: string;
  runGeneration: number;
}> {
  const target = {
    kind: 'delegation',
    chatId: spec.chatId,
    delegationId: `${spec.chatId}-${run.run}`,
    runGeneration: 1,
  } as const;
  const existing = await service.getChildStreamState(scope, target);
  // The live and progress runs stay open, so any existing descriptor means seeded.
  if (
    existing?.status === 'settled' ||
    ((run.run === 'live' || run.run === 'progress') && existing)
  )
    return target;
  await service.registerGeneration(scope, {
    chatId: spec.chatId,
    delegationId: target.delegationId,
    runGeneration: 1,
    createdAt: CREATED_AT,
    store: 'stream',
    origin: {
      kind: 'launch',
      anchorMessageId: `delegated-agent-${target.delegationId}`,
    },
    executionMode: 'background',
  });
  await service.openChildStream(scope, target);
  // Format 4 strips mutable fields from the creation row. Publish the same
  // draft as the broker; settlement supplies completed/finalText.
  await service.updateCardState(scope, {
    target,
    cardRevision: 1,
    cardDraft: runningDraft(run.prompt, run.cardStatus ?? 'running'),
  });
  await service.commitChildStream(
    scope,
    target,
    `e2e-stream-rows-${run.run}-v1`,
    run.rows,
  );
  if (run.run === 'live' || run.run === 'progress') return target;
  await service.settleDelegationResult(scope, {
    target,
    settlementKey: `e2e-stream-settlement-${run.run}-v1`,
    resultIndex: 1,
    outcome: { status: 'completed', finishedAt: CREATED_AT + 1000 },
    finalChanges: [],
    answer: { role: 'final', text: 'Stream review complete.' },
  });
  return target;
}

function startupRepairTarget(
  spec: FixtureSpec,
): Extract<
  Parameters<ChatStateService['getChildStreamState']>[1],
  { kind: 'delegation' }
> {
  return {
    kind: 'delegation',
    chatId: spec.chatId,
    delegationId: STARTUP_REPAIR_DELEGATION_ID,
    runGeneration: 3,
  };
}

function startupRepairAnchorMessageId(
  target: ReturnType<typeof startupRepairTarget>,
): string {
  return `delegated-agent-${target.delegationId}-run-${target.runGeneration}`;
}

function startupRepairTab(spec: FixtureSpec): PersistedChatTab {
  const target = startupRepairTarget(spec);
  const { finalText: _finalText, ...baseCard } = fixtureCard(
    spec,
    'progress',
    'Repair the retained startup stream',
  );
  void _finalText;
  const card: DelegatedAgentCallBlock = {
    ...baseCard,
    delegationId: target.delegationId,
    agentBlockId: startupRepairAnchorMessageId(target),
    parentToolCallId: 'startup-repair-spawn',
    runGeneration: target.runGeneration,
    status: 'pending',
    sequence: 5,
  };
  return {
    id: spec.chatId,
    title: 'Startup stream repair fixture',
    providerType: 'claude',
    createdAt: new Date(CREATED_AT).toISOString(),
    messages: [
      {
        id: 'startup-repair-request',
        role: 'user',
        timestamp: CREATED_AT - 1000,
        blocks: [
          { type: 'text', text: 'Retain this stream for startup repair.' },
        ],
      },
      {
        id: card.agentBlockId,
        role: 'assistant',
        timestamp: CREATED_AT,
        blocks: [card],
      },
    ],
  };
}

async function startupRepairSnapshot(
  service: ChatStateService,
  spec: FixtureSpec,
): Promise<StartupRepairSnapshot> {
  const scope = { projectId: spec.projectId, worktreeId: spec.worktreeId };
  const target = startupRepairTarget(spec);
  const descriptor = await service.getChildStreamState(scope, target);
  const parent = await service.getTranscriptPage({
    ...scope,
    chatId: spec.chatId,
  });
  const persistedCard = parent.messages
    .flatMap((message) => message.blocks)
    .find(
      (block): block is DelegatedAgentCallBlock =>
        block.type === 'delegated_agent_call' &&
        block.delegationId === target.delegationId &&
        block.runGeneration === target.runGeneration,
    );
  const childPage = descriptor
    ? await service.getChildStreamPage(
        scope,
        target,
        descriptor.streamRevision,
        undefined,
        20,
      )
    : undefined;
  const cardState = descriptor?.cardState;
  const cardStatus =
    cardState?.version === 2
      ? (cardState.canonical?.status ?? cardState.status)
      : cardState?.status;
  return {
    runGeneration: target.runGeneration,
    descriptor: descriptor
      ? {
          status: descriptor.status,
          committedRowCount: descriptor.committedRowCount,
          streamRevision: descriptor.streamRevision,
          cardStatus,
          cardRevision:
            cardState?.version === 2 ? cardState.cardRevision : undefined,
        }
      : null,
    card: persistedCard
      ? {
          status: persistedCard.status,
          runGeneration: persistedCard.runGeneration,
        }
      : null,
    childRows:
      childPage?.rows.map((row) => ({
        id: row.id,
        itemRevision: row.itemRevision,
        final: row.final,
      })) ?? [],
  };
}

async function persistStartupRepairDelegationRecord(
  spec: FixtureSpec,
  target: ReturnType<typeof startupRepairTarget>,
): Promise<void> {
  const prompt = 'Retain this stream for startup repair.';
  const { prompt: _prompt, ...draft } = runningDraft(prompt, 'pending');
  void _prompt;
  const anchorMessageId = startupRepairAnchorMessageId(target);
  const record = {
    version: 3,
    parent: {
      harnessId: 'claude',
      projectId: spec.projectId,
      worktreeId: spec.worktreeId,
      chatId: spec.chatId,
      sessionKey: `${spec.projectId}/${spec.worktreeId}/${spec.chatId}`,
      turnId: 'startup-repair-turn',
      toolCallId: 'startup-repair-spawn',
      runtimeGeneration: 1,
      depth: 0,
    },
    task: {
      modelId: 'sonnet',
      description: 'Repair the retained startup stream',
      prompt,
      executionMode: 'background',
      contextPolicy: 'task_only',
      isolation: 'shared_worktree',
    },
    callKey: STARTUP_REPAIR_CALL_KEY,
    requestHash: STARTUP_REPAIR_REQUEST_HASH,
    createdAt: CREATED_AT,
    state: {
      delegationId: target.delegationId,
      runGeneration: target.runGeneration,
      sequence: 1,
      status: 'running',
      startedAt: CREATED_AT + 1,
      outputTruncated: false,
    },
    launch: {
      version: 1,
      delegationId: target.delegationId,
      launchKey: STARTUP_REPAIR_CALL_KEY,
      runGeneration: target.runGeneration,
      phase: 'starting',
    },
    delivery: { status: 'unclaimed' },
    readMetadata: {
      originAt: CREATED_AT,
      lastActivityAt: CREATED_AT + 1,
      current: {
        store: 'stream',
        target,
      },
    },
    registration: {
      runGeneration: target.runGeneration,
      createdAt: CREATED_AT,
      store: 'stream',
      origin: { kind: 'launch', anchorMessageId },
      executionMode: 'background',
    },
    receipts: { commandReceipts: [], stopReceipts: [] },
    cardPublication: {
      runGeneration: target.runGeneration,
      cardRevision: 1,
      promptAmended: true,
      draft,
    },
  };
  const runsDirectory = join(
    getWorktreeDataDir(spec.projectId, spec.worktreeId),
    'delegation',
    'runs',
  );
  await mkdir(runsDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(runsDirectory, `${target.delegationId}.json`),
    JSON.stringify(record),
    { encoding: 'utf8', mode: 0o600 },
  );
}

async function seedStartupRepairFixture(
  service: ChatStateService,
  spec: FixtureSpec,
): Promise<void> {
  const scope = { projectId: spec.projectId, worktreeId: spec.worktreeId };
  const target = startupRepairTarget(spec);
  const tabs = await service.getCompatibilityTabs(scope);
  if (!tabs.tabs.some((tab) => tab.id === spec.chatId)) {
    const readiness = await service.generationStoreReadiness(scope);
    if (!readiness.enableFormat4 || readiness.formatVersion !== 4) {
      throw new Error(
        'E2E startup repair seeding requires the format-4 write option',
      );
    }
    await service.replaceCompatibilityTabs(
      scope,
      { ...tabs, tabs: [...tabs.tabs, startupRepairTab(spec)] },
      { changedTabIds: [spec.chatId] },
    );
  }

  const existing = await service.getChildStreamState(scope, target);
  if (!existing) {
    const prompt = 'Retain this stream for startup repair.';
    const anchorMessageId = startupRepairAnchorMessageId(target);
    await service.registerGeneration(scope, {
      chatId: spec.chatId,
      delegationId: target.delegationId,
      runGeneration: target.runGeneration,
      createdAt: CREATED_AT,
      store: 'stream',
      origin: { kind: 'launch', anchorMessageId },
      executionMode: 'background',
    });
    await service.openChildStream(scope, target);
    await service.updateCardState(scope, {
      target,
      cardRevision: 1,
      cardDraft: runningDraft(prompt, 'pending'),
    });
    await service.commitChildStream(
      scope,
      target,
      'e2e-startup-repair-row-v1',
      [
        {
          id: 'startup-repair-row',
          role: 'assistant',
          timestamp: CREATED_AT,
          parentBlockId: anchorMessageId,
          delegationSequence: 0,
          itemRevision: 0,
          final: true,
          blocks: [{ type: 'text', text: 'Persisted startup repair row.' }],
        },
      ],
    );
    await persistStartupRepairDelegationRecord(spec, target);
  }
  await service.flushScope(spec.projectId, spec.worktreeId);
  Object.defineProperty(
    globalThis,
    '__CANOPY_E2E_STARTUP_STREAM_REPAIR_QUERY__',
    {
      configurable: true,
      value: (): Promise<StartupRepairSnapshot> =>
        startupRepairSnapshot(service, spec),
    },
  );
}

declare global {
  var __CANOPY_E2E_LAB_TRANSCRIPT__:
    | ((input: unknown) => Promise<Record<string, unknown>>)
    | undefined;
}

/** E2E only: attach streams to existing bulk rows; never replace the large chat. */
async function seedLabTranscriptMode(
  service: ChatStateService,
  spec: FixtureSpec,
): Promise<void> {
  const scope = { projectId: spec.projectId, worktreeId: spec.worktreeId };
  const tabs = await service.getCompatibilityTabs(scope, {
    chatIds: [spec.chatId],
    fullTranscript: true,
  });
  const tab = tabs.tabs.find((candidate) => candidate.id === spec.chatId);
  if (!tab) throw new Error('Lab transcript requires an existing bulk chat');
  const readiness = await service.generationStoreReadiness(scope);
  if (!readiness.enableFormat4 || readiness.formatVersion !== 4)
    throw new Error('Lab transcript requires CANOPY_E2E_CHAT_FORMAT4=1');
  const anchors = tab.messages.flatMap((message) =>
    message.blocks.flatMap((card) =>
      card.type === 'delegated_agent_call' ? [{ message, card }] : [],
    ),
  );
  const cards = anchors.filter(
    ({ card }) => card.transcriptStore === 'chat-stream-v2',
  );
  const legacyCards = anchors.filter(
    ({ card }) => card.transcriptStore !== 'chat-stream-v2',
  );
  const newest = cards[cards.length - 1];
  const legacy = legacyCards[legacyCards.length - 1];
  if (!newest?.card.delegationId || !legacy)
    throw new Error('Lab transcript card anchors are missing');
  const targetFor = (
    delegationId: string,
  ): {
    kind: 'delegation';
    chatId: string;
    delegationId: string;
    runGeneration: number;
  } => ({
    kind: 'delegation',
    chatId: spec.chatId,
    delegationId,
    runGeneration: 1,
  });
  for (const { message, card } of cards) {
    if (!card.delegationId || !card.agentBlockId)
      throw new Error('Invalid lab stream anchor');
    const target = targetFor(card.delegationId);
    if (await service.getChildStreamState(scope, target)) continue;
    await service.registerGeneration(scope, {
      chatId: spec.chatId,
      delegationId: card.delegationId,
      runGeneration: 1,
      createdAt: message.timestamp,
      store: 'stream',
      executionMode: 'background',
      origin: { kind: 'launch', anchorMessageId: message.id },
    });
    await service.openChildStream(scope, target);
    await service.updateCardState(scope, {
      target,
      cardRevision: 1,
      cardDraft: runningDraft(card.prompt ?? 'Lab stream'),
    });
    await service.commitChildStream(
      scope,
      target,
      `lab-initial-${card.delegationId}`,
      [
        {
          id: 'lab-live-output',
          role: 'assistant',
          timestamp: message.timestamp,
          parentBlockId: card.agentBlockId,
          delegationSequence: 0,
          itemRevision: 0,
          final: false,
          blocks: [{ type: 'text', text: 'Lab stream ready.' }],
        },
      ],
    );
  }
  const target = targetFor(newest.card.delegationId);
  let legacyUpdates = 0;
  const legacyOutcomes = { applied: 0, 'activity-only': 0 };
  let streamUpdates = 0;
  let previous: Promise<unknown> = Promise.resolve();
  const inspect = async (): Promise<Record<string, unknown>> => {
    const descriptor = await service.getChildStreamState(scope, target);
    if (!descriptor) throw new Error('Lab stream descriptor disappeared');
    const page = await service.getChildStreamPage(
      scope,
      target,
      descriptor.streamRevision,
      undefined,
      10,
    );
    const block = page.rows.find((row) => row.id === 'lab-live-output')
      ?.blocks[0];
    const sentinel = block?.type === 'text' ? block.text : '';
    return {
      manifestVersion: (await service.generationStoreReadiness(scope))
        .formatVersion,
      resolvedConfig: {
        CANOPY_E2E_CHAT_FORMAT4: {
          raw: process.env.CANOPY_E2E_CHAT_FORMAT4 ?? null,
          effective:
            isE2eBuild() && process.env.CANOPY_E2E_CHAT_FORMAT4 === '1',
        },
      },
      legacyUpdates,
      legacyOutcomes: { ...legacyOutcomes },
      streamUpdates,
      latestRevision: descriptor.streamRevision,
      latestSentinel: sentinel.slice(0, 96),
      target,
    };
  };
  const advance = async (input: unknown): Promise<Record<string, unknown>> => {
    if (typeof input !== 'object' || input === null || !('operation' in input))
      throw new Error('Invalid lab transcript operation');
    if (input.operation === 'inspect') return inspect();
    if (
      input.operation !== 'update' ||
      !('label' in input) ||
      typeof input.label !== 'string' ||
      !/^[a-z0-9-]{1,80}$/.test(input.label)
    )
      throw new Error('Invalid lab transcript update');
    const label = input.label;
    const payload = 'payloadCharacters' in input ? input.payloadCharacters : 0;
    if (
      typeof payload !== 'number' ||
      !Number.isInteger(payload) ||
      payload < 0 ||
      payload > 524_288
    )
      throw new Error('Lab transcript payload exceeds its bounded budget');
    if (!payload) {
      // A background delegate whose card row is already committed reports
      // through the production canopy_delegation ingestion, as
      // `DelegationService.publishDetached` does. Only persisted card fields
      // count, so each update completes a steer.
      const card = legacy.card;
      const outcome = await service.ingestProviderEventWithOutcome({
        ...scope,
        chatId: spec.chatId,
        turnUserMessageId: card.parentTurnId,
        mutationId: `lab-legacy-${legacyUpdates + 1}-${label}`,
        data: {
          type: 'canopy_delegation',
          canopy_turn_user_message_id: card.parentTurnId,
          delegation: {
            delegationId: card.delegationId,
            runGeneration: card.runGeneration,
            sequence: card.sequence + legacyUpdates + 1,
            parentHarnessId: card.parentHarnessId,
            parentTurnId: card.parentTurnId,
            parentToolCallId: card.parentToolCallId,
            createdAt: card.createdAt,
            task: {
              description: card.description,
              prompt: card.prompt,
              executionMode: card.executionMode,
            },
            transcript: [],
            transcriptStore: DELEGATION_TRANSCRIPT_CHAT_LOG,
            snapshot: {
              delegationId: card.delegationId,
              status: 'running',
              // A running snapshot without its route is rejected as invalid.
              routeSnapshot: card.routeSnapshot,
              outputTruncated: false,
              control: {
                operationId: `lab-legacy-${label}`,
                operation: 'steer',
                status: 'completed',
              },
            },
          } satisfies AgentDelegationTranscript,
        },
      });
      if (outcome === 'not-applied')
        throw new Error('Lab legacy card update was not admitted');
      legacyOutcomes[outcome] += 1;
      legacyUpdates += 1;
    }
    const before = await service.getChildStreamState(scope, target);
    if (!before || before.cardState?.version !== 2)
      throw new Error('Lab stream is not open');
    const page = await service.getChildStreamPage(
      scope,
      target,
      before.streamRevision,
      undefined,
      10,
    );
    const row = page.rows.find(
      (candidate) => candidate.id === 'lab-live-output',
    );
    if (!row) throw new Error('Lab live child row disappeared');
    const text = `Lab stream ${label}` + 'x'.repeat(payload);
    const result = await service.commitChildStream(
      scope,
      target,
      `lab-update-${streamUpdates + 1}-${label}`,
      [
        {
          ...row,
          itemRevision: row.itemRevision + 1,
          final: false,
          blocks: [{ type: 'text', text }],
        },
      ],
    );
    if (!result.applied) throw new Error('Lab stream update was not committed');
    await service.updateCardState(scope, {
      target,
      cardRevision: before.cardState.cardRevision + 1,
      cardDraft: runningDraft(newest.card.prompt ?? 'Lab stream'),
    });
    streamUpdates += 1;
    return inspect();
  };
  Object.defineProperty(globalThis, '__CANOPY_E2E_LAB_TRANSCRIPT__', {
    configurable: true,
    value: (input: unknown): Promise<Record<string, unknown>> => {
      const next = previous.then(() => advance(input));
      previous = next.catch(() => undefined);
      return next;
    },
  });
}

/** E2E startup only; never registered as an application operation. */
export async function seedDelegationStreamFixture(
  service: ChatStateService,
  specPath = process.env.CANOPY_E2E_SEED_STREAM_FIXTURE,
): Promise<void> {
  if (!isE2eBuild() || !specPath) return;
  const spec = parseSpec(JSON.parse(await readFile(specPath, 'utf8')));
  if (spec.scenario === 'lab-transcript')
    return seedLabTranscriptMode(service, spec);
  if (spec.scenario === 'startup-repair') {
    await seedStartupRepairFixture(service, spec);
    return;
  }
  const scope = { projectId: spec.projectId, worktreeId: spec.worktreeId };
  const target = {
    kind: 'delegation',
    chatId: spec.chatId,
    delegationId: `${spec.chatId}-child`,
    runGeneration: 1,
  } as const;
  const tabs = await service.getCompatibilityTabs(scope);
  if (!tabs.tabs.some((tab) => tab.id === spec.chatId)) {
    const readiness = await service.generationStoreReadiness(scope);
    if (!readiness.enableFormat4 || readiness.formatVersion !== 4) {
      throw new Error('E2E stream seeding requires the format-4 write option');
    }
    await service.replaceCompatibilityTabs(
      scope,
      {
        ...tabs,
        tabs: [...tabs.tabs, fixtureTab(spec)],
        activeTabId: spec.chatId,
      },
      { changedTabIds: [spec.chatId], activeTabId: spec.chatId },
    );
  }
  await seedRun(service, scope, spec, {
    run: 'child',
    prompt: 'Review retained stream evidence.',
    rows: fixtureRows(spec),
  });
  const blocksTarget = await seedRun(service, scope, spec, {
    run: 'blocks',
    prompt: 'Review paged evidence.',
    rows: pagedRows(spec),
  });
  const liveTarget = await seedRun(service, scope, spec, {
    run: 'live',
    prompt: 'Review live evidence.',
    rows: liveRows(spec),
  });
  const progressTarget = await seedRun(service, scope, spec, {
    run: 'progress',
    prompt: 'Review live progress.',
    cardStatus: 'pending',
    rows: progressRows(spec),
  });
  await service.flushScope(spec.projectId, spec.worktreeId);
  const descriptor = await service.getChildStreamState(scope, target);
  if (!descriptor || descriptor.status !== 'settled')
    throw new Error('E2E stream not settled');
  const first = await service.getChildStreamPage(
    scope,
    target,
    descriptor.streamRevision,
    undefined,
    500,
  );
  const ids = new Set(first.rows.map((row): string => row.id));
  let cursor = first.cursor;
  while (cursor) {
    const page = await service.getChildStreamPage(
      scope,
      target,
      descriptor.streamRevision,
      cursor,
      500,
    );
    for (const row of page.rows) ids.add(row.id);
    cursor = page.cursor;
  }
  const rawPage = await service.getTranscriptPage({
    ...scope,
    chatId: spec.chatId,
    target,
  });
  const row = rawPage.messages.find(
    (message): boolean => message.id === 'stream-row-500',
  );
  const output = row?.blocks[2];
  const reference =
    output?.type === 'tool_result' ? output.fullOutputRef : undefined;
  const second = await service.readChildStreamContent(
    scope,
    target,
    descriptor.streamRevision,
    'stream-row-500',
    2,
    'output',
    65_536,
    65_536,
  );
  if (
    ids.size !== 501 ||
    !first.cursor ||
    !reference ||
    reference.byteLength <= 65_536 ||
    !second.text.includes(SECOND_PAGE.trim())
  ) {
    throw new Error(
      `E2E stream fixture preconditions failed: rows=${ids.size}, cursor=${!!first.cursor}, reference=${reference?.byteLength}, second=${second.text.length}`,
    );
  }
  const blocks = await verifyPagedRun(service, scope, spec, blocksTarget);
  const primary = await verifyPrimaryResults(service, scope, spec);
  const live = await verifyLiveRun(service, scope, spec, liveTarget);
  const progress = await verifyProgressRun(service, scope, progressTarget);
  // This receipt is evidence from production reads, not a hand-written storage manifest.
  await writeFile(
    `${specPath}.result.json`,
    JSON.stringify({
      version: 1,
      ...scope,
      target,
      rowCount: ids.size,
      cursor: first.cursor,
      streamRevision: descriptor.streamRevision,
      status: descriptor.status,
      transcriptStore: 'chat-stream-v2',
      fullOutputRef: reference,
      secondPageLength: second.text.length,
      blocks,
      primary,
      live,
      progress,
    }),
  );
  installLiveRelease(service, scope, spec, liveTarget);
  installLiveProgress(service, scope, progressTarget);
}

async function verifyLiveRun(
  service: ChatStateService,
  scope: { projectId: string; worktreeId: string },
  spec: FixtureSpec,
  target: Awaited<ReturnType<typeof seedRun>>,
): Promise<Record<string, unknown>> {
  const descriptor = await service.getChildStreamState(scope, target);
  const page = await service.getTranscriptPage({
    ...scope,
    chatId: spec.chatId,
    target,
  });
  const ids = page.messages.map((message): string => message.id);
  const paged = page.messages.find(
    (message): boolean => message.id === 'live-row-1',
  );
  const omitted = paged?.blocksOmitted?.blockCount;
  if (
    descriptor?.status !== 'open' ||
    descriptor.cardState?.version !== 2 ||
    omitted !== LIVE_BLOCK_COUNT ||
    ids.includes('live-row-0')
  ) {
    throw new Error(
      `E2E live run preconditions failed: status=${descriptor?.status}, omitted=${omitted}, newest=${ids.join(',')}`,
    );
  }
  return {
    target,
    anchorMessageId: `delegated-agent-${target.delegationId}`,
    status: descriptor.status,
    pagedMessageId: 'live-row-1',
    omittedBlockCount: omitted,
    newestRowIds: ids,
    streamRevision: descriptor.streamRevision,
    cardRevision: descriptor.cardState.cardRevision,
  };
}

async function verifyProgressRun(
  service: Parameters<typeof seedDelegationStreamFixture>[0],
  scope: { projectId: string; worktreeId: string },
  target: Awaited<ReturnType<typeof seedRun>>,
): Promise<Record<string, unknown>> {
  const descriptor = await service.getChildStreamState(scope, target);
  if (!descriptor || descriptor.status !== 'open')
    throw new Error('E2E progress run is not open');
  const cardState = descriptor.cardState;
  if (
    !cardState ||
    cardState.version !== 2 ||
    cardState.status !== 'pending' ||
    cardState.cardRevision !== 1
  ) {
    throw new Error('E2E progress card is not pending');
  }
  const page = await service.getChildStreamPage(
    scope,
    target,
    descriptor.streamRevision,
    undefined,
    10,
  );
  const row = page.rows[0];
  const text = row?.blocks[0];
  if (
    page.rows.length !== 1 ||
    row?.id !== 'progress-row-0' ||
    row.final !== true ||
    text?.type !== 'text' ||
    text.text !== 'Live progress started.'
  ) {
    throw new Error('E2E progress child row is missing');
  }
  return {
    target,
    anchorMessageId: `delegated-agent-${target.delegationId}`,
    status: descriptor.status,
    cardStatus: cardState.status,
    transcriptStore: DELEGATION_TRANSCRIPT_CHAT_STREAM,
    streamRevision: descriptor.streamRevision,
    cardRevision: cardState.cardRevision,
  };
}

type LiveProgressStep = (typeof LIVE_PROGRESS_STEPS)[number];
type LiveProgressFrameStep = Exclude<LiveProgressStep, 'settled'>;
type FixtureService = Parameters<typeof seedDelegationStreamFixture>[0];

function isLiveProgressStep(value: unknown): value is LiveProgressStep {
  return (
    typeof value === 'string' &&
    LIVE_PROGRESS_STEPS.some((step) => step === value)
  );
}

async function commitProgressOutput(
  service: FixtureService,
  scope: { projectId: string; worktreeId: string },
  target: Awaited<ReturnType<typeof seedRun>>,
  text: string,
  final: boolean,
  mutationLabel: string,
): Promise<DelegationChildRow> {
  const descriptor = await service.getChildStreamState(scope, target);
  if (descriptor?.status !== 'open')
    throw new Error('E2E progress stream is not open');
  const page = await service.getChildStreamPage(
    scope,
    target,
    descriptor.streamRevision,
    undefined,
    10,
  );
  const previous = page.rows.find((row) => row.id === 'progress-output');
  const row: DelegationChildRow = {
    id: 'progress-output',
    role: 'assistant',
    timestamp: previous?.timestamp ?? CREATED_AT + 5,
    parentBlockId: `delegated-agent-${target.delegationId}`,
    delegationSequence:
      previous?.delegationSequence ?? descriptor.committedRowCount,
    itemRevision: previous ? previous.itemRevision + 1 : 0,
    final,
    blocks: [{ type: 'text', text }],
  };
  await service.commitChildStream(
    scope,
    target,
    `e2e-stream-progress-${mutationLabel}-${row.itemRevision}`,
    [row],
  );
  return row;
}

function liveProgressTranscript(
  step: LiveProgressFrameStep,
  sequence: number,
  target: Awaited<ReturnType<typeof seedRun>>,
): AgentDelegationTranscript {
  const status = step === 'queued' ? 'pending' : 'running';
  const draft = runningDraft('Review live progress.', status);
  const routeSnapshot = draft.routeSnapshot;
  if (!routeSnapshot) throw new Error('E2E progress route snapshot missing');
  const transcript: AgentDelegationTranscriptItem[] = [
    {
      id: 'progress-row-0',
      sequence: 0,
      occurredAt: CREATED_AT,
      type: 'text',
      text: 'Live progress started.',
    },
  ];
  const outputText =
    step === 'output'
      ? OUTPUT_1
      : step === 'output-more' || step === 'late-frame'
        ? OUTPUT_2
        : undefined;
  if (outputText) {
    transcript.push({
      id: 'progress-output',
      sequence: 1,
      occurredAt: CREATED_AT + 5,
      type: 'text',
      text: outputText,
    });
  }
  const partialText =
    step === 'late-frame'
      ? LATE
      : step === 'output'
        ? OUTPUT_1
        : step === 'output-more'
          ? OUTPUT_2
          : undefined;
  return {
    delegationId: target.delegationId,
    runGeneration: 1,
    sequence,
    parentHarnessId: 'claude',
    parentTurnId: 'stream-request',
    parentToolCallId: 'stream-spawn-progress',
    createdAt: CREATED_AT,
    task: {
      description: 'Review live progress',
      prompt: 'Review live progress.',
      executionMode: 'background',
    },
    snapshot: {
      delegationId: target.delegationId,
      runGeneration: 1,
      status,
      outputTruncated: false,
      routeSnapshot,
      phase: step === 'queued' ? 'queued' : 'running',
      ...(step === 'queued' ? { queue: delegationQueueIdentity() } : {}),
      ...(step === 'approval' || step === 'late-frame'
        ? { approvalPending: true }
        : {}),
      ...(partialText === undefined ? {} : { partialText }),
    },
    transcript,
    transcriptStore: DELEGATION_TRANSCRIPT_CHAT_STREAM,
  };
}

/** E2E only: publish live snapshots and committed state for the progress run. */
function installLiveProgress(
  service: FixtureService,
  scope: { projectId: string; worktreeId: string },
  target: Awaited<ReturnType<typeof seedRun>>,
): void {
  const liveFrames = new DelegationLiveFrames();
  // As in production, the creation row keeps the sequence of the run's first
  // publication, and every later live snapshot has a higher one.
  let sequence = PROGRESS_CREATION_SEQUENCE;
  let previous: Promise<unknown> = Promise.resolve();

  const publishLive = (
    transcript: AgentDelegationTranscript,
  ): AgentDelegationTranscript => {
    const rendererFrame = liveFrames.frame(transcript);
    if (!isAgentDelegationTranscript(rendererFrame))
      throw new Error('E2E progress live frame is invalid');
    const data: Record<string, unknown> = {
      type: 'canopy_delegation',
      delegation: rendererFrame,
      canopy_turn_user_message_id: transcript.parentTurnId,
    };
    sendToAllWindows(IPC_CHANNELS.chatEvent, {
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      chatId: target.chatId,
      data,
    });
    return rendererFrame;
  };

  const advance = async (
    step: LiveProgressStep,
  ): Promise<Record<string, unknown>> => {
    const before = await service.getChildStreamState(scope, target);
    if (!before || !before.cardState || before.cardState.version !== 2)
      throw new Error('E2E progress run is not seeded');
    if (step === 'approval') {
      if (before.status !== 'open')
        throw new Error('E2E progress run is not open');
      await service.updateCardState(scope, {
        target,
        cardRevision: before.cardState.cardRevision + 1,
        cardDraft: runningDraft('Review live progress.', 'running'),
      });
    } else if (step === 'output') {
      await commitProgressOutput(service, scope, target, OUTPUT_1, false, step);
    } else if (step === 'output-more') {
      await commitProgressOutput(service, scope, target, OUTPUT_2, false, step);
    } else if (step === 'settled') {
      await commitProgressOutput(
        service,
        scope,
        target,
        OUTPUT_2,
        false,
        'settled-open',
      );
      await commitProgressOutput(
        service,
        scope,
        target,
        OUTPUT_2,
        true,
        'settled-final',
      );
      await service.settleDelegationResult(scope, {
        target,
        settlementKey: 'e2e-stream-settlement-progress-v1',
        resultIndex: 1,
        outcome: { status: 'completed', finishedAt: CREATED_AT + 1000 },
        finalChanges: [],
        answer: { role: 'final', text: 'Live progress complete.' },
      });
    }

    const after = await service.getChildStreamState(scope, target);
    if (!after || !after.cardState || after.cardState.version !== 2)
      throw new Error('E2E progress descriptor disappeared');
    const sentFrames: Record<string, unknown>[] = [];
    if (step !== 'settled') {
      sequence += 1;
      const transcript = liveProgressTranscript(step, sequence, target);
      const rendererFrame = publishLive(transcript);
      sentFrames.push({
        sequence: rendererFrame.sequence,
        snapshot: {
          status: rendererFrame.snapshot.status,
          phase: rendererFrame.snapshot.phase ?? null,
          approvalPending: rendererFrame.snapshot.approvalPending ?? null,
          partialText: rendererFrame.snapshot.partialText ?? null,
        },
      });
    }
    return {
      step,
      target,
      descriptor: {
        status: after.status,
        streamRevision: after.streamRevision,
        cardStatus: after.cardState.canonical?.status ?? after.cardState.status,
        cardRevision: after.cardState.cardRevision,
      },
      frames: sentFrames,
    };
  };

  Object.defineProperty(globalThis, LIVE_PROGRESS_KEY, {
    configurable: true,
    value: (step: unknown): Promise<Record<string, unknown>> => {
      if (!isLiveProgressStep(step))
        return Promise.reject(new Error('Invalid E2E live progress step'));
      const next = previous.then(() => advance(step));
      previous = next.catch(() => undefined);
      return next;
    },
  });
}

/**
 * E2E only: after the reader mounts, append one child row to the open live
 * run and publish its committed card update, through the production methods.
 * In `stream` mode the card is left as it is, so the only card event is the
 * stream advance at the current card revision.
 */
function installLiveRelease(
  service: ChatStateService,
  scope: { projectId: string; worktreeId: string },
  spec: FixtureSpec,
  target: Awaited<ReturnType<typeof seedRun>>,
): void {
  const anchorMessageId = `delegated-agent-${target.delegationId}`;
  const release = async (
    label: string,
    mode: 'card' | 'stream',
  ): Promise<Record<string, unknown>> => {
    const before = await service.getChildStreamState(scope, target);
    if (before?.status !== 'open' || before.cardState?.version !== 2)
      throw new Error('E2E live run is not open');
    const rowId = `live-release-${label}`;
    await service.commitChildStream(scope, target, `e2e-stream-${rowId}`, [
      {
        id: rowId,
        role: 'assistant',
        timestamp: CREATED_AT + 10 + before.committedRowCount,
        parentBlockId: anchorMessageId,
        delegationSequence: before.committedRowCount,
        itemRevision: 0,
        final: true,
        blocks: [{ type: 'text', text: `Live release sentinel ${label}.` }],
      },
    ]);
    if (mode === 'card')
      await service.updateCardState(scope, {
        target,
        cardRevision: before.cardState.cardRevision + 1,
        cardDraft: runningDraft('Review live evidence.'),
      });
    const after = await service.getChildStreamState(scope, target);
    const page = await service.getTranscriptPage({
      ...scope,
      chatId: spec.chatId,
      target,
    });
    const newestRowIds = page.messages.map((message): string => message.id);
    if (
      after?.cardState?.version !== 2 ||
      after.streamRevision <= before.streamRevision ||
      (mode === 'card'
        ? after.cardState.cardRevision <= before.cardState.cardRevision
        : after.cardState.cardRevision !== before.cardState.cardRevision) ||
      !newestRowIds.includes(rowId)
    ) {
      throw new Error(`E2E live release ${label} was not committed`);
    }
    return {
      target,
      anchorMessageId,
      rowId,
      before: {
        streamRevision: before.streamRevision,
        cardRevision: before.cardState.cardRevision,
      },
      after: {
        streamRevision: after.streamRevision,
        cardRevision: after.cardState.cardRevision,
      },
      newestRowIds,
    };
  };
  let previous: Promise<unknown> = Promise.resolve();
  Object.defineProperty(globalThis, LIVE_RELEASE_KEY, {
    configurable: true,
    value: (
      label: unknown,
      mode: unknown = 'card',
    ): Promise<Record<string, unknown>> => {
      if (typeof label !== 'string' || !/^[a-z0-9-]{1,32}$/.test(label))
        return Promise.reject(new Error('Invalid E2E live release label'));
      if (mode !== 'card' && mode !== 'stream')
        return Promise.reject(new Error('Invalid E2E live release mode'));
      // Releases run one at a time, so each reads the previous one's revisions.
      const next = previous.then(() => release(label, mode));
      previous = next.catch(() => undefined);
      return next;
    },
  });
}

async function verifyPagedRun(
  service: ChatStateService,
  scope: { projectId: string; worktreeId: string },
  spec: FixtureSpec,
  target: Awaited<ReturnType<typeof seedRun>>,
): Promise<Record<string, unknown>> {
  const page = await service.getTranscriptPage({
    ...scope,
    chatId: spec.chatId,
    target,
  });
  const row = page.messages.find(
    (message): boolean => message.id === 'blocks-row-1',
  );
  const omitted = row?.blocksOmitted?.blockCount;
  const read = (
    firstBlockOrdinal: number,
    limit: number,
  ): Promise<ChatTranscriptBlocksPage> =>
    service.getTranscriptBlocks({
      ...scope,
      chatId: spec.chatId,
      target,
      messageId: 'blocks-row-1',
      firstBlockOrdinal,
      limit,
    });
  const head = await read(0, 1);
  const tail = await read(PAGED_BLOCK_COUNT - 1, 1);
  const stored = await read(42, 1);
  const storedBlock = stored.blocks[0];
  const storedRef =
    storedBlock?.type === 'tool_result' ? storedBlock.fullOutputRef : undefined;
  const storedTail = storedRef
    ? await service.readTranscriptContent({
        ...scope,
        chatId: spec.chatId,
        target,
        messageId: 'blocks-row-1',
        blockOrdinal: 42,
        field: 'output',
        requestId: 'e2e-paged-tail',
        offset: storedRef.byteLength - 64,
        limit: 64,
      })
    : undefined;
  const first = head.blocks[0];
  const last = tail.blocks[0];
  if (
    row?.blocks.length !== 0 ||
    omitted !== PAGED_BLOCK_COUNT ||
    head.blockCount !== PAGED_BLOCK_COUNT ||
    first?.type !== 'text' ||
    !first.text.includes('paged block first sentinel') ||
    last?.type !== 'text' ||
    !last.text.includes('paged block last sentinel') ||
    !storedTail?.text.includes('paged stored tail sentinel')
  ) {
    throw new Error(
      `E2E paged run preconditions failed: omitted=${omitted}, count=${head.blockCount}, stored=${storedRef?.byteLength}`,
    );
  }
  return {
    target,
    messageId: 'blocks-row-1',
    omittedBlockCount: omitted,
    storedOrdinal: 42,
    storedByteLength: storedRef?.byteLength,
    transcriptRevision: head.transcriptRevision,
  };
}

async function verifyPrimaryResults(
  service: ChatStateService,
  scope: { projectId: string; worktreeId: string },
  spec: FixtureSpec,
): Promise<Record<string, unknown>> {
  const page = await service.getTranscriptPage({
    ...scope,
    chatId: spec.chatId,
  });
  const block = (
    messageId: string,
    ordinal: number,
  ): PersistedChatBlock | undefined =>
    page.messages.find((message): boolean => message.id === messageId)?.blocks[
      ordinal
    ];
  const stored = block('primary-read', 2);
  const storedRef =
    stored?.type === 'tool_result' ? stored.fullOutputRef : undefined;
  const storedTail = storedRef
    ? await service.readTranscriptContent({
        ...scope,
        chatId: spec.chatId,
        messageId: 'primary-read',
        blockOrdinal: 2,
        field: 'output',
        requestId: 'e2e-primary-tail',
        offset: storedRef.byteLength - 64,
        limit: 64,
      })
    : undefined;
  const inline = block('primary-grep-result', 0);
  const inlineLength =
    inline?.type === 'tool_result' && inline.fullOutputRef === undefined
      ? inline.output.length
      : 0;
  if (
    !storedTail?.text.includes(PRIMARY_STORED_TAIL) ||
    inlineLength <= 4_000
  ) {
    throw new Error(
      `E2E primary preconditions failed: stored=${storedRef?.byteLength}, inline=${inlineLength}`,
    );
  }
  return {
    storedMessageId: 'primary-read',
    storedByteLength: storedRef?.byteLength,
    inlineMessageId: 'primary-grep-result',
    inlineLength,
  };
}
