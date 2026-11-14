import {
  CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS,
  type CanopyInjectedToolSurface,
} from '@canopy/execution-engine/lib/canopy-injected-tools';
import type { LedgerToolsRuntime } from '../../../canopy-tools/ledger-tools-runtime';
import type { CanopyWorktreeSessionRoute } from '../../http-proxy-service';

type RouteFields = Omit<
  CanopyWorktreeSessionRoute,
  | 'sessionKey'
  | 'projectId'
  | 'worktreeId'
  | 'chatId'
  | 'sdkSessionId'
  | 'authToken'
  | 'createdAt'
  | 'hookHandler'
>;

const ledgerTools = (): LedgerToolsRuntime =>
  ({}) as unknown as LedgerToolsRuntime;

function fixture(
  name: string,
  fields: RouteFields,
): CanopyWorktreeSessionRoute {
  return {
    sessionKey: `k-${name}`,
    projectId: 'p',
    worktreeId: 'w',
    chatId: 'c',
    sdkSessionId: 's',
    authToken: `t-${name}`,
    createdAt: 0,
    hookHandler: () => undefined,
    // Bound as a session created while the main window's lease serves its tools (CAN-4131, CAN-5822).
    interfaceTools: [
      'ui.get_current_ui_state',
      'ui.pipeline_editor.adopt_saved',
      'ui.pipeline_editor.create',
      'ui.pipeline_editor.get_current',
      'ui.pipeline_editor.list',
      'ui.pipeline_editor.open',
      'ui.pipeline_editor.prepare_save',
      'ui.pipeline_editor.set_yaml',
      'ui.pipeline_editor.to_list',
      'ui.show_files',
    ],
    ...fields,
  };
}

/** Session routes covering every surface and listing branch (CAN-4125). */
export function canopyRouteFixtures(): CanopyWorktreeSessionRoute[] {
  const surfaces = Object.keys(
    CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS,
  ).sort() as CanopyInjectedToolSurface[];
  const delegate = (exclusive: boolean): RouteFields =>
    ({
      toolSurface: 'native-sdk',
      managedDelegation: {
        exclusive,
        tools: [
          {
            name: 'delegate_task',
            description: 'Delegate.',
            inputSchema: { type: 'object' },
          },
        ],
        invoke: () => Promise.resolve({ text: '' }),
      },
    }) as unknown as RouteFields;
  return [
    ...surfaces.flatMap((toolSurface) => [
      fixture(`${toolSurface}-full`, {
        toolSurface,
        providerType: toolSurface.startsWith('antigravity-')
          ? 'antigravity'
          : 'claude',
        ledgerTools: ledgerTools(),
        codeGraphToolsAdvertised: true,
      }),
      fixture(`${toolSurface}-bare`, {
        toolSurface,
        providerType: toolSurface.startsWith('antigravity-')
          ? 'antigravity'
          : 'claude',
        codeGraphToolsAdvertised: false,
      }),
    ]),
    fixture('cursor-no-deferred', {
      toolSurface: 'cursor-acp',
      providerType: 'cursor',
      deferredToolsAllowed: false,
    }),
    fixture('opencode-no-deferred', {
      toolSurface: 'opencode-acp',
      providerType: 'opencode',
      deferredToolsAllowed: false,
    }),
    fixture('advisor-claude', {
      assistantMode: 'app-advisor',
      providerType: 'claude',
      ledgerTools: ledgerTools(),
      appAdvisorRuntime: {
        startForkedAgent: () => Promise.resolve(),
      } as unknown as RouteFields['appAdvisorRuntime'],
    }),
    fixture('advisor-cursor', {
      assistantMode: 'app-advisor',
      providerType: 'cursor',
    }),
    fixture('pipeline-editor', {
      assistantMode: 'pipeline-editor',
      providerType: 'claude',
    }),
    fixture('review', {
      toolSurface: 'native-sdk',
      providerType: 'claude',
      isCodeReview: true,
      respondToReviewComment: () =>
        Promise.resolve({ ok: true, resolved: false }),
      getReviewCommentThread: () => Promise.resolve({ ok: true, text: '' }),
    } as unknown as RouteFields),
    fixture('delegate-exclusive', delegate(true)),
    fixture('delegate-shared', delegate(false)),
    fixture('worker-none', {
      toolSurface: 'claude-worker',
      workerMemoryToolExposure: 'none',
    }),
    fixture('worker-ro-ledger', {
      toolSurface: 'claude-worker',
      workerMemoryToolExposure: 'read-only',
      ledgerTools: ledgerTools(),
    }),
    fixture('worker-rw-ledger', {
      toolSurface: 'claude-worker',
      workerMemoryToolExposure: 'read-write',
      ledgerTools: ledgerTools(),
      reportStructuredResultSchema: { type: 'object' },
    }),
  ];
}
