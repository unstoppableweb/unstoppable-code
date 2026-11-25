/** @jest-environment jsdom */
import {
  act,
  type JSX,
  type ReactElement,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  RemoteControlAskUserQuestion,
  RemoteControlChatMessage,
  RemoteControlChatPart,
} from '@canopy/protocol/remote-control/shell';
import { createSurfacedErrorRecorder } from '@canopy/protocol/app-errors';
import {
  AskUserQuestionCard,
  ConfirmDialog,
  ErrorBanner,
  ErrorState,
  FieldError,
  FileAttachmentChip,
  FileDeliverableCard,
  MessageMediaTile,
  Notice,
  WakeTurnBoundary,
} from '@canopy/ui-shared/components';
import { setSurfacedErrorRecorder } from '@canopy/ui-shared/lib';
import {
  CHAT_PART_REPLAY_POLICY,
  ChatMessageView,
  ChatPartView,
} from '@canopy/ui-app';
import { buildPostHogSessionRecordingOptions } from '@canopy/desktop-instrumentation/client';
import {
  encodeReplayField,
  maskReplaySnapshotData,
  readReplayStylesheetMaskCounts,
} from '@canopy/desktop-instrumentation/client/posthog-replay-stylesheets';
import { gunzipSync, strFromU8, strToU8 } from 'fflate';
import { findSharedTextCredentialRule } from '@canopy/protocol/shared-containers';
import type { RendererBundleOutput } from '../../../../main/build/renderer-react-work-hook';
import type {
  PipelinePackageAnalysisSummary,
  PipelinePackageResource,
} from '@canopy/protocol/pipelines';
import type { RemoteControlPluginCatalogUnifiedEntry } from '@canopy/protocol/remote-control/shell';
import {
  PluginConnectionNotice,
  SkillUpdateNotice,
} from '@canopy/ui-shared/components';
import { CloudCopyConsentDialog } from '@canopy/ui-app/capability';
import { CapabilityPackageDependencies } from '@canopy/ui-app/sharing';
import {
  McpWorkspaceDefaultsSection,
  RemoteControlPluginsPicker,
} from '@canopy/ui-app';
import {
  FilterDropdown,
  SettingsSelect,
  SortDropdown,
} from '@canopy/ui-shared/components';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  createDefaultApprovalDefaults,
  type SingleRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import type { OrgProjectGrant } from '@canopy/protocol/org-projects';
import type { OrganizationDetail } from '@canopy/protocol/settings/organization';
import { SettingsHostProvider } from '@canopy/ui-app/settings/host';
import { TeamProjectsGrantsEditor } from '@canopy/ui-app/settings/organization/team-projects-grants-editor';
import {
  EMPTY_WORKFLOW_LIBRARY_FILTERS,
  WorkflowsLibraryToolbar,
  countLibraryFacets,
  type WorkflowLibraryFilters,
} from '@canopy/ui-app/workflows';
import type { AutomationScope } from '@/hooks/useAutomationScope';
import { WorkflowsScheduleTab } from '@/components/workflows/schedule/WorkflowsScheduleTab';
import { useDesktopStandaloneSettingsHost } from '@/components/settings/hosted/DesktopSettingsHost';
import { useWorkflowsViewStore } from '@/stores/workflowsViewStore';
import { ApprovalsTab } from '@/components/settings/ApprovalsTab';
import { SettingsReplayPrivacyContext } from '@/components/settings/settings-replay-privacy';
import { SETTINGS_SECTION_REPLAY_PRIVACY } from '@canopy/desktop-instrumentation/posthog-replay-surfaces';
import { SharedContainerForkModal } from '@/components/shared-containers/SharedContainerForkModal';
import { useProjectsStore } from '@/stores/projectsStore';
import { useGitHubStore } from '@/stores/githubStore';
import type { SharedContainerForkResponse } from '@canopy/desktop-shared/types';
import { SharedContainerForkResult } from '@canopy/ui-shared/sharing';
// The pin below reads a shared module's source, as the subagent parity golden does.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import path from 'node:path';
import {
  MAX_RENDERER_STYLESHEET_LENGTH,
  rendererStylesheetCredentialPlugin,
} from '../../../../main/build/renderer-stylesheet-credentials';

const mockOpenForkedContainer = jest.fn<
  Promise<{ switchedTo: null }>,
  [SharedContainerForkResponse]
>();
jest.mock('@/lib/shared-containers/open-forked-container', () => ({
  openForkedContainer: (
    response: SharedContainerForkResponse,
  ): Promise<{ switchedTo: null }> => mockOpenForkedContainer(response),
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Conversation content every scenario carries. The recorder's text redaction
 * leaves it alone (the first test checks), so its absence from a recording
 * means the transcript kept it out.
 */
const SECRET = 'zebra-lantern-4417';

type StartRecording = (
  options: object & { emit: (event: unknown) => void },
) => (() => void) | undefined;

const isObject = (value: unknown): value is object =>
  typeof value === 'object' && value !== null;

/** rrweb's recorder, as the desktop loads it from posthog-js. */
async function loadRecorder(): Promise<StartRecording> {
  await import('posthog-js/dist/recorder');
  const extensions: unknown = Reflect.get(window, '__PosthogExtensions__');
  const rrweb: unknown = isObject(extensions)
    ? Reflect.get(extensions, 'rrweb')
    : undefined;
  const record: unknown = isObject(rrweb)
    ? Reflect.get(rrweb, 'record')
    : undefined;
  if (typeof record !== 'function') throw new Error('No rrweb recorder');
  return (options) => {
    const stop: unknown = Reflect.apply(record, rrweb, [options]);
    return typeof stop === 'function'
      ? () => void Reflect.apply(stop, undefined, [])
      : undefined;
  };
}

let record: StartRecording;

/** What session replay would send for the page as it is now. */
function recording(): string {
  const events: unknown[] = [];
  const stop = record({
    ...buildPostHogSessionRecordingOptions(() => undefined),
    emit: (event) => events.push(event),
  });
  stop?.();
  return JSON.stringify(events);
}

/** One or more parts of each kind, with SECRET in every field it shows. */
const FIXTURES: Record<
  RemoteControlChatPart['kind'],
  readonly RemoteControlChatPart[]
> = {
  mcp_activation: [{ kind: 'mcp_activation', data: { record: SECRET } }],
  text: [
    {
      kind: 'text',
      data: {
        text: `See [${SECRET}](https://example.com/${SECRET}) and \`${SECRET}\`.`,
      },
    },
  ],
  tool_use: [
    {
      kind: 'tool_use',
      data: {
        toolUseId: 'toolu_bash',
        toolName: 'Bash',
        input: JSON.stringify({ command: `echo ${SECRET}` }),
        result: { output: SECRET, isError: false },
      },
    },
    {
      kind: 'tool_use',
      data: {
        toolUseId: 'toolu_fail',
        toolName: 'Read',
        input: JSON.stringify({ file_path: `/tmp/${SECRET}.txt` }),
        result: { output: `Error: ${SECRET}`, isError: true },
      },
    },
    {
      kind: 'tool_use',
      data: {
        toolUseId: 'toolu_plan',
        toolName: 'ExitPlanMode',
        input: JSON.stringify({ plan: `Plan ${SECRET}` }),
      },
    },
  ],
  tool_result: [
    {
      kind: 'tool_result',
      data: { toolName: 'Bash', output: SECRET, isError: false },
    },
  ],
  thinking: [{ kind: 'thinking', data: { text: `Thinking ${SECRET}` } }],
  attachment: [{ kind: 'attachment', data: { text: SECRET } }],
  image: [{ kind: 'image', data: { text: SECRET } }],
  agent: [
    {
      kind: 'agent',
      data: {
        toolUseId: 'toolu_agent',
        subagentType: 'Explore',
        description: SECRET,
        prompt: SECRET,
        result: SECRET,
        subBlocks: [
          { kind: 'text', data: { text: SECRET } },
          {
            kind: 'tool_use',
            data: {
              toolUseId: 'toolu_sub',
              toolName: 'Grep',
              input: JSON.stringify({ pattern: SECRET }),
              result: { output: SECRET, isError: false },
            },
          },
        ],
      },
    },
    {
      kind: 'agent',
      data: {
        toolUseId: 'toolu_delegated',
        subagentType: 'Delegated',
        description: SECRET,
        delegation: {
          delegationId: 'delegation-2',
          runGeneration: 1,
          status: 'failed',
          outputTruncated: false,
          parentHarnessId: 'claude',
          requestedModelId: 'claude-sonnet',
          description: `Delegated ${SECRET}`,
          prompt: `Prompt ${SECRET}`,
          executionMode: 'foreground',
          depth: 2,
          parentDelegationId: 'delegation-1',
          parentDescription: `Parent ${SECRET}`,
          permissions: { writePaths: [`/work/${SECRET}`] },
          control: {
            operationId: 'op-1',
            operation: 'steer',
            status: 'failed',
            error: `Control ${SECRET}`,
          },
          finalText: `Result ${SECRET}`,
          error: {
            code: 'runtime_error',
            message: `Error ${SECRET}`,
            retryable: false,
          },
        },
      },
    },
  ],
  turn_timer: [{ kind: 'turn_timer', data: { startedAt: 1, completedAt: 2 } }],
  steering: [{ kind: 'steering', data: { text: SECRET } }],
  prompt_source: [{ kind: 'prompt_source', data: { text: SECRET } }],
  compaction: [
    { kind: 'compaction', data: { occurredAt: 1, summary: SECRET } },
  ],
  account_switch: [
    {
      kind: 'account_switch',
      data: { account: `${SECRET}@example.com`, reason: SECRET },
    },
  ],
  mods_skipped: [
    { kind: 'mods_skipped', data: { entries: [{ pluginId: SECRET }] } },
  ],
};

/** Kinds whose fixtures put SECRET on screen, so the sweep checks real content. */
const SHOWS_CONTENT: ReadonlySet<string> = new Set([
  'text',
  'tool_use',
  'tool_result',
  'thinking',
  'attachment',
  'image',
  'agent',
  'compaction',
]);

/** Opens every disclosure, a few rounds deep, so hidden content renders too. */
function expandEverything(): void {
  const clicked = new Set<Element>();
  for (let round = 0; round < 4; round += 1) {
    const fresh = [...document.body.querySelectorAll('button')].filter(
      (each) => !clicked.has(each) && !each.disabled,
    );
    if (fresh.length === 0) return;
    for (const each of fresh) {
      clicked.add(each);
      act(() => each.click());
    }
  }
}

describe('Session replay records no desktop cloud chat content (CAN-5975)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(async () => {
    record = await loadRecorder();
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('records unblocked text, so a missing marker means it was kept out', () => {
    act(() => root.render(<p>Visible {SECRET}</p>));
    expect(recording()).toContain(SECRET);
  });

  const kinds = Object.keys(CHAT_PART_REPLAY_POLICY).filter(
    (kind): kind is RemoteControlChatPart['kind'] => kind in FIXTURES,
  );

  it('covers every part kind', () => {
    expect(kinds.sort()).toEqual(Object.keys(CHAT_PART_REPLAY_POLICY).sort());
  });

  it.each(kinds)('a %s part records none of its content', async (kind) => {
    for (const part of FIXTURES[kind]) {
      await act(async () => {
        root.render(<ChatPartView part={part} live={false} />);
        await Promise.resolve();
      });
      expandEverything();
      if (SHOWS_CONTENT.has(kind))
        expect(document.body.textContent).toContain(SECRET);
      expect({
        kind,
        part: part.data,
        recorded: recording().includes(SECRET),
      }).toEqual({
        kind,
        part: part.data,
        recorded: false,
      });
    }
  });

  it('a nested delegated agent records none of its parent, paths, errors or result', () => {
    const delegated = FIXTURES.agent.find(
      (part) =>
        part.kind === 'agent' &&
        typeof part.data === 'object' &&
        part.data !== null &&
        'delegation' in part.data,
    );
    if (delegated === undefined) throw new Error('No delegated fixture');
    act(() => root.render(<ChatPartView part={delegated} live={false} />));
    expandEverything();
    expect(
      container.querySelector('[data-testid="chat-delegated-agent"]'),
    ).not.toBeNull();
    for (const shown of [
      `Parent ${SECRET}`,
      `/work/${SECRET}`,
      `Control ${SECRET}`,
      `Error ${SECRET}`,
    ])
      expect(document.body.textContent).toContain(shown);
    expect(recording()).not.toContain(SECRET);
  });

  it("records a tool row's and an agent card's controls, not their content", () => {
    const [agent] = FIXTURES.agent;
    if (agent === undefined) throw new Error('No agent fixture');
    act(() => root.render(<ChatPartView part={agent} live={false} />));
    expandEverything();
    const payload = recording();
    expect(document.body.textContent).toContain('Hide result');
    expect(payload).toContain('Hide result');
    expect(payload).not.toContain(SECRET);
  });

  it('a user and an assistant message record none of their text, links or code', () => {
    const message = (
      role: RemoteControlChatMessage['role'],
    ): RemoteControlChatMessage => ({
      messageId: `m-${role}`,
      chatId: 'chat-1',
      role,
      status: 'complete',
      text: `Hi ${SECRET}, see [${SECRET}](https://example.com/${SECRET}) and \`${SECRET}\`.`,
      createdAtMs: 1,
    });
    for (const role of ['user', 'assistant'] as const) {
      act(() => root.render(<ChatMessageView message={message(role)} />));
      expect(document.body.textContent).toContain(SECRET);
      expect({ role, recorded: recording().includes(SECRET) }).toEqual({
        role,
        recorded: false,
      });
    }
  });

  const question = (
    fields: Partial<RemoteControlAskUserQuestion>,
  ): RemoteControlAskUserQuestion => ({
    header: `Header ${SECRET}`,
    question: `Question ${SECRET}?`,
    options: [],
    ...fields,
  });

  const renderQuestion = (q: RemoteControlAskUserQuestion): void => {
    act(() =>
      root.render(
        <AskUserQuestionCard
          state={{ requestId: 'req-1', answered: false, questions: [q] }}
          onSubmit={(): void => undefined}
          onDismiss={(): void => undefined}
        />,
      ),
    );
  };

  it('a buttons question records its option controls and Send, not its text', () => {
    renderQuestion(
      question({
        control: 'buttons',
        options: [`Visa ${SECRET}`, `Amex ${SECRET}`],
      }),
    );
    const payload = recording();
    expect(payload).not.toContain(SECRET);
    expect(payload).toContain('Send');
    expect(payload).toContain('"type":"radio"');
  });

  it.each([
    [
      'select',
      question({
        control: 'select',
        options: Array.from({ length: 8 }, (_, i) => `Option ${i} ${SECRET}`),
        placeholder: `Pick ${SECRET}`,
      }),
    ],
    ['text', question({ control: 'text', placeholder: `Type ${SECRET}` })],
    [
      'textarea',
      question({ control: 'textarea', placeholder: `Write ${SECRET}` }),
    ],
  ])(
    'a %s question records its field, not its question, options or placeholder',
    (control, q) => {
      renderQuestion(q);
      expect(recording()).not.toContain(SECRET);
      if (control !== 'select') {
        expect(recording()).toContain(
          control === 'text' ? '"tagName":"input"' : '"tagName":"textarea"',
        );
        return;
      }
      const field = container.querySelector('[role="combobox"]');
      if (!(field instanceof HTMLElement)) throw new Error('No select field');
      act(() => field.click());
      const options = [...document.body.querySelectorAll('[role="option"]')];
      expect(options).toHaveLength(8);
      expect(recording()).not.toContain(SECRET);
      expect(recording()).toContain('"role":"option"');
      const third = options[3];
      if (!(third instanceof HTMLElement)) throw new Error('No option');
      act(() => third.click());
      expect(document.body.textContent).toContain(`Option 3 ${SECRET}`);
      expect(recording()).not.toContain(SECRET);
    },
  );

  it("a question's validation message records none of the question", () => {
    renderQuestion(question({ control: 'text', required: true }));
    const form = container.querySelector('form');
    if (form === null) throw new Error('No question form');
    act(() => {
      form.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    const message = container.querySelector('[role="alert"], [aria-live]');
    expect(message?.textContent).toContain(SECRET);
    expect(recording()).not.toContain(SECRET);
  });

  it.each([
    ['finished', {}],
    ['event', { event: true }],
    ['scheduled', { scheduled: true }],
  ])('a wake turn for a %s task records none of its label', (_kind, props) => {
    act(() =>
      root.render(
        <WakeTurnBoundary taskLabel={`npm run ${SECRET}`} {...props} />,
      ),
    );
    expect(document.body.textContent).toContain(SECRET);
    expect(recording()).not.toContain(SECRET);
  });

  it('file chips, deliverable cards and media tiles record their controls, not file names', () => {
    const name = `offer-letter-${SECRET}.pdf`;
    const noop = (): void => undefined;
    act(() =>
      root.render(
        <div>
          <FileAttachmentChip filename={name} onOpen={noop} onDownload={noop} />
          <FileAttachmentChip filename={name} />
          <FileDeliverableCard
            filename={name}
            description={`Draft for ${SECRET}`}
            pathLabel={`/out/${name}`}
            onOpen={noop}
            onDownload={noop}
          />
          <MessageMediaTile
            image={{ key: 'a', src: 'data:,', alt: name, onOpen: noop }}
          />
          <MessageMediaTile
            image={{ key: 'b', src: 'data:,', alt: name, kind: 'video' }}
          />
        </div>,
      ),
    );
    expect(document.body.textContent).toContain(SECRET);
    const payload = recording();
    expect(payload).not.toContain(SECRET);
    expect(payload).toContain('Open attached file');
    expect(payload).toContain('Download file');
  });

  // CAN-7102: a caught message can quote paths and command output, so the
  // shared error primitives block it from replay and from the exported record.
  describe('error text from a caught message', () => {
    const reported: unknown[] = [];
    let uninstall: () => void;

    beforeEach(() => {
      reported.length = 0;
      const recorder = createSurfacedErrorRecorder({
        recordsMessageText: true,
        report: (error) => {
          reported.push(error);
          return undefined;
        },
      });
      uninstall = setSurfacedErrorRecorder((input) => recorder.record(input));
    });

    afterEach(() => uninstall());

    const noop = (): void => undefined;
    // Each surface, and whether it exports a surfaced-error record at all.
    const SURFACES: Record<string, [() => ReactElement, boolean]> = {
      'a string ErrorBanner': [
        () => (
          <ErrorBanner
            error={`Failed: /Users/x/${SECRET}.`}
            errorSource="test"
          />
        ),
        true,
      ],
      'a destructive Notice with a string child': [
        () => (
          <Notice intent="destructive" errorSource="test">
            {`Failed: /Users/x/${SECRET}`}
          </Notice>
        ),
        true,
      ],
      'a ConfirmDialog error': [
        () => (
          <ConfirmDialog
            title="Remove"
            message="Remove it?"
            confirmLabel="Remove"
            errorMessage={`Failed: /Users/x/${SECRET}`}
            errorSource="test"
            onConfirm={noop}
            onCancel={noop}
          />
        ),
        true,
      ],
      'a string ErrorState': [
        () => <ErrorState message={`Failed: /Users/x/${SECRET}`} />,
        false,
      ],
      'a string FieldError': [
        () => (
          <FieldError id="field">{`Failed: /Users/x/${SECRET}`}</FieldError>
        ),
        false,
      ],
    };

    it.each(Object.keys(SURFACES))(
      '%s is on screen, but in no replay and no exported record',
      (name) => {
        const entry = SURFACES[name];
        if (entry === undefined) throw new Error('No surface');
        const [surface, records] = entry;
        act(() => root.render(surface()));
        expect(document.body.textContent).toContain(SECRET);
        expect(recording()).not.toContain(SECRET);
        // The sighting is still exported, only without its text.
        expect(reported.length > 0).toBe(records);
        expect(JSON.stringify(reported)).not.toContain(SECRET);
      },
    );
  });
});

describe('Token-shaped text outside a marker is masked in session replay (CAN-7475)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(async () => {
    record = await loadRecorder();
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  // Built at runtime so no token-shaped literal is committed. Each value
  // trips the shared credential check; none is behind a replay marker.
  const ghToken = `gh${'p'}_${'A'.repeat(36)}`;
  const TOKENS: readonly (readonly [string, string, string])[] = [
    ['a GitHub token', `Use ${ghToken} to deploy.`, ghToken],
    [
      'a GitHub fine-grained token',
      `github_${'pat'}_${'B'.repeat(22)}`,
      'B'.repeat(22),
    ],
    ['a Slack token', `xox${'b'}-${'1'.repeat(12)}`, '1'.repeat(12)],
    ['an AWS access key', `AKI${'A'}${'Z'.repeat(16)}`, 'Z'.repeat(16)],
    ['an API key', `s${'k'}-${'k'.repeat(20)}`, 'k'.repeat(20)],
    [
      'a signed token',
      `ey${'J'}${'a'.repeat(12)}.${'b'.repeat(12)}.${'c'.repeat(12)}`,
      'c'.repeat(12),
    ],
    ['an npm token', `np${'m'}_${'N'.repeat(36)}`, 'N'.repeat(36)],
    ['a colon credential', `pass${'word'}: hunter-two`, 'hunter-two'],
    [
      'a user flag',
      `curl -u admin:hunter${'2'} https://api.example.com`,
      `hunter${'2'}`,
    ],
  ];

  it.each(TOKENS)('masks %s in plain text', (_label, text, secret) => {
    act(() => root.render(<p>{text}</p>));
    const recorded = recording();
    expect(recorded).not.toContain(secret);
    expect(recorded).toContain('*'.repeat(8));
  });

  it('masks a token in an unmarked element attribute', () => {
    act(() =>
      root.render(
        <a
          href="https://example.com/docs"
          title={`Use ${ghToken}`}
          aria-label={ghToken}
        >
          Docs
        </a>,
      ),
    );
    const recorded = recording();
    expect(recorded).not.toContain(ghToken);
    expect(recorded).toContain('Docs');
    expect(recorded).toContain('https://example.com/docs');
  });

  it('keeps the shape of a URL password and a credential flag it already redacts', () => {
    act(() =>
      root.render(
        <div>
          <p>{`https://admin:hunter${'2'}@db.example.com/app`}</p>
          <p>--token abc123</p>
        </div>,
      ),
    );
    const recorded = recording();
    expect(recorded).not.toContain(`hunter${'2'}`);
    expect(recorded).not.toContain('abc123');
    expect(recorded).toContain('https://***@db.example.com/app');
    expect(recorded).toContain('--token ***');
  });

  it.each([
    'Password reset',
    'Set GITHUB_TOKEN in your environment.',
    'npm install',
    'Set npm_config_registry before you publish.',
    'Run --help for options',
    'a'
      .repeat(40)
      .replace(/a/g, (_m, i: number) => '0123456789abcdef'[i % 16] ?? '0'),
    'Tokens: 1,234',
    'skills/review/SKILL.md',
    '/Users/sam/project/src/index.ts',
  ])('records the ordinary text %j unchanged', (text) => {
    act(() => root.render(<p>{text}</p>));
    expect(recording()).toContain(text);
  });
});

describe('Stylesheet content in session replay passes the shared credential check (CAN-7593)', () => {
  type SnapshotEvent = Record<string, unknown>;
  type PostHogLike = {
    init: (token: string, config: object) => unknown;
    startSessionRecording: (override?: boolean) => void;
    stopSessionRecording: () => void;
    sessionRecording?: { onRemoteConfig: (response: object) => void };
  };

  // Built at runtime so no token-shaped literal is committed.
  const ghToken = `gh${'p'}_${'A'.repeat(36)}`;
  const flagged = `.flagged{content:"${ghToken}"}`;
  const clean = '.clean{color:rgb(1, 2, 3)}';
  const batches: unknown[][] = [];
  let posthog: PostHogLike;

  const isPostHog = (value: unknown): value is PostHogLike =>
    isObject(value) &&
    typeof Reflect.get(value, 'init') === 'function' &&
    typeof Reflect.get(value, 'startSessionRecording') === 'function';

  const encode = encodeReplayField;
  const decode = (value: string): unknown =>
    JSON.parse(strFromU8(gunzipSync(strToU8(value, true))));
  /** Every compressed field decoded, so the text can be searched. */
  const readable = (events: readonly unknown[] | null): string =>
    JSON.stringify(
      (events ?? []).map((event) => {
        if (!isObject(event) || Reflect.get(event, 'cv') !== '2024-10')
          return event;
        const copy: Record<string, unknown> = { ...event };
        if (typeof copy.data === 'string') copy.data = decode(copy.data);
        else if (isObject(copy.data)) {
          const data: Record<string, unknown> = { ...copy.data };
          for (const key of ['adds', 'removes', 'texts', 'attributes']) {
            const field = data[key];
            if (typeof field === 'string') data[key] = decode(field);
          }
          copy.data = data;
        }
        return copy;
      }),
    );

  beforeAll(async () => {
    await import('posthog-js/dist/lazy-recorder');
    const sdk: unknown = Reflect.get(await import('posthog-js'), 'default');
    if (!isPostHog(sdk)) throw new Error('No PostHog SDK');
    posthog = sdk;
    posthog.init('phc_replay_golden', {
      api_host: 'http://127.0.0.1:9',
      persistence: 'memory',
      disable_session_recording: true,
      session_recording: buildPostHogSessionRecordingOptions(() => undefined),
      advanced_disable_flags: true,
      disable_external_dependency_loading: true,
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      before_send: (event: unknown) => {
        if (!isObject(event) || Reflect.get(event, 'event') !== '$snapshot')
          return null;
        const properties: unknown = Reflect.get(event, 'properties');
        const data: unknown = isObject(properties)
          ? Reflect.get(properties, '$snapshot_data')
          : undefined;
        if (Array.isArray(data))
          batches.push(data.map((each: unknown) => each));
        return null;
      },
    });
  });

  afterEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  const settle = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 150));

  /** What the SDK hands before_send for the page the setup builds. */
  async function snapshotEvents(setup: () => void): Promise<unknown[]> {
    batches.length = 0;
    setup();
    posthog.sessionRecording?.onRemoteConfig({
      ok: true,
      config: {
        sessionRecording: { endpoint: '/s/' },
        supportedCompression: [],
        toolbarParams: {},
        toolbarVersion: 'toolbar',
        isAuthenticated: false,
        siteApps: [],
      },
    });
    posthog.startSessionRecording(true);
    await settle();
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    window.dispatchEvent(new Event('beforeunload'));
    await settle();
    posthog.stopSessionRecording();
    return batches.flat();
  }

  const styleWithText = (css: string, parent: Node = document.head): void => {
    const style = document.createElement('style');
    style.textContent = css;
    parent.appendChild(style);
  };

  it('receives the compressed format it decodes', async () => {
    const events = await snapshotEvents(() => styleWithText(clean));
    const full = events.filter(
      (event): event is SnapshotEvent =>
        isObject(event) && Reflect.get(event, 'type') === 2,
    );
    expect(full.length).toBeGreaterThan(0);
    for (const event of full) {
      expect(event.cv).toBe('2024-10');
      expect(typeof event.data).toBe('string');
    }
  });

  it('masks a flagged rule in <style> text and keeps the clean one', async () => {
    const events = await snapshotEvents(() =>
      styleWithText(`${clean}${flagged}`),
    );
    expect(readable(events)).toContain(ghToken);
    const masked = readable(maskReplaySnapshotData(events));
    expect(masked).not.toContain(ghToken);
    expect(masked).toContain('.clean');
  });

  it('masks a flagged rule in a sheet recorded as _cssText', async () => {
    const events = await snapshotEvents(() => {
      const style = document.createElement('style');
      document.head.appendChild(style);
      style.sheet?.insertRule(clean, 0);
      style.sheet?.insertRule(flagged, 1);
    });
    expect(readable(events)).toContain('_cssText');
    const masked = readable(maskReplaySnapshotData(events));
    expect(masked).not.toContain(ghToken);
    expect(masked).toContain('.clean');
  });

  it('masks a flagged rule in a style inside a shadow root', async () => {
    const events = await snapshotEvents(() => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      styleWithText(`${clean}${flagged}`, host.attachShadow({ mode: 'open' }));
    });
    expect(readable(events)).toContain(ghToken);
    const masked = readable(maskReplaySnapshotData(events));
    expect(masked).not.toContain(ghToken);
    expect(masked).toContain('.clean');
  });

  it('masks a non-ASCII sheet and re-encodes the clean rules byte for byte', async () => {
    const nonAscii = '.café::before{content:"→ ünïcødé ✓"}';
    const events = await snapshotEvents(() =>
      styleWithText(`${nonAscii}${flagged}`),
    );
    const before = readable(events);
    const start = before.indexOf('.café');
    const kept = before.slice(start, before.indexOf('}', start) + 1);
    expect(kept).toContain('→ ünïcødé ✓');
    expect(before).toContain(ghToken);
    const masked = readable(maskReplaySnapshotData(events));
    expect(masked).not.toContain(ghToken);
    expect(masked).toContain(kept);
  });

  it('keeps a payload without a hit identical, ordinary CSS included', async () => {
    const events = await snapshotEvents(() =>
      styleWithText(
        `${clean}@media (min-width: 600px){.wide{display:grid}}@layer base{.a{margin:0}}:root{--accent:#123456}`,
      ),
    );
    expect(maskReplaySnapshotData(events)).toEqual(events);
  });

  it('still empties a local file URL in recorded CSS', async () => {
    const events = await snapshotEvents(() => {
      const style = document.createElement('style');
      document.head.appendChild(style);
      style.sheet?.insertRule(
        '.icon{background:url("file:///Users/sam/app/icon.png")}',
        0,
      );
    });
    expect(readable(maskReplaySnapshotData(events))).not.toContain(
      '/Users/sam',
    );
  });

  // jsdom's CSSOM doesn't reach rrweb's insertRule and setProperty observers,
  // so these events are built in the shape and encoding the SDK sends.
  const incremental = (
    data: Record<string, unknown>,
    cv?: string,
  ): SnapshotEvent => ({
    type: 3,
    timestamp: 1,
    data,
    ...(cv && { cv }),
  });

  it('masks a flagged CSSOM rule edit in a compressed event', () => {
    const event = incremental(
      {
        source: 8,
        id: 7,
        adds: encode([
          { rule: flagged, index: 0 },
          { rule: clean, index: 1 },
        ]),
      },
      '2024-10',
    );
    const masked = readable(maskReplaySnapshotData([event]));
    expect(masked).not.toContain(ghToken);
    expect(masked).toContain('.clean');
  });

  it('masks a token in replaceSync, which the SDK leaves uncompressed', () => {
    const event = incremental(
      { source: 8, id: 7, replaceSync: `${clean}${flagged}` },
      '2024-10',
    );
    const masked = readable(maskReplaySnapshotData([event]));
    expect(masked).not.toContain(ghToken);
    expect(masked).toContain('.clean');
  });

  it.each([
    [
      'a flagged value',
      { set: { property: '--deploy', value: `"${ghToken}"`, priority: '' } },
    ],
    [
      'a token in a custom property name',
      { set: { property: `--${ghToken}`, value: '1', priority: '' } },
    ],
    [
      'a removed custom property named with a token',
      { remove: { property: `--${ghToken}` } },
    ],
  ])('drops a declaration edit with %s', (_label, change) => {
    const event = incremental({ source: 13, id: 7, index: [0], ...change });
    expect(maskReplaySnapshotData([event])).toEqual([]);
  });

  const placeholder = ':not(*){}';
  /** The masked event's rule edits, decoded when compressed. */
  const ruleEdits = (events: readonly unknown[] | null): unknown =>
    JSON.parse(readable(events));

  it.each([
    ['plain', undefined],
    ['compressed', '2024-10'],
  ])(
    'keeps CSSOM rule indices when it masks a %s rule addition',
    (_label, cv) => {
      const field = (value: unknown): unknown => (cv ? encode(value) : value);
      const events = [
        incremental(
          { source: 8, id: 7, adds: field([{ rule: flagged, index: 0 }]) },
          cv,
        ),
        incremental(
          { source: 8, id: 7, adds: field([{ rule: clean, index: 1 }]) },
          cv,
        ),
        incremental({ source: 8, id: 7, removes: field([{ index: 0 }]) }, cv),
      ];
      expect(ruleEdits(maskReplaySnapshotData(events))).toEqual([
        {
          type: 3,
          timestamp: 1,
          ...(cv && { cv }),
          data: { source: 8, id: 7, adds: [{ rule: placeholder, index: 0 }] },
        },
        {
          type: 3,
          timestamp: 1,
          ...(cv && { cv }),
          data: { source: 8, id: 7, adds: [{ rule: clean, index: 1 }] },
        },
        {
          type: 3,
          timestamp: 1,
          ...(cv && { cv }),
          data: { source: 8, id: 7, removes: [{ index: 0 }] },
        },
      ]);
    },
  );

  it('drops a CSSOM addition of a flagged at-rule', () => {
    const event = incremental({
      source: 8,
      id: 7,
      adds: [
        {
          rule: `@font-face{font-family:x;src:url("${ghToken}.woff")}`,
          index: 0,
        },
      ],
    });
    expect(maskReplaySnapshotData([event])).toEqual([]);
  });

  it.each([
    [
      'a style text sheet',
      `.a{color:red}${flagged}.c{color:blue}`,
      `.a{color:red}${placeholder}.c{color:blue}`,
    ],
    [
      'a rule inside @media',
      `@media (min-width: 600px){.a{color:red}${flagged}}`,
      `@media (min-width: 600px){.a{color:red}${placeholder}}`,
    ],
  ])(
    'keeps the rule index of a flagged rule in %s',
    (_label, css, expected) => {
      const event = incremental({ source: 8, id: 7, replaceSync: css });
      expect(ruleEdits(maskReplaySnapshotData([event]))).toEqual([
        {
          type: 3,
          timestamp: 1,
          data: { source: 8, id: 7, replaceSync: expected },
        },
      ]);
    },
  );

  it.each([
    [
      'a flagged @font-face',
      `${clean}@font-face{font-family:x;src:url("${ghToken}.woff")}`,
    ],
    [
      'a flagged keyframe',
      `${clean}@keyframes spin{from{content:"${ghToken}"}to{opacity:1}}`,
    ],
  ])('empties the whole sheet for %s', (_label, css) => {
    const event = incremental({ source: 8, id: 7, replaceSync: css });
    expect(ruleEdits(maskReplaySnapshotData([event]))).toEqual([
      { type: 3, timestamp: 1, data: { source: 8, id: 7, replaceSync: '' } },
    ]);
  });

  it('masks a flagged rule in an adopted sheet', () => {
    const event = incremental({
      source: 15,
      id: 1,
      styleIds: [1],
      styles: [
        {
          styleId: 1,
          rules: [
            { rule: flagged, index: 0 },
            { rule: clean, index: 1 },
          ],
        },
      ],
    });
    const masked = readable(maskReplaySnapshotData([event]));
    expect(masked).not.toContain(ghToken);
    expect(masked).toContain('.clean');
  });

  it('masks a plain event of a type the SDK usually compresses', () => {
    const event: SnapshotEvent = {
      type: 2,
      timestamp: 1,
      data: {
        node: {
          type: 0,
          id: 1,
          childNodes: [
            {
              type: 3,
              id: 2,
              isStyle: true,
              textContent: `${clean}${flagged}`,
            },
          ],
        },
        initialOffset: { left: 0, top: 0 },
      },
    };
    const masked = readable(maskReplaySnapshotData([event]));
    expect(masked).not.toContain(ghToken);
    expect(masked).toContain('.clean');
  });

  it('removes a token in a top-level comment', () => {
    const event = incremental({
      source: 8,
      id: 7,
      replaceSync: `${clean}/* ${ghToken} */`,
    });
    const masked = readable(maskReplaySnapshotData([event]));
    expect(masked).not.toContain(ghToken);
  });

  it.each([
    [
      'a sheet that does not split into rules',
      `${clean}.open{content:"${ghToken}"`,
    ],
    [
      'a sheet over the scan cap',
      `${clean}${'x'.repeat(4 * 1024 * 1024)}${flagged}`,
    ],
  ])('empties %s', (_label, css) => {
    const event = incremental({ source: 8, id: 7, replaceSync: css });
    const masked = maskReplaySnapshotData([event]);
    expect(readable(masked)).not.toContain(ghToken);
    expect(readable(masked)).not.toContain('.clean');
  });

  const fullSnapshot = (css: string): SnapshotEvent => ({
    type: 2,
    timestamp: 1,
    cv: '2024-10',
    data: encode({
      node: {
        type: 0,
        id: 1,
        childNodes: [{ type: 3, id: 2, isStyle: true, textContent: css }],
      },
      initialOffset: { left: 0, top: 0 },
    }),
  });
  /** The event with its gzip trailer's ISIZE replaced. */
  const withIsize = (event: SnapshotEvent, isize: number): SnapshotEvent => {
    const bytes = strToU8(String(event.data), true);
    new DataView(bytes.buffer).setUint32(bytes.length - 4, isize, true);
    return { ...event, data: strFromU8(bytes, true) };
  };

  it.each([
    [
      'an understated ISIZE (a truncated output)',
      (event: SnapshotEvent): SnapshotEvent => withIsize(event, 16),
    ],
    [
      'an overstated ISIZE',
      (event: SnapshotEvent): SnapshotEvent => withIsize(event, 1_000_000),
    ],
    [
      'an ISIZE over 16 MiB',
      (event: SnapshotEvent): SnapshotEvent =>
        withIsize(event, 16 * 1024 * 1024 + 1),
    ],
    [
      'an unknown compression version',
      (event: SnapshotEvent): SnapshotEvent => ({ ...event, cv: '2025-01' }),
    ],
    [
      'a field that is not compressed text',
      (event: SnapshotEvent): SnapshotEvent => ({ ...event, data: 'not gzip' }),
    ],
  ])('drops an event with %s', (_label, change) => {
    const event = change(fullSnapshot(`${clean}${flagged}`));
    expect(maskReplaySnapshotData([event])).toEqual([]);
  });

  it.each([
    ['a full snapshot', 2],
    ['an incremental snapshot', 3],
  ])('drops %s whose data is not a record', (_label, type) => {
    const event: SnapshotEvent = {
      type,
      timestamp: 1,
      data: `${clean}${flagged}`,
    };
    expect(maskReplaySnapshotData([event])).toEqual([]);
  });

  it('drops a compressed field under 18 bytes', () => {
    const event: SnapshotEvent = {
      ...fullSnapshot(clean),
      data: 'x'.repeat(17),
    };
    expect(maskReplaySnapshotData([event])).toEqual([]);
  });

  it('empties an over-cap payload and keeps its siblings', () => {
    const event: SnapshotEvent = {
      type: 2,
      timestamp: 1,
      data: {
        node: {
          type: 0,
          id: 1,
          childNodes: [
            {
              type: 3,
              id: 2,
              isStyle: true,
              textContent: `${clean}${'x'.repeat(4 * 1024 * 1024)}`,
            },
            {
              type: 3,
              id: 3,
              isStyle: true,
              textContent: '.sibling{color:red}',
            },
          ],
        },
        initialOffset: { left: 0, top: 0 },
      },
    };
    const masked = readable(maskReplaySnapshotData([event]));
    expect(masked).not.toContain('.clean');
    expect(masked).toContain('.sibling{color:red}');
  });

  it('drops a batch that is not an event array', () => {
    expect(maskReplaySnapshotData({ events: [] })).toBeNull();
  });

  it('counts what it masks without keeping any stylesheet text', () => {
    const before = readReplayStylesheetMaskCounts().rulesMasked;
    maskReplaySnapshotData([
      incremental({ source: 8, id: 7, replaceSync: flagged }),
    ]);
    const counts = readReplayStylesheetMaskCounts();
    expect(counts.rulesMasked).toBe(before + 1);
    for (const value of Object.values(counts))
      expect(typeof value).toBe('number');
    expect(JSON.stringify(counts)).not.toContain(ghToken);
  });
});

describe('The renderer build fails on a credential in its stylesheet (CAN-7593)', () => {
  // Built at runtime so no token-shaped literal is committed.
  const ghToken = `gh${'p'}_${'A'.repeat(36)}`;
  const flagged = `.flagged{content:"${ghToken}"}`;
  const clean = '.clean{color:rgb(1, 2, 3)}';
  const rule = findSharedTextCredentialRule(ghToken);

  const css = (
    fileName: string,
    source: string | Uint8Array,
  ): RendererBundleOutput => ({ type: 'asset', fileName, source });

  /** The build's error messages for these outputs; empty when it passes. */
  const build = (outputs: readonly RendererBundleOutput[]): string[] => {
    const hook = rendererStylesheetCredentialPlugin().generateBundle;
    if (typeof hook !== 'object' || hook === null)
      throw new Error('the plugin has no generateBundle handler');
    const errors: string[] = [];
    const context = {
      error: (message: string): never => {
        errors.push(message);
        throw new Error(message);
      },
    };
    const bundle = Object.fromEntries(
      outputs.map((output) => [output.fileName, output]),
    );
    try {
      Reflect.apply(hook.handler, context, [{}, bundle, false]);
    } catch (error) {
      if (errors.length === 0) throw error;
    }
    return errors;
  };

  const expectNoPartOf = (message: string, text: string): void => {
    for (let i = 0; i + 4 <= text.length; i += 1)
      expect(message).not.toContain(text.slice(i, i + 4));
  };

  it('fails on a token in a style rule, naming only the asset, rule, offset and item', () => {
    expect(rule).not.toBeNull();
    const errors = build([
      css('assets/app.css', `${clean}${flagged}`),
      css('assets/vendor.css', clean),
    ]);
    expect(errors).toHaveLength(1);
    const [message = ''] = errors;
    expect(message).toContain(
      `assets/app.css: ${rule} at offset ${clean.length} (item 1)`,
    );
    expect(message).not.toContain('assets/vendor.css');
    expectNoPartOf(message, ghToken);
    expect(message).not.toContain('.flagged');
    expect(message).not.toContain('content:');
  });

  it.each([
    ['@media', '@media (min-width:1px){'],
    ['@layer', '@layer components{'],
  ])('locates a token in a rule inside %s', (_name, open) => {
    const [message = ''] = build([
      css('assets/app.css', `${clean}${open}${clean}${flagged}}`),
    ]);
    expect(message).toContain(
      `assets/app.css: ${rule} at offset ${clean.length + open.length + clean.length} (item 1)`,
    );
    expectNoPartOf(message, ghToken);
  });

  it('locates a token in a top-level comment', () => {
    const [message = ''] = build([
      css('assets/app.css', `${clean}/* ${ghToken} */${clean}`),
    ]);
    expect(message).toContain(
      `assets/app.css: ${rule} at offset ${clean.length} (item 1)`,
    );
    expectNoPartOf(message, ghToken);
  });

  it('fails on a token in a sheet it cannot split', () => {
    const [message = ''] = build([
      css('assets/app.css', `${clean}${flagged}.open{`),
    ]);
    expect(message).toContain(`assets/app.css: ${rule}, not splittable`);
    expectNoPartOf(message, ghToken);
  });

  it('fails a bundle with no CSS asset', () => {
    expect(
      build([{ type: 'chunk', fileName: 'assets/entry.js', code: clean }]),
    ).toEqual([expect.stringContaining('no CSS asset in the renderer bundle')]);
  });

  it('fails an asset that is not valid UTF-8', () => {
    expect(
      build([css('assets/app.css', new Uint8Array([0x2e, 0xff, 0xfe]))]),
    ).toEqual([expect.stringContaining('assets/app.css: not valid UTF-8')]);
  });

  it('fails an asset longer than session replay scans', () => {
    const long = '.c{}'.repeat(MAX_RENDERER_STYLESHEET_LENGTH / 4 + 1);
    expect(build([css('assets/app.css', long)])).toEqual([
      expect.stringContaining(
        `assets/app.css: ${long.length} UTF-16 code units, over the ${MAX_RENDERER_STYLESHEET_LENGTH}`,
      ),
    ]);
  });

  it('passes clean stylesheets, as text or bytes', () => {
    const sheet = `:root{--brand:#123456}${clean}@media (min-width:1px){${clean}}@layer base{${clean}}`;
    expect(
      build([
        css('assets/app.css', sheet),
        css('assets/vendor.css', strToU8(sheet)),
        css(
          'assets/ok-at-cap.css',
          '.c{}'.repeat(MAX_RENDERER_STYLESHEET_LENGTH / 4),
        ),
      ]),
    ).toEqual([]);
  });

  it('checks only stylesheets, and only in builds', () => {
    expect(
      build([
        css('assets/app.css', clean),
        { type: 'chunk', fileName: 'assets/entry.js', code: flagged },
      ]),
    ).toEqual([]);
    expect(rendererStylesheetCredentialPlugin().apply).toBe('build');
  });
});

/** Every attribute value and text on every node session replay records. */
const recordedNodeStrings = (): string[] => {
  const events: unknown[] = [];
  const stop = record({
    ...buildPostHogSessionRecordingOptions(() => undefined),
    emit: (event) => events.push(event),
  });
  stop?.();
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const each of value) visit(each);
      return;
    }
    if (!isObject(value)) return;
    const attributes: unknown = Reflect.get(value, 'attributes');
    if (isObject(attributes))
      for (const name of Object.keys(attributes)) {
        const attribute: unknown = Reflect.get(attributes, name);
        if (typeof attribute === 'string') found.push(attribute);
      }
    const text: unknown = Reflect.get(value, 'textContent');
    if (typeof text === 'string') found.push(text);
    for (const key of Object.keys(value)) visit(Reflect.get(value, key));
  };
  visit(events);
  return found;
};

/** Fails when any recorded attribute or text holds `value`, in any case. */
const expectNowhereInRecording = (values: readonly string[]): void => {
  const recorded = recording().toLowerCase();
  const strings = recordedNodeStrings().map((each) => each.toLowerCase());
  expect(strings.length).toBeGreaterThan(0);
  for (const value of values) {
    const needle = value.toLowerCase();
    expect(recorded).not.toContain(needle);
    expect(strings.filter((each) => each.includes(needle))).toEqual([]);
  }
};

describe('File names and paths stay out of session replay in share dialogs and pickers (CAN-7584)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(async () => {
    record = await loadRecorder();
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const noop = (): void => {};
  const RESOURCE_NAME = 'Harbor ledger kit';
  const SOURCE_LABEL = 'Ledger studio folder';
  const SCRIPT = 'scripts/rename-reorg-files.sh';

  const resource = (
    overrides: Partial<PipelinePackageResource> = {},
  ): PipelinePackageResource => ({
    id: 'skill-harbor-ledger',
    kind: 'standalone_skill',
    displayName: RESOURCE_NAME,
    sourceLabel: SOURCE_LABEL,
    sourceVisibility: 'private',
    invocationKeys: [],
    dependencyResourceIds: [],
    trees: [
      {
        provider: 'claude',
        runtimeKind: 'standalone_skill',
        rootName: 'harbor-ledger-kit',
        entries: [
          { path: 'SKILL.md', sha256: 'a'.repeat(64), size: 10, mode: 'read' },
          { path: SCRIPT, sha256: 'b'.repeat(64), size: 20, mode: 'execute' },
        ],
      },
    ],
    ...overrides,
  });

  const analysis = (
    overrides: Partial<PipelinePackageAnalysisSummary> = {},
  ): PipelinePackageAnalysisSummary => ({
    analysisId: 'analysis-1',
    state: 'ready',
    pipelineContentHash: 'hash',
    manifest: {
      version: 1,
      pipelineContentHash: 'hash',
      resources: [resource()],
      bindings: [],
      environmentRequirements: [],
      totalFiles: 2,
      totalBytes: 30,
    },
    blockers: [],
    expiresAt: '2026-12-01T00:00:00.000Z',
    ...overrides,
  });

  const dependencies = (
    summary: PipelinePackageAnalysisSummary | null,
    extra: Partial<Parameters<typeof CapabilityPackageDependencies>[0]> = {},
  ): ReactElement => (
    <CapabilityPackageDependencies
      analysis={summary}
      loading={false}
      errored={false}
      selectedOptionalResourceIds={[]}
      onToggleOptionalResource={noop}
      onRetry={noop}
      testIdPrefix="share"
      disabled={false}
      {...extra}
    />
  );

  const clickButton = (label: string): void => {
    const button = [...document.body.querySelectorAll('button')].find(
      (each) =>
        each.textContent?.trim() === label ||
        each.getAttribute('aria-label') === label,
    );
    if (!button) throw new Error(`No button labelled ${label}`);
    act(() => button.click());
  };

  /** The accessible name of a checkbox: its aria-labelledby text, else its aria-label. */
  const checkboxNames = (): string[] =>
    [...document.body.querySelectorAll('input[type="checkbox"]')].map(
      (input) => {
        const ids = input.getAttribute('aria-labelledby');
        if (ids === null) return input.getAttribute('aria-label') ?? '';
        return ids
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ')
          .trim();
      },
    );

  const expectKeptOut = (shown: readonly string[], kept: string): void => {
    for (const value of shown) expect(document.body.innerHTML).toContain(value);
    expectNowhereInRecording(shown);
    expect(recording()).toContain(kept);
  };

  it('keeps the cloud copy Sent list out', () => {
    act(() =>
      root.render(
        <CloudCopyConsentDialog
          subject={{ kind: 'skill', name: 'Copy subject' }}
          offerKeepInStep={false}
          replacing={false}
          audience="private"
          analysis={analysis()}
          loading={false}
          analysisError={null}
          selectedOptionalResourceIds={['skill-harbor-ledger']}
          onToggleOptionalResource={noop}
          onRetry={noop}
          onAdd={() => Promise.resolve()}
          onClose={noop}
        />,
      ),
    );
    expectKeptOut(['harbor-ledger-kit/' + SCRIPT], 'Sent');
  });

  it('masks the skill name in the cloud copy title', () => {
    act(() =>
      root.render(
        <CloudCopyConsentDialog
          subject={{ kind: 'skill', name: 'Quayside minutes' }}
          offerKeepInStep={false}
          replacing={false}
          audience="private"
          analysis={null}
          loading
          analysisError={null}
          selectedOptionalResourceIds={[]}
          onToggleOptionalResource={noop}
          onRetry={noop}
          onAdd={() => Promise.resolve()}
          onClose={noop}
        />,
      ),
    );
    expectKeptOut(['Quayside minutes'], 'to your cloud account?');
  });

  it.each([
    ['a share', undefined, 'Left out of this share'],
    [
      'a cloud copy',
      { heading: 'Not sent', helper: 'These stay on this computer.' },
      'Not sent',
    ],
  ])('keeps the withheld files out of %s', (_label, withheldCopy, heading) => {
    act(() =>
      root.render(
        dependencies(
          analysis({
            withheldMemberFiles: [
              {
                rootName: 'harbor-ledger-kit',
                relativePath: 'private/salary-bands.csv',
                reason: 'git_ignored',
              },
            ],
            withheldFiles: [
              {
                pipelineKey: 'pipeline-1',
                assetId: 'deck-assets',
                relativePath: 'drafts/offsite-plan.key',
                reason: 'suspected_secret',
              },
            ],
          }),
          withheldCopy === undefined ? {} : { withheldCopy },
        ),
      ),
    );
    expectKeptOut(['salary-bands', 'offsite-plan'], heading);
    expect(recording()).toContain('Ignored by Git');
  });

  it('keeps a resource row out, with the checkbox still named', () => {
    act(() => root.render(dependencies(analysis())));
    clickButton('Choose files');
    expect(checkboxNames()).toContain(`Include ${RESOURCE_NAME}`);
    expectKeptOut(
      [RESOURCE_NAME, SOURCE_LABEL, 'rename-reorg-files'],
      'Hide files',
    );
  });

  it('keeps a pipeline name out, with the checkbox still named', () => {
    act(() =>
      root.render(
        dependencies(
          analysis({
            packagedPipelines: [
              {
                key: 'pipeline-close',
                resourceId: 'pipeline-close-resource',
                name: 'Quarterly close runbook',
                pipelineContentHash: 'hash',
                source: 'user',
                isActionPipeline: false,
                optional: true,
                promptSpans: [],
              },
            ],
          }),
          { selectedPipelineKeys: [], onTogglePipeline: noop },
        ),
      ),
    );
    expect(checkboxNames()).toContain('Include Quarterly close runbook');
    expectKeptOut(['Quarterly close runbook'], 'Pipelines');
  });

  it('keeps the included-files help lines out', () => {
    act(() =>
      root.render(
        dependencies(analysis(), {
          selectedOptionalResourceIds: ['skill-harbor-ledger'],
        }),
      ),
    );
    clickButton('About included files');
    expectKeptOut(
      [RESOURCE_NAME, 'rename-reorg-files'],
      'About included files',
    );
  });

  it('keeps the kept-private labels out', () => {
    act(() =>
      root.render(
        dependencies(
          analysis({
            unpackageableSelectionLabels: ['client-archive/2024-board-minutes'],
          }),
        ),
      ),
    );
    clickButton('Choose files');
    expectKeptOut(['2024-board-minutes'], 'Kept private when sharing');
  });

  it('keeps the package analysis failure detail out', () => {
    act(() =>
      root.render(
        dependencies(null, {
          errored: true,
          errorReason: "Couldn't read /Users/sam/clients/acme/merger-terms.md",
        }),
      ),
    );
    expectKeptOut(['merger-terms'], 'Try again');
  });

  it('leaves no project pipeline file slug in any recorded attribute', () => {
    // A project pipeline from Q3-layoffs-plan.yaml travels under the key
    // project-q3-layoffs-plan, and its file assets' resource ids carry it.
    const key = 'project-q3-layoffs-plan';
    act(() =>
      root.render(
        dependencies(
          analysis({
            manifest: {
              version: 1,
              pipelineContentHash: 'hash',
              resources: [
                resource(),
                resource({
                  id: `file-asset-${key}-deck`,
                  kind: 'file_asset',
                  displayName: 'Deck template',
                  sourceVisibility: 'local',
                }),
              ],
              bindings: [],
              environmentRequirements: [],
              totalFiles: 4,
              totalBytes: 60,
            },
            packagedPipelines: [
              {
                key,
                resourceId: `automation-pipeline-${key}`,
                name: 'Layoff timeline',
                pipelineContentHash: 'hash',
                source: 'project',
                isActionPipeline: false,
                optional: true,
                promptSpans: [],
              },
            ],
          }),
          { selectedPipelineKeys: [], onTogglePipeline: noop },
        ),
      ),
    );
    clickButton('Choose files');
    expect(document.body.textContent).toContain('Deck template');
    expectNowhereInRecording(['q3-layoffs-plan']);
    expect(recording()).toContain('Pipelines');
  });

  it("keeps a resource's dependency reason out", () => {
    act(() =>
      root.render(
        dependencies(
          analysis({
            manifest: {
              version: 1,
              pipelineContentHash: 'hash',
              resources: [
                resource({
                  id: 'bound',
                  displayName: 'Intake',
                  invocationKeys: ['merger-intake-flow'],
                  dependencyResourceIds: ['dependency'],
                }),
                resource({
                  id: 'dependency',
                  displayName: 'Checklist',
                  invocationKeys: ['diligence-checklist-skill'],
                }),
                resource({ id: 'optional', displayName: 'Extra' }),
              ],
              bindings: [
                { jobId: 'review', stepId: 'intake', resourceIds: ['bound'] },
              ],
              environmentRequirements: [],
              totalFiles: 6,
              totalBytes: 90,
            },
          }),
        ),
      ),
    );
    clickButton('Choose files');
    clickButton('Why is this included?');
    expectKeptOut(
      ['merger-intake-flow', 'diligence-checklist-skill'],
      'Why is this included?',
    );
  });

  const addPipeline = (onAdd: (id: string) => Promise<void>): ReactElement =>
    dependencies(analysis(), {
      pipelineAdd: {
        options: [
          {
            id: '5d0c2f4e-1b7a-4c3e-9f2d-8a6b0e1c7d34',
            key: '5d0c2f4e-1b7a-4c3e-9f2d-8a6b0e1c7d34',
            name: 'Severance review runbook',
          },
          {
            // A project pipeline from Q3-layoffs-plan.yaml, under its key.
            id: 'project-q3-layoffs-plan',
            key: 'project-q3-layoffs-plan',
            name: 'Layoff timeline',
          },
        ],
        onAdd,
      },
    });

  it('keeps the add-pipeline menu options out, with the control still named', async () => {
    const added: string[] = [];
    act(() =>
      root.render(
        addPipeline((id) => {
          added.push(id);
          return Promise.resolve();
        }),
      ),
    );
    clickButton('Add a pipeline');
    expectNowhereInRecording(['q3-layoffs-plan']);
    expectKeptOut(
      ['Severance review runbook', 'Layoff timeline'],
      '"aria-label":"Add a pipeline"',
    );
    // The opaque option value still resolves to the real pipeline id.
    const option = [...document.body.querySelectorAll('[role="option"]')].find(
      (each) => each.textContent?.includes('Layoff timeline'),
    );
    if (!(option instanceof HTMLElement)) throw new Error('No menu option');
    await act(async () => {
      option.click();
      await Promise.resolve();
    });
    expect(added).toEqual(['project-q3-layoffs-plan']);
  });

  it("keeps an add-pipeline failure's message out (green before and after)", async () => {
    act(() =>
      root.render(
        addPipeline(() =>
          Promise.reject(
            new Error(
              "Couldn't read /Users/sam/pipelines/severance-runbook.yaml",
            ),
          ),
        ),
      ),
    );
    clickButton('Add a pipeline');
    const option = document.body.querySelector('[role="option"]');
    if (!(option instanceof HTMLElement)) throw new Error('No menu option');
    await act(async () => {
      option.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expectKeptOut(['severance-runbook'], '"aria-label":"Add a pipeline"');
  });

  const pluginEntry: RemoteControlPluginCatalogUnifiedEntry = {
    id: 'plugin:atlas-board-tools',
    kind: 'plugin',
    origin: 'marketplace',
    state: 'installed',
    name: 'Atlas board tools',
    description: 'Drafts decks from atlas-board-notes',
    source: { id: 'team-marketplace', label: 'Team marketplace' },
    providerSupport: { claude: true, codex: true },
    cloudCapabilities: {
      hasSkills: true,
      hasCommands: false,
      hasAgents: false,
      mcpOnly: false,
      hooksStripped: false,
    },
    lastUpdated: '2026-11-01T00:00:00.000Z',
    memberSummary: {
      skills: 1,
      commands: 0,
      agents: 0,
      hooks: 0,
      mcpServers: 0,
      lspServers: 0,
    },
    memberInventory: {
      skills: [
        {
          name: 'deal-room-summarizer',
          description: 'Summarizes the deal room',
          path: 'skills/deal-room-summarizer',
        },
      ],
      commands: [],
      agents: [],
      hooks: [],
      mcpServers: [],
      lspServers: [],
    },
    selectionRef: {
      type: 'marketplace-plugin',
      marketplaceId: 'team-marketplace',
      pluginName: 'atlas-board-tools',
    },
  };

  const picker = (): ReactElement => (
    <RemoteControlPluginsPicker
      open
      hideTrigger
      catalog={{
        collections: [],
        skills: [],
        plugins: [],
        mcpServers: [],
        entries: [pluginEntry],
      }}
      selections={{ collectionIds: [], skillRefs: [], pluginRefs: [] }}
      brandDisplayName="Canopy"
      onChange={noop}
    />
  );

  it('keeps the skill and plugin picker rows out', () => {
    act(() => root.render(picker()));
    expectKeptOut(
      ['Atlas board tools', 'atlas-board-notes'],
      'Plugins, skills and MCP servers',
    );
  });

  it("keeps a plugin's name and member paths out of its details", () => {
    act(() => root.render(picker()));
    clickButton('View Atlas board tools');
    expectKeptOut(['Atlas board tools', 'deal-room-summarizer'], 'Skills');
  });

  it("keeps a save conflict's error detail out", () => {
    // FileViewer's FileSaveConflictNotice isn't exported, so this renders
    // the Notice with the props it passes: a destructive string detail.
    act(() =>
      root.render(
        <Notice
          errorSource="file-save-conflict-notice"
          intent="destructive"
          title="Not saved"
          detail="Couldn't save your version. EACCES: permission denied, open '/Users/sam/notes/merger-terms-v2.md'"
        >
          This document changed after you started editing.
        </Notice>,
      ),
    );
    expectKeptOut(['merger-terms-v2'], 'Not saved');
  });

  it("keeps a skill update failure's detail out", () => {
    act(() =>
      root.render(
        <SkillUpdateNotice
          action={{
            status: 'ready',
            updateAvailable: true,
            pending: 'none',
            error: {
              kind: 'update-failed',
              detail:
                "Couldn't copy /Users/sam/skills/merger-playbook/SKILL.md",
            },
            onCheck: noop,
            onApply: noop,
          }}
        />,
      ),
    );
    expectKeptOut(['merger-playbook'], 'Try again');
  });

  it("keeps a plugin connection's raw error out, with its toggle recorded", () => {
    act(() =>
      root.render(
        <PluginConnectionNotice error="connect ECONNREFUSED /Users/sam/.config/atlas/session-cache.json" />,
      ),
    );
    clickButton('Technical details');
    expectKeptOut(['session-cache.json'], 'Technical details');
  });
});

describe('Option values stay out of session replay in masked settings menus (CAN-7611)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(async () => {
    record = await loadRecorder();
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  // Desktop project ids are the slug of the repo folder's name: a folder
  // named Q3-layoffs-plan gets the id q3-layoffs-plan.
  const PROJECT_ID = 'q3-layoffs-plan';
  const OTHER_PROJECT_ID = 'harbor-notes';
  const PROJECT_NAME = 'Layoff timeline';
  const OTHER_PROJECT_NAME = 'Harbor notes';
  const noop = (): void => {};

  const sidebarProject = (
    id: string,
    name: string,
    order: number,
  ): SingleRepoSidebarItem => ({
    type: 'single-repo',
    id,
    name,
    repoPath: `/repos/${order}`,
    color: '#3B82F6',
    collapsed: false,
    order,
    worktrees: [],
  });

  const settle = async (): Promise<void> => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  const byTestId = (testId: string): HTMLElement => {
    const element = document.querySelector(`[data-testid="${testId}"]`);
    if (!(element instanceof HTMLElement)) throw new Error(`No ${testId}`);
    return element;
  };

  const click = (element: HTMLElement): void => {
    act(() => element.click());
  };

  const chooseOption = (label: string): void => {
    const option = [...document.querySelectorAll('[role="option"]')].find(
      (each) => each.textContent?.trim() === label,
    );
    if (!(option instanceof HTMLElement)) throw new Error(`No ${label} option`);
    click(option);
  };

  /** Runs `body` with `window.api` set to `api`, then puts the old one back. */
  const withApi = async (
    api: object,
    body: () => Promise<void>,
  ): Promise<void> => {
    const previous: unknown = Reflect.get(window, 'api');
    Reflect.set(window, 'api', api);
    try {
      await body();
    } finally {
      Reflect.set(window, 'api', previous);
      useProjectsStore.setState({ projects: [] });
    }
  };

  it("keeps an MCP server's project picker from recording project ids", async () => {
    const onAdd = jest.fn(async (): Promise<void> => {});
    act(() =>
      root.render(
        <McpWorkspaceDefaultsSection
          workspaces={[
            { id: PROJECT_ID, name: PROJECT_NAME, enabled: false },
            { id: OTHER_PROJECT_ID, name: OTHER_PROJECT_NAME, enabled: false },
          ]}
          onAdd={onAdd}
          onRemove={async (): Promise<void> => {}}
          testId="mcp-defaults"
        />,
      ),
    );
    const trigger = byTestId('mcp-defaults-select');
    expect(trigger.textContent).toContain(PROJECT_NAME);
    // At rest: the first project is chosen and the menu has never opened.
    expectNowhereInRecording([PROJECT_ID, OTHER_PROJECT_ID]);
    expect(recording()).toContain('"aria-label":"Project"');
    click(trigger);
    expectNowhereInRecording([PROJECT_ID, OTHER_PROJECT_ID]);
    chooseOption(OTHER_PROJECT_NAME);
    expectNowhereInRecording([PROJECT_ID, OTHER_PROJECT_ID]);
    click(byTestId('mcp-defaults-add'));
    await settle();
    expect(onAdd).toHaveBeenCalledWith(OTHER_PROJECT_ID);
  });

  it("keeps a project's name out of the MCP server's Remove button", async () => {
    const onRemove = jest.fn(async (): Promise<void> => {});
    act(() =>
      root.render(
        <McpWorkspaceDefaultsSection
          workspaces={[{ id: PROJECT_ID, name: PROJECT_NAME, enabled: true }]}
          onAdd={async (): Promise<void> => {}}
          onRemove={onRemove}
          testId="mcp-defaults"
        />,
      ),
    );
    const remove = byTestId('mcp-defaults-remove');
    // The accessible name, read from the DOM: aria-labelledby's text, else
    // aria-label.
    const ids = remove.getAttribute('aria-labelledby');
    const name =
      ids === null
        ? remove.getAttribute('aria-label')
        : ids
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? '')
            .join(' ');
    expect(name).toBe(`Remove from ${PROJECT_NAME}`);
    expectNowhereInRecording([PROJECT_NAME, PROJECT_ID]);
    expect(recording()).toContain('Remove from');
    click(remove);
    await settle();
    expect(onRemove).toHaveBeenCalledWith(PROJECT_ID);
  });

  it("keeps the approval settings' project picker from recording project ids", async () => {
    const listRules = jest.fn(() =>
      Promise.resolve({ global: [], project: [] }),
    );
    await withApi(
      {
        loadPreferences: () =>
          Promise.resolve({
            approvalDefaults: createDefaultApprovalDefaults(),
          }),
        approvals: { listRules },
      },
      async () => {
        useProjectsStore.setState({
          projects: [
            sidebarProject(PROJECT_ID, PROJECT_NAME, 0),
            sidebarProject(OTHER_PROJECT_ID, OTHER_PROJECT_NAME, 1),
          ],
        });
        // The Settings overlay classifies the page it shows; Approvals is
        // recorded.
        act(() =>
          root.render(
            <SettingsReplayPrivacyContext.Provider
              value={SETTINGS_SECTION_REPLAY_PRIVACY.approvals}
            >
              <ApprovalsTab />
            </SettingsReplayPrivacyContext.Provider>,
          ),
        );
        await settle();
        const trigger = byTestId('approval-project-workspace');
        expect(trigger.textContent).toContain(PROJECT_NAME);
        expect(listRules).toHaveBeenCalledWith({ workspaceId: PROJECT_ID });
        expectNowhereInRecording([PROJECT_ID, OTHER_PROJECT_ID]);
        expect(recording()).toContain('Project rules');
        click(trigger);
        expectNowhereInRecording([PROJECT_ID, OTHER_PROJECT_ID]);
        chooseOption(OTHER_PROJECT_NAME);
        await settle();
        expect(listRules).toHaveBeenCalledWith({
          workspaceId: OTHER_PROJECT_ID,
        });
        expectNowhereInRecording([PROJECT_ID, OTHER_PROJECT_ID]);
      },
    );
  });

  it("keeps a shared copy's existing-project picker from recording project ids", async () => {
    await withApi(
      { getDefaultCloneDirectory: () => Promise.resolve('/clones') },
      async () => {
        useProjectsStore.setState({
          projects: [
            sidebarProject(PROJECT_ID, PROJECT_NAME, 0),
            sidebarProject(OTHER_PROJECT_ID, OTHER_PROJECT_NAME, 1),
          ],
        });
        act(() =>
          root.render(
            <SharedContainerForkModal
              containerId="container-1"
              access="direct"
              revision={{
                status: 'available',
                revisionId: 'revision-1',
                revisionCreatedAt: '2026-11-20T00:00:00.000Z',
              }}
              containerType="CODE_WORKTREE"
              title="Shared notes"
              onClose={noop}
            />,
          ),
        );
        await settle();
        click(byTestId('shared-container-fork-destination-existing'));
        const trigger = byTestId('shared-container-fork-workspace');
        click(trigger);
        expectNowhereInRecording([PROJECT_ID, OTHER_PROJECT_ID]);
        chooseOption(PROJECT_NAME);
        expect(trigger.textContent).toContain(PROJECT_NAME);
        expectNowhereInRecording([PROJECT_ID, OTHER_PROJECT_ID]);
        expect(recording()).toContain('Shared notes');
      },
    );
  });

  it("keeps a blocked menu's chosen value off its trigger at rest", () => {
    const path = 'reports/Q3-layoffs-plan.md';
    act(() =>
      root.render(
        <SettingsSelect
          aria-label="Report"
          data-testid="report-select"
          value={path}
          onValueChange={noop}
          options={[
            { value: 'reports/harbor.md', label: 'Harbor' },
            { value: path, label: 'Layoff plan' },
          ]}
          replayPrivacy={{ blockClassName: 'ph-no-capture' }}
        />,
      ),
    );
    expect(byTestId('report-select').getAttribute('data-value')).toBe('1');
    expectNowhereInRecording([path, 'reports/harbor.md']);
    expect(recording()).toContain('"aria-label":"Report"');
  });

  it('keeps raw option values on a menu without replay privacy', () => {
    act(() =>
      root.render(
        <SettingsSelect
          aria-label="Model"
          data-testid="model-select"
          value="model-b"
          onValueChange={noop}
          options={[
            { value: 'model-a', label: 'Model A' },
            { value: 'model-b', label: 'Model B' },
          ]}
        />,
      ),
    );
    const trigger = byTestId('model-select');
    expect(trigger.getAttribute('data-value')).toBe('model-b');
    click(trigger);
    expect(
      [...document.querySelectorAll('[role="option"]')].map((option) =>
        option.getAttribute('data-value'),
      ),
    ).toEqual(['model-a', 'model-b']);
  });

  it('passes the real value when a masked menu option is chosen', () => {
    const onValueChange = jest.fn();
    act(() =>
      root.render(
        <SettingsSelect
          aria-label="Project"
          data-testid="masked-select"
          value={null}
          placeholder="Choose a project"
          onValueChange={onValueChange}
          options={[
            { value: PROJECT_ID, label: PROJECT_NAME },
            { value: OTHER_PROJECT_ID, label: OTHER_PROJECT_NAME },
          ]}
          replayPrivacy={{ maskClassName: 'ph-mask' }}
        />,
      ),
    );
    click(byTestId('masked-select'));
    chooseOption(OTHER_PROJECT_NAME);
    expect(onValueChange).toHaveBeenCalledWith(OTHER_PROJECT_ID);
  });
});

describe('Filter values and team names stay out of session replay in search filters and team pickers (CAN-7613)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(async () => {
    record = await loadRecorder();
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useWorkflowsViewStore.getState().setScheduleProject(null);
  });

  // Desktop project ids are the slug of the repo folder's name.
  const PROJECT_ID = 'q3-layoffs-plan';
  const PROJECT_NAME = 'Layoff timeline';
  const MEMBER_ID = 'member-ada-lovelace';
  const MEMBER_NAME = 'Ada Lovelace';
  const TEAM_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const TEAM_NAME = 'Layoffs taskforce';
  const noop = (): void => {};

  const byTestId = (testId: string): HTMLElement => {
    const element = document.querySelector(`[data-testid="${testId}"]`);
    if (!(element instanceof HTMLElement)) throw new Error(`No ${testId}`);
    return element;
  };

  const click = (element: HTMLElement): void => {
    act(() => element.click());
  };

  const chooseRow = (role: string, label: string): void => {
    const row = [...document.querySelectorAll(`[role="${role}"]`)].find(
      (each) => each.textContent?.trim().startsWith(label) === true,
    );
    if (!(row instanceof HTMLElement)) throw new Error(`No ${label} row`);
    click(row);
  };

  const project: SingleRepoSidebarItem = {
    type: 'single-repo',
    id: PROJECT_ID,
    name: PROJECT_NAME,
    repoPath: '/repos/0',
    color: '#3B82F6',
    collapsed: false,
    order: 0,
    worktrees: [],
  };

  const scheduleScope: AutomationScope = {
    context: undefined,
    inContext: () => true,
    watcherInContext: () => true,
    shareInContext: () => true,
    contextLabel: null,
    runsInLabel: () => null,
    ownerLabel: () => 'Personal',
    labelForWorkspace: () => 'Personal',
    memberOfWorkspace: () => true,
    projectsInContext: [project],
  };

  const libraryToolbar = (
    onFiltersChange: (filters: WorkflowLibraryFilters) => void,
  ): JSX.Element => (
    <WorkflowsLibraryToolbar
      filters={EMPTY_WORKFLOW_LIBRARY_FILTERS}
      onFiltersChange={onFiltersChange}
      sort="recently-run"
      onSortChange={noop}
      counts={countLibraryFacets([])}
      triggers={[]}
      projects={[{ id: PROJECT_ID, name: PROJECT_NAME }]}
      total={1}
      matched={1}
    />
  );

  const openLibraryFacet = (facet: string): void => {
    click(byTestId('workflows-library-filter'));
    click(byTestId(`workflows-library-filter-${facet}`));
  };

  it("keeps the Workflows Library project filter from recording a project's id or name", () => {
    const onFiltersChange = jest.fn();
    act(() => root.render(libraryToolbar(onFiltersChange)));
    openLibraryFacet('project');
    expectNowhereInRecording([PROJECT_ID, PROJECT_NAME]);
    expect(recording()).toContain('Any project');
    chooseRow('menuitemradio', PROJECT_NAME);
    expect(onFiltersChange).toHaveBeenCalledWith({
      ...EMPTY_WORKFLOW_LIBRARY_FILTERS,
      project: PROJECT_ID,
    });
  });

  it("keeps the Workflows Schedule project filter from recording a project's id or name", () => {
    act(() =>
      root.render(
        <WorkflowsScheduleTab
          activities={[]}
          recentRuns={[]}
          scope={scheduleScope}
          describeAction={(): string => ''}
          onEdit={noop}
          onOpenRun={noop}
        />,
      ),
    );
    const trigger = byTestId('workflows-schedule-project');
    click(trigger);
    expectNowhereInRecording([PROJECT_ID, PROJECT_NAME]);
    chooseRow('menuitemradio', PROJECT_NAME);
    expect(useWorkflowsViewStore.getState().scheduleProject).toBe(PROJECT_ID);
    expect(trigger.textContent).toContain(PROJECT_NAME);
    expect(trigger.getAttribute('aria-label')).toBe('Project');
    expectNowhereInRecording([PROJECT_ID, PROJECT_NAME]);
  });

  const memberFilter = (
    selected: readonly string[],
    blockClassName: string,
  ): JSX.Element => (
    <FilterDropdown<string>
      title="Member"
      label={selected.length > 0 ? MEMBER_NAME : 'All members'}
      anyLabel="All members"
      options={[{ value: MEMBER_ID, label: MEMBER_NAME }]}
      selected={selected}
      onToggle={noop}
      onClear={noop}
      testId="team-feed-member-filter"
      replayPrivacy={{ blockClassName }}
    />
  );

  it("keeps a blocked filter's option values out of its test ids", () => {
    act(() => root.render(memberFilter([], REPLAY_BLOCK_CLASS)));
    click(byTestId('team-feed-member-filter'));
    expectNowhereInRecording([MEMBER_ID, MEMBER_NAME]);
    act(() => root.render(memberFilter([MEMBER_ID], REPLAY_BLOCK_CLASS)));
    expectNowhereInRecording([MEMBER_ID, MEMBER_NAME]);
    expect(
      byTestId('team-feed-member-filter-option-0').getAttribute('aria-checked'),
    ).toBe('true');
  });

  const SETTINGS_CLIENT: AccountOrganizationSettingsClient = {
    read: () => Promise.reject(new Error('Not read in this test')),
    write: () => Promise.reject(new Error('Not written in this test')),
    subscribe: () => noop,
  };

  function DesktopSettingsHost({
    children,
  }: {
    readonly children: ReactNode;
  }): JSX.Element {
    const host = useDesktopStandaloneSettingsHost(SETTINGS_CLIENT);
    return <SettingsHostProvider host={host}>{children}</SettingsHostProvider>;
  }

  const organization: OrganizationDetail = {
    id: 'org-1',
    name: 'Harbor',
    viewerRole: 'OWNER',
    members: [
      {
        id: 'user-1',
        name: MEMBER_NAME,
        email: 'ada@example.test',
        image: null,
        role: 'MEMBER',
        subTeamIds: [],
      },
    ],
    subTeams: [{ id: TEAM_ID, name: TEAM_NAME, memberCount: 1 }],
    usageStatsMinRole: 'ADMIN',
    canViewUsageStats: true,
    logoUrl: null,
    githubConnection: { connected: false, accountLogin: null },
  };

  it("keeps team names out of the project grants editor's Add team picker", () => {
    const setGrants = jest.fn<void, [SetStateAction<OrgProjectGrant[]>]>();
    act(() =>
      root.render(
        <DesktopSettingsHost>
          <TeamProjectsGrantsEditor
            detail={organization}
            grants={[]}
            setGrants={setGrants}
            disabled={false}
            growthDisabled={false}
          />
        </DesktopSettingsHost>,
      ),
    );
    const trigger = [...document.querySelectorAll('[role="combobox"]')].find(
      (each) => each.getAttribute('aria-label') === 'Add team',
    );
    if (!(trigger instanceof HTMLElement)) throw new Error('No Add team');
    click(trigger);
    expectNowhereInRecording([TEAM_NAME, TEAM_ID]);
    expect(recording()).toContain('"aria-label":"Add team"');
    chooseRow('option', TEAM_NAME);
    const update = setGrants.mock.calls[0]?.[0];
    expect(typeof update === 'function' ? update([]) : update).toEqual([
      { principal: { type: 'team', teamId: TEAM_ID }, defaultListed: false },
    ]);
  });

  it('keeps raw option test ids on filters of fixed values', () => {
    act(() => root.render(libraryToolbar(noop)));
    openLibraryFacet('status');
    expect(
      byTestId('workflows-library-filter-status-option-attention').textContent,
    ).toContain('Needs attention');
    expect(byTestId('workflows-library-filter-status-any')).toBeTruthy();
  });

  it('keeps sort option test ids as they were', () => {
    act(() =>
      root.render(
        <SortDropdown<'recent' | 'name'>
          value="recent"
          options={[
            { value: 'recent', label: 'Recently run' },
            { value: 'name', label: 'Name' },
          ]}
          onChange={noop}
          testId="lab-sort"
        />,
      ),
    );
    click(byTestId('lab-sort'));
    expect(byTestId('lab-sort-option-name').textContent).toContain('Name');
  });

  it('keeps raw option test ids where the host supplies no replay classes, as on web', () => {
    act(() => root.render(memberFilter([], '')));
    click(byTestId('team-feed-member-filter'));
    expect(
      byTestId(`team-feed-member-filter-option-${MEMBER_ID}`).textContent,
    ).toContain(MEMBER_NAME);
  });
});

describe("A copy's warnings show in the fork dialog, out of session replay (CAN-7585)", () => {
  let container: HTMLDivElement;
  let root: Root;
  type AddToast = ReturnType<typeof useGitHubStore.getState>['addToast'];
  let addToast: jest.Mock<ReturnType<AddToast>, Parameters<AddToast>>;
  let previousAddToast: AddToast;
  type LoadProjects = ReturnType<
    typeof useProjectsStore.getState
  >['loadProjects'];
  let loadProjects: jest.Mock<
    ReturnType<LoadProjects>,
    Parameters<LoadProjects>
  >;
  let previousLoadProjects: LoadProjects;
  let previousApi: unknown;

  beforeAll(async () => {
    record = await loadRecorder();
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    previousAddToast = useGitHubStore.getState().addToast;
    previousApi = Reflect.get(window, 'api');
    addToast = jest.fn<ReturnType<AddToast>, Parameters<AddToast>>();
    useGitHubStore.setState({ addToast });
    previousLoadProjects = useProjectsStore.getState().loadProjects;
    loadProjects = jest.fn<ReturnType<LoadProjects>, Parameters<LoadProjects>>(
      () => Promise.resolve(),
    );
    useProjectsStore.setState({ loadProjects });
    mockOpenForkedContainer.mockReset();
    mockOpenForkedContainer.mockResolvedValue({ switchedTo: null });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useGitHubStore.setState({ addToast: previousAddToast });
    useProjectsStore.setState({ loadProjects: previousLoadProjects });
    Reflect.set(window, 'api', previousApi);
  });

  const AGENT = 'Harbor helper';
  const PIPELINE = 'Ledger sync';
  const FIELD = 'agent.instructions';
  const WARNINGS = [
    `Agent "${AGENT}" wasn't added because its ${FIELD} may contain a credential. Ask the person who shared it to remove the credential and share again.`,
    `Pipeline "${PIPELINE}" wasn't added because a pipeline or action it runs uses an Agent that copies can't include yet.`,
  ];
  const GENERIC_NOTE = 'could not bring everything across';

  const forkResponse = (
    warnings: readonly string[],
  ): SharedContainerForkResponse => ({
    containerType: 'CODE_WORKTREE',
    projectId: 'copy-project',
    worktreeId: 'copy-worktree',
    warnings: [...warnings],
    provenance: {
      sourceContainerId: 'container-1',
      sourceRevisionId: 'revision-1',
      sourceOwnerDisplayName: 'a teammate',
      forkedAt: '2026-11-22T00:00:00.000Z',
    },
  });

  const settle = async (): Promise<void> => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  const byTestId = (testId: string): HTMLElement => {
    const element = document.querySelector(`[data-testid="${testId}"]`);
    if (!(element instanceof HTMLElement)) throw new Error(`No ${testId}`);
    return element;
  };

  const click = (element: HTMLElement): void => {
    act(() => element.click());
  };

  /** Every attribute value on every element now in the page. */
  const domAttributeValues = (): string[] =>
    [...document.body.querySelectorAll('*')].flatMap((element) =>
      [...element.attributes].map((attribute) => attribute.value),
    );

  const expectInNoAttribute = (values: readonly string[]): void => {
    const attributes = domAttributeValues().map((each) => each.toLowerCase());
    expect(attributes.length).toBeGreaterThan(0);
    for (const value of values)
      expect(
        attributes.filter((each) => each.includes(value.toLowerCase())),
      ).toEqual([]);
  };

  /**
   * Opens the dialog on a readable revision, makes a new copy, and waits for
   * main's answer. Returns the dialog's `onClose`.
   */
  const makeCopy = async (warnings: readonly string[]): Promise<jest.Mock> => {
    const onClose = jest.fn();
    Reflect.set(window, 'api', {
      getDefaultCloneDirectory: () => Promise.resolve('/clones'),
      sharedContainers: {
        getReplicaState: () =>
          Promise.resolve({
            containerId: 'container-1',
            status: 'available',
            revisionId: 'revision-1',
            revision: 1,
            revisionCreatedAt: '2026-11-20T00:00:00.000Z',
          }),
        onReplicaChanged: () => (): void => {},
        fork: () => Promise.resolve(forkResponse(warnings)),
      },
    });
    act(() =>
      root.render(
        <SharedContainerForkModal
          containerId="container-1"
          access="direct"
          revision={{
            status: 'available',
            revisionId: 'revision-1',
            revisionCreatedAt: '2026-11-20T00:00:00.000Z',
          }}
          containerType="CODE_WORKTREE"
          title="Shared notes"
          onClose={onClose}
        />,
      ),
    );
    await settle();
    click(byTestId('shared-container-fork-continue'));
    click(byTestId('shared-container-fork-confirm'));
    await settle();
    await settle();
    return onClose;
  };

  /** The one toast raised, read as its message, type and meta. */
  const onlyToast = (): Parameters<AddToast> => {
    expect(addToast).toHaveBeenCalledTimes(1);
    return addToast.mock.calls[0];
  };

  const resultWarnings = (): string[] =>
    [...byTestId('shared-container-fork-result').querySelectorAll('li')].map(
      (item) => item.textContent ?? '',
    );

  it('stays open after a copy with warnings and lists every warning', async () => {
    const onClose = await makeCopy(WARNINGS);
    expect(resultWarnings()).toEqual(WARNINGS);
    expect(onClose).not.toHaveBeenCalled();
    expect(mockOpenForkedContainer).not.toHaveBeenCalled();
    expect(addToast).not.toHaveBeenCalled();
  });

  it('keeps every warning out of all attributes and the recording, with its controls recorded', async () => {
    await makeCopy(WARNINGS);
    const shown = [AGENT, PIPELINE, FIELD];
    for (const value of shown)
      expect(document.body.textContent).toContain(value);
    expectInNoAttribute([...shown, ...WARNINGS]);
    expectNowhereInRecording([...shown, ...WARNINGS]);
    const recorded = recording();
    expect(recorded).toContain('Open copy');
    expect(recorded).toContain('Done');
  });

  it('Open copy opens the copy once and raises a plain success toast', async () => {
    const onClose = await makeCopy(WARNINGS);
    click(byTestId('shared-container-fork-result-open'));
    await settle();
    expect(mockOpenForkedContainer).toHaveBeenCalledTimes(1);
    expect(mockOpenForkedContainer).toHaveBeenCalledWith(
      forkResponse(WARNINGS),
    );
    const [message, type, , meta] = onlyToast();
    expect(message).toBe('Copy made.');
    expect(type).toBe('success');
    expect(meta?.action?.label).toBe('Open copy');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /**
   * Done leaves the copy where it is, but the sidebar still has to list it:
   * main made it after the renderer's last projects read.
   */
  const expectClosedLikeDone = (onClose: jest.Mock): void => {
    expect(mockOpenForkedContainer).not.toHaveBeenCalled();
    expect(loadProjects).toHaveBeenCalledTimes(1);
    expect(loadProjects).toHaveBeenCalledWith({ silent: true });
    expect(onClose).toHaveBeenCalledTimes(1);
    const [message, type] = onlyToast();
    expect(message).toBe('Copy made.');
    expect(type).toBe('success');
  };

  it('Done closes without opening and leaves Open copy on a plain success toast', async () => {
    const onClose = await makeCopy(WARNINGS);
    click(byTestId('shared-container-fork-result-done'));
    await settle();
    expectClosedLikeDone(onClose);
    const [message, type, , meta] = onlyToast();
    expect(message).toBe('Copy made.');
    expect(type).toBe('success');
    expect(meta?.action?.label).toBe('Open copy');
    act(() => {
      void meta?.action?.onClick();
    });
    await settle();
    expect(mockOpenForkedContainer).toHaveBeenCalledTimes(1);
  });

  it('Escape on the result step closes like Done', async () => {
    const onClose = await makeCopy(WARNINGS);
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    await settle();
    expectClosedLikeDone(onClose);
  });

  it('a backdrop click on the result step closes like Done', async () => {
    const onClose = await makeCopy(WARNINGS);
    const backdrop = document.querySelector(
      '[data-canopy-overlay-root="modal"]',
    );
    if (!(backdrop instanceof HTMLElement)) throw new Error('No backdrop');
    act(() => {
      backdrop.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    expectClosedLikeDone(onClose);
  });

  it('opens a copy without warnings at once, as before (green before and after)', async () => {
    const onClose = await makeCopy([]);
    expect(
      document.querySelector('[data-testid="shared-container-fork-result"]'),
    ).toBeNull();
    expect(mockOpenForkedContainer).toHaveBeenCalledTimes(1);
    const [message, type] = onlyToast();
    expect(message).toBe('Copy made.');
    expect(type).toBe('success');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('raises a plain open-failed toast once the warnings were shown', async () => {
    const failure = new Error('copy is gone');
    mockOpenForkedContainer.mockRejectedValue(failure);
    const onClose = await makeCopy(WARNINGS);
    click(byTestId('shared-container-fork-result-open'));
    await settle();
    const [message, type, , meta] = onlyToast();
    expect(message).toBe("Copy made, but it couldn't be opened.");
    expect(message).not.toContain(GENERIC_NOTE);
    expect(type).toBe('error');
    expect(meta?.caught).toBe(failure);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('the shared result view alone keeps the warnings out of every attribute and the recording', () => {
    const noop = (): void => {};
    act(() =>
      root.render(
        <SharedContainerForkResult
          warnings={WARNINGS}
          onOpenCopy={noop}
          onDone={noop}
        />,
      ),
    );
    const shown = [AGENT, PIPELINE, FIELD];
    for (const value of shown)
      expect(document.body.textContent).toContain(value);
    expectInNoAttribute([...shown, ...WARNINGS]);
    expectNowhereInRecording([...shown, ...WARNINGS]);
    expect(recording()).toContain('Open copy');
  });

  it('the shared result view imports nothing from a desktop host', () => {
    const packageSource = path.resolve(
      __dirname,
      '../../../../../../../packages/ui-shared/src',
    );
    const file = path.join(
      packageSource,
      'sharing/SharedContainerForkResult.tsx',
    );
    const specifiers = [
      ...readFileSync(file, 'utf8').matchAll(/\bfrom\s+'([^']+)'/g),
    ].map((match) => match[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    // Only React and modules inside @canopy/ui-shared itself.
    expect(
      specifiers.filter((specifier) =>
        specifier.startsWith('.')
          ? !path
              .resolve(path.dirname(file), specifier)
              .startsWith(`${packageSource}${path.sep}`)
          : specifier !== 'react',
      ),
    ).toEqual([]);
  });
});
