/** @jest-environment jsdom */
import { act, type ReactElement } from 'react';
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
            onConfirm={noop}
            onCancel={noop}
          />
        ),
        false,
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
