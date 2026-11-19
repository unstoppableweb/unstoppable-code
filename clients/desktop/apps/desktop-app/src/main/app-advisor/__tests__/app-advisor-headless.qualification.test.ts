import type * as AppAdvisorIpcModule from '../../ipc/app-advisor';

jest.mock('../../ipc/app-advisor', () => ({
  ...jest.requireActual<typeof AppAdvisorIpcModule>('../../ipc/app-advisor'),
  routeRendererToolRequest: jest.fn(() => null),
  requestAppAdvisorRendererTool: jest.fn(),
}));
const mockWarn = jest.fn();
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: (...args: unknown[]): void => {
    mockWarn(...args);
  },
  logMainProcessError: jest.fn(),
  logMainProcessDebug: jest.fn(),
  logMainProcessInfo: jest.fn(),
}));
jest.mock('../../feature-flags', () => ({
  getFeatureFlagService: (): object => ({
    getSnapshot: (): object => ({ values: {} }),
    isEnabled: (): boolean => false,
  }),
}));
jest.mock('../../agents/session-manager', () => ({
  getActiveSessionCapabilityProfile: (): undefined => undefined,
}));

import type * as WorkEntriesModule from '../../lib/cowork-work-entries';

const mockRecordDiagnostic = jest.fn();
jest.mock('../../observability/ingest', () => ({
  getExecutionObservabilityIngest: (): object => ({
    recordSessionDiagnostic: (diagnostic: unknown): void => {
      mockRecordDiagnostic(diagnostic);
    },
  }),
}));
jest.mock('../../lib/cowork-work-entries', () => ({
  ...jest.requireActual<typeof WorkEntriesModule>(
    '../../lib/cowork-work-entries',
  ),
  resolveWorkEntryForChat: (): Promise<{ entryId: string }> =>
    Promise.resolve({ entryId: 'entry-1' }),
}));

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AdvisorActionRuns } from '@canopy/core-runtime/node/agent/advisor';
import { OperationService } from '@canopy/core-runtime/node/operations';
import { OperationLedger } from '@canopy/core-runtime/node/operations/ledger';
import { appAdvisorActionDisposition } from '@canopy/desktop-shared/lib/app-advisor-action-dispositions';
import { APP_ADVISOR_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/app-advisor-tools';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import type { InterfaceToolName } from '@canopy/protocol/canopy-core';
import { requestAppAdvisorRendererTool } from '../../ipc/app-advisor';
import { buildCodexSessionDynamicToolSpecs } from '../../codex/session-dynamic-tools';
import { getCanopyRouteTools } from '../../mcp/canopy-route-tools';
import type { CanopyWorktreeSessionRoute } from '../../mcp/canopy-tool-router';
import {
  APP_ADVISOR_ACTION_TEXTS,
  routeAppAdvisorAction,
} from '../action-router';
import { requestAppAdvisorPresentation } from '../advisor-presentation';
import { dispatchActionSchema } from '../definitions';
import {
  createAppAdvisorToolRuntime,
  type AppAdvisorToolRuntimeSurfaces,
} from '../runtime';
import { emitAppAdvisorSyntheticResultEvent } from '../chat-service';
import { APP_ADVISOR_SYSTEM_PROMPT } from '../system-prompt';
import { executeAppAdvisorTool } from '../tool-executor';

const windowRequest = jest.mocked(requestAppAdvisorRendererTool);
const destination = {
  projectId: APP_ADVISOR_PROJECT_ID,
  worktreeId: APP_ADVISOR_WORKTREE_ID,
  chatId: 'advisor-chat',
};
const NO_WINDOW_LINE =
  '- When no window is connected to this session, SearchActions lists only actions that work without one, and an action that needs the window answers that it is not open. Sending messages, creating tasks and chats, and managing pipelines, skills and automations still work.';

function surfaces(): AppAdvisorToolRuntimeSurfaces & {
  getMainWindow: jest.Mock;
  openAppAdvisorWindow: jest.Mock;
  ensureAppAdvisorWindow: jest.Mock;
} {
  return {
    getMainWindow: jest.fn((): null => null),
    getAppAdvisorWindow: jest.fn((): null => null),
    openAppAdvisorWindow: jest.fn(() =>
      Promise.resolve({ open: true, focused: true }),
    ),
    ensureAppAdvisorWindow: jest.fn(() =>
      Promise.resolve({ open: true, focused: true }),
    ),
  };
}

const advisorRoute = (
  interfaceTools: readonly InterfaceToolName[],
): CanopyWorktreeSessionRoute => ({
  sessionKey: 'k',
  projectId: APP_ADVISOR_PROJECT_ID,
  worktreeId: 'w',
  chatId: 'c',
  sdkSessionId: 's',
  authToken: 't',
  createdAt: 0,
  hookHandler: () => undefined,
  assistantMode: 'app-advisor',
  providerType: 'claude',
  interfaceTools,
});

let root: string;
let operations: OperationService;
let runs: AdvisorActionRuns;

async function recordedOperations(): Promise<number> {
  const { items } = await operations.list({
    kinds: ['core.appAdvisor.action.run'],
    limit: 10,
  });
  return items.length;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'can-4133-'));
  const ledgerPath = join(root, 'ledger.sqlite');
  operations = new OperationService({
    openLedger: (): OperationLedger => OperationLedger.open(ledgerPath),
  });
  runs = new AdvisorActionRuns({ operations });
  mockWarn.mockClear();
  windowRequest.mockReset();
});
afterEach(() => {
  operations.close();
  rmSync(root, { recursive: true, force: true });
});

describe('App Advisor turns with no window (CAN-4133)', () => {
  it('the send paths never await the App Advisor window', async () => {
    const pendingWindow = {
      ensureAppAdvisorWindow: jest.fn(
        () => new Promise<{ open: boolean; focused: boolean }>(() => undefined),
      ),
    };
    expect(
      requestAppAdvisorPresentation(pendingWindow, 'user_send'),
    ).toBeUndefined();
    expect(pendingWindow.ensureAppAdvisorWindow).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(pendingWindow.ensureAppAdvisorWindow).toHaveBeenCalledTimes(1);

    const failingWindow = {
      ensureAppAdvisorWindow: jest.fn(() =>
        Promise.reject(new Error('no display')),
      ),
    };
    expect(() =>
      requestAppAdvisorPresentation(failingWindow, 'queued_send'),
    ).not.toThrow();
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
    expect(mockWarn).toHaveBeenCalledTimes(1);

    // The chat:send-message handler (ipc/chat.ts) and the queued send
    // (services/chat-service.ts) only schedule the window. The terminal send
    // still awaits it: the window's terminal types that prompt.
    const repo = resolve(__dirname, '../../../../../..');
    const handler = readFileSync(
      join(repo, 'apps/desktop-app/src/main/ipc/chat.ts'),
      'utf8',
    );
    expect(handler).not.toMatch(/await\s+[\w?.]*ensureAppAdvisorWindow\(/);
    expect(handler).toMatch(/requestAppAdvisorPresentation\(/);
    const sends = readFileSync(
      join(repo, 'apps/desktop-app/src/main/services/chat-service.ts'),
      'utf8',
    );
    expect(sends).toContain(
      "requestAppAdvisorPresentation(appAdvisorSurfaces, 'queued_send');",
    );
    expect(
      sends.match(/await\s+[\w?.]*ensureAppAdvisorWindow\(/g) ?? [],
    ).toHaveLength(1);
  });

  it('with no window every core tool is advertised and no window accessor is called', () => {
    const names = getCanopyRouteTools(advisorRoute([]), false).map(
      (tool) => tool.name,
    );
    expect(names).toEqual(
      expect.arrayContaining(['DispatchAction', 'SearchActions']),
    );
    expect(names).not.toContain('ShowFiles');
    expect(names).not.toContain('GetCurrentUiState');

    const codex = buildCodexSessionDynamicToolSpecs({
      assistantMode: 'app-advisor',
      workspaceMode: 'worktree',
      isCodeReview: false,
      includeCodeGraph: false,
      includeChatVisuals: false,
      interfaceTools: [],
      toolSchemaProfile: 'standard',
    }).map((spec) => spec.name);
    expect(codex).toContain(
      APP_ADVISOR_TOOL_REGISTRY.dispatch_action.codexToolName,
    );
    expect(codex).toContain(
      APP_ADVISOR_TOOL_REGISTRY.search_actions.codexToolName,
    );
    expect(codex).not.toContain(
      APP_ADVISOR_TOOL_REGISTRY.show_files.codexToolName,
    );
    expect(codex).not.toContain(
      APP_ADVISOR_TOOL_REGISTRY.get_current_ui_state.codexToolName,
    );
  });

  it('a legacy action with no window answers that the window is not open and records nothing', async () => {
    const runtime = createAppAdvisorToolRuntime(surfaces(), destination);
    const action = dispatchActionSchema.parse({
      action: { type: 'workspace.create_multi_repo', name: 'Combined' },
    }).action;
    expect(appAdvisorActionDisposition(action.type)?.kind).toBe('legacy');

    const result = await routeAppAdvisorAction(
      action,
      runtime,
      { toolUseId: 'toolu_1', context: { interfaceTools: [] } },
      { runs: () => runs },
    );

    expect(JSON.parse(result.text)).toMatchObject({
      ok: false,
      error: {
        code: 'surface_unavailable',
        message: APP_ADVISOR_ACTION_TEXTS.legacyNeedsWindow,
      },
    });
    expect(await recordedOperations()).toBe(0);
    expect(windowRequest).not.toHaveBeenCalled();
  });

  it('a legacy action with the window open is delivered to the main window only', async () => {
    const advisorSurfaces = surfaces();
    const runtime = createAppAdvisorToolRuntime(advisorSurfaces, destination);
    windowRequest.mockResolvedValue({ requestId: 'toolu_2', ok: true });
    const action = dispatchActionSchema.parse({
      action: { type: 'workspace.create_multi_repo', name: 'Combined' },
    }).action;

    await routeAppAdvisorAction(
      action,
      runtime,
      {
        toolUseId: 'toolu_2',
        context: { interfaceTools: ['ui.app_advisor.present'] },
      },
      { runs: () => runs },
    );

    expect(windowRequest).toHaveBeenCalledTimes(1);
    const sentSurfaces = windowRequest.mock.calls[0]?.[1];
    expect(sentSurfaces?.getAppAdvisorWindow()).toBeNull();
    await sentSurfaces?.openAppAdvisorWindow();
    await sentSurfaces?.ensureAppAdvisorWindow();
    expect(advisorSurfaces.openAppAdvisorWindow).not.toHaveBeenCalled();
    expect(advisorSurfaces.ensureAppAdvisorWindow).not.toHaveBeenCalled();
    expect(await recordedOperations()).toBe(1);
  });

  it('SearchActions lists only actions that work without a window', async () => {
    const runtime = createAppAdvisorToolRuntime(surfaces(), destination);
    const search = async (
      interfaceTools: readonly InterfaceToolName[],
    ): Promise<string[]> => {
      const result = await executeAppAdvisorTool(
        'search_actions',
        { query: 'settings', limit: 50 },
        runtime,
        { interfaceTools },
      );
      const parsed: unknown = JSON.parse(result.text);
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('actions' in parsed) ||
        !Array.isArray(parsed.actions)
      )
        throw new Error('Unexpected SearchActions result.');
      return parsed.actions.map((entry: unknown) =>
        typeof entry === 'object' && entry !== null && 'type' in entry
          ? String(entry.type)
          : '',
      );
    };
    const windowOnly = (type: string): boolean => {
      const kind = appAdvisorActionDisposition(type)?.kind;
      return (
        kind === 'presentation' ||
        kind === 'host_presentation' ||
        kind === 'legacy'
      );
    };

    const unbound = await search([]);
    expect(unbound.length).toBeGreaterThan(0);
    expect(unbound.filter(windowOnly)).toEqual([]);
    const bound = await search(['ui.app_advisor.present']);
    expect(bound.filter(windowOnly).length).toBeGreaterThan(0);
  });

  it('a chat event with no window returns at once and records it undelivered', async () => {
    mockRecordDiagnostic.mockClear();
    const noWindows = surfaces();

    await expect(
      emitAppAdvisorSyntheticResultEvent('advisor-chat', noWindows),
    ).resolves.toBeUndefined();

    expect(noWindows.openAppAdvisorWindow).not.toHaveBeenCalled();
    expect(noWindows.ensureAppAdvisorWindow).not.toHaveBeenCalled();
    expect(mockRecordDiagnostic).toHaveBeenCalledTimes(1);
    expect(mockRecordDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'chat_event_undelivered',
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-1',
        chatId: 'advisor-chat',
        terminal: true,
      }),
    );
  });

  it('the system prompt names the no-window case', () => {
    expect(APP_ADVISOR_SYSTEM_PROMPT.split(NO_WINDOW_LINE)).toHaveLength(2);
  });
});
