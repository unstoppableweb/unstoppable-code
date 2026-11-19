// CAN-4174 capture golden: what an App Advisor automation run does with the
// App Advisor window today, pinned on unchanged code before CAN-4174 makes
// the window a reaction to the run instead of a step of it. The real
// automations service runs a native `app_advisor_prompt` from a temporary
// automations file, started as `automations:run-now` starts it, through
// the service's runNow. Only the shared bot port that creates the Work Entry and
// chat and accepts the message is replaced at its boundary, together with
// the App Advisor Work Entry list, so the order of the window calls and the
// send can be read from one event log.
//
// CAN-4174 PR 4 made the window a reaction to the accepted send
// (app-advisor/initiated-presentation.ts, pinned by its own goldens), so the
// service itself now opens no window: none before the send, none after it,
// and a refused send leaves the window alone. Everything else here is
// unchanged from the capture.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AutomationAction,
  ScheduledActivity,
  ScheduledActivityRun,
} from '@canopy/desktop-shared/types';
import type * as WorkEntries from '../../lib/cowork-work-entries';
import type * as Paths from '../../lib/paths';
import type * as ResourceContext from '../../lib/resource-context';
import type * as AutomationSend from '../automation-send';
import type { AutomationsService } from '../service';

let mockDirectory = '';
const mockEvents: string[] = [];
const mockSends: { action: unknown; options: Record<string, unknown> }[] = [];
const mockPort: { refuse?: Error; workEntryIds: string[] } = {
  workEntryIds: [],
};
const mockWindow: { selectionFails: boolean } = { selectionFails: false };

jest.mock('../../lib/paths', () => ({
  ...jest.requireActual<typeof Paths>('../../lib/paths'),
  getAutomationsFilePath: (): string => join(mockDirectory, 'automations.json'),
  getDataDir: (): string => mockDirectory,
}));
jest.mock('../../lib/resource-context', () => ({
  ...jest.requireActual<typeof ResourceContext>('../../lib/resource-context'),
  resourceContextEnabled: (): boolean => false,
}));
jest.mock('../../lib/cowork-work-entries', () => ({
  ...jest.requireActual<typeof WorkEntries>('../../lib/cowork-work-entries'),
  listWorkEntryIds: (): Promise<string[]> =>
    Promise.resolve([...mockPort.workEntryIds]),
}));
jest.mock('../automation-send', () => ({
  ...jest.requireActual<typeof AutomationSend>('../automation-send'),
  dispatchAutomationCreation: (
    action: { type: string; taskId?: string },
    _caller: unknown,
    options: Record<string, unknown>,
  ): Promise<unknown> => {
    mockEvents.push(`send:${action.type}`);
    mockSends.push({ action, options });
    if (mockPort.refuse) return Promise.reject(mockPort.refuse);
    const taskId = action.taskId ?? 'task-new';
    const address = { botId: 'app_advisor', taskId, chatId: 'chat-new' };
    return Promise.resolve({
      address,
      taskCreated: action.taskId === undefined,
      chatCreated: true,
      input: {
        address,
        acceptedAt: new Date().toISOString(),
        watcherReceipts: [],
        disposition: 'started',
        messageId: 'message-accepted',
      },
    });
  },
}));
jest.setTimeout(30_000);

const NOW = '2026-11-16T12:00:00.000Z';
const ID = 'advisor-automation';

type AdvisorAction = Extract<AutomationAction, { type: 'app_advisor_prompt' }>;

function advisorActivity(
  overrides: Partial<AdvisorAction> = {},
): ScheduledActivity {
  return {
    version: 1,
    id: ID,
    name: 'Morning summary',
    enabled: false,
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    action: {
      type: 'app_advisor_prompt',
      prompt: 'Summarize my day',
      ...overrides,
    },
    createdAt: NOW,
    updatedAt: NOW,
    failureCount: 0,
  };
}

async function seed(activity: ScheduledActivity): Promise<void> {
  await writeFile(
    join(mockDirectory, 'automations.json'),
    JSON.stringify({
      version: 1,
      updatedAt: NOW,
      activities: [activity],
      recentRuns: [],
    }),
  );
}

let service: AutomationsService;

function configure(): void {
  service.configure({
    getMainWindow: () => null,
    getAppAdvisorWindow: () => null,
    openAppAdvisorWindow: (request) => {
      mockEvents.push(`open:${request?.chatId ?? ''}`);
      return Promise.resolve({ open: true, focused: true });
    },
    ensureAppAdvisorWindow: (request) => {
      mockEvents.push(`window:${request?.chatId ?? 'any'}`);
      if (request?.chatId !== undefined && mockWindow.selectionFails)
        return Promise.reject(new Error('no display'));
      return Promise.resolve({ open: true, focused: true });
    },
    sendAppAdvisorWindowCommand: (command) => {
      mockEvents.push(`command:${command.type}`);
    },
  });
}

/** Run the automation now and return its run once it has ended. */
async function runToEnd(): Promise<ScheduledActivityRun> {
  const started = await service.runNow({ id: ID });
  if (!started.ok) throw new Error(`Run now refused: ${started.error}`);
  const deadline = Date.now() + 20_000;
  for (;;) {
    const history = await service.listRuns({ activityId: ID });
    const run = 'runs' in history ? history.runs[0] : undefined;
    if (run && run.status !== 'running') return run;
    if (Date.now() > deadline) throw new Error('The run did not finish');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeEach(async () => {
  jest.resetModules();
  mockEvents.length = 0;
  mockSends.length = 0;
  delete mockPort.refuse;
  mockPort.workEntryIds = [];
  mockWindow.selectionFails = false;
  mockDirectory = await mkdtemp(join(tmpdir(), 'advisor-automation-golden-'));
  const { AutomationsService: Service } = await import('../service');
  service = new Service();
});

afterEach(async () => {
  await rm(mockDirectory, { recursive: true, force: true });
});

describe('App Advisor automation runs and the App Advisor window (CAN-4174 capture)', () => {
  it('creates a Work Entry and chat and succeeds on acceptance, opening no window itself', async () => {
    await seed(advisorActivity());
    configure();

    const run = await runToEnd();

    expect(mockEvents).toEqual(['send:bots.create_task']);
    expect(run).toMatchObject({
      status: 'success',
      result: {
        appAdvisorChatId: 'chat-new',
        userMessageId: 'message-accepted',
      },
      target: { chatId: 'chat-new' },
    });
    expect(mockSends[0]).toMatchObject({
      action: {
        type: 'bots.create_task',
        botId: 'app_advisor',
        title: 'Morning summary',
        initialMessage: 'Summarize my day',
      },
      options: {
        actionType: 'app_advisor_prompt',
        automationDispatch: {
          automationName: 'Morning summary',
          presentation: 'foreground',
        },
      },
    });
  });

  it('opens a new chat in an existing Work Entry the same way', async () => {
    mockPort.workEntryIds = ['entry-existing'];
    await seed(advisorActivity({ workEntryId: 'entry-existing' }));
    configure();

    const run = await runToEnd();

    expect(mockEvents).toEqual(['send:bots.create_task_chat']);
    expect(mockSends[0]).toMatchObject({
      action: {
        type: 'bots.create_task_chat',
        botId: 'app_advisor',
        taskId: 'entry-existing',
        initialMessage: 'Summarize my day',
      },
    });
    expect(run).toMatchObject({
      status: 'success',
      result: { appAdvisorChatId: 'chat-new' },
    });
  });

  it('refuses a Work Entry that is gone before the window or the send', async () => {
    await seed(advisorActivity({ workEntryId: 'entry-gone' }));
    configure();

    const run = await runToEnd();

    expect(mockEvents).toEqual([]);
    expect(run).toMatchObject({ status: 'failure' });
    expect(run.error).toContain('entry-gone');
  });

  it('fails the run when the message is not accepted, exactly as before, and opens no window', async () => {
    mockPort.refuse = new Error('The Orchestrator refused this message.');
    await seed(advisorActivity());
    configure();

    const run = await runToEnd();

    expect(mockEvents).toEqual(['send:bots.create_task']);
    expect(run).toMatchObject({ status: 'failure' });
    expect(run.result?.appAdvisorChatId).toBeUndefined();
    // The run record a refusal leaves, which CAN-4174 PR 4 must not change.
    expect({
      status: run.status,
      error: run.error,
      result: run.result,
      target: run.target,
    }).toEqual({
      status: 'failure',
      error: 'The Orchestrator refused this message.',
      result: undefined,
      target: undefined,
    });
  });

  it('keeps an accepted run successful whatever the window does, since the service no longer shows the chat', async () => {
    mockWindow.selectionFails = true;
    await seed(advisorActivity());
    configure();

    const run = await runToEnd();

    expect(mockEvents).toEqual(['send:bots.create_task']);
    expect(run).toMatchObject({
      status: 'success',
      result: { appAdvisorChatId: 'chat-new' },
    });
  });

  it('fails the run before any send when the service has no window surfaces', async () => {
    await seed(advisorActivity());

    const run = await runToEnd();

    expect(mockSends).toEqual([]);
    expect(run).toMatchObject({ status: 'failure' });
    expect(run.error).toContain('not configured');
  });
});
