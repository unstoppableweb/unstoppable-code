/**
 * `window.__canopyPanelTestApi` — the UI-automation hook for the panel grid
 * (doc 09). Installed by `WorktreePart` for the currently hosted worktree
 * layout, gated HARD on the build-time `__CANOPY_E2E__` constant (same
 * posture as `window.__CANOPY_E2E_WORKERS__` in WorkersPage): production
 * builds inline `__CANOPY_E2E__` to `false` and dead-code-eliminate the
 * installer body, so the API can never exist outside an E2E build.
 *
 * Layout ops dispatch through the panel layout store — the same imperative
 * API the real buttons/DnD call — never the grid directly. The browser-create
 * fixture forwards the full request to preload and registers only its real
 * returned snapshot in the renderer store before panel placement. The
 * pipeline-run fixture (`addPipelineExecutionPanel`) is the only way to create
 * a `pipeline-execution` tab until a user entry point exists; it drives the
 * real identity, placement, and restore rules, read back through the
 * serialized-layout getters or `findPipelineExecutionPanel`.
 * `openPipelineExecution` drives the real user-facing opener (owner
 * resolution, navigation, placement or reveal, explicit targets) and returns
 * its typed result.
 */
import {
  clearRenderFault,
  failRender,
  type RenderFaultTarget,
} from '@/lib/e2e-render-fault';
import type {
  ISerializedPanelNode,
  PanelCollapseEdge,
  PanelDropEdge,
  PanelSplitDirection,
  SerializablePanelLayoutFile,
  SerializedPanelLayout,
  SerializedPanelNode,
} from '@canopy/protocol';
import type {
  BrowserCreateRequest,
  BrowserSessionSnapshot,
  ChatCommand,
  ShowFilesRendererRequest,
  ShowFilesRendererResult,
} from '@canopy/desktop-shared/types';
import type { PanelCollapseAffordance } from '@canopy/ui-shared/panels';
import {
  findPanelByInstanceKey,
  getAuxPanelLayoutOwnerKey,
  getPanelInstanceKey,
  getPanelLayoutViewModel,
  setPanelLayoutFixedTopology,
  usePanelLayoutStore,
  type PanelInstanceLocation,
  type PanelLayoutState,
} from '@/stores/panelLayoutStore';
import { getWorktreeCacheKey, useFileListStore } from '@/stores/fileListStore';
import { usePanelWindowsStore } from '@/stores/panelWindowsStore';
import { useChatStore } from '@/stores/chatStore';
import { useBrowserStore } from '@/stores/browserStore';
import { requestBrowserPanel } from '@/lib/browserPanelActivation';
import { showFilesInRenderer } from '@/lib/show-files';
import { failNextWorkspaceLayoutModeSaveForE2e } from '@/stores/workspaceLayoutModeStore';
import {
  placeOrRevealContentPanel,
  type ContentPanelPlacementResult,
  type ContentPanelOpenResult,
} from './chat-panel-sync';
import { pipelineExecutionPanelSeed } from './pipeline-execution-panel-identity';
import {
  openPipelineExecutionPanel,
  type OpenPipelineExecutionRequest,
  type OpenPipelineExecutionResult,
} from './open-pipeline-execution';
import {
  openSubagentChatPanel,
  openSubagentsPanel,
  type OpenSubagentPanelOptions,
  type SubagentPanelScope,
} from './subagent-panel-open';
import type { SubagentChatPanelTarget } from './subagent-panel-identity';
import { useTerminalStore } from '@/stores/terminalStore';
import {
  probeLegacyTerminalPanelMaterializationForE2e,
  type LegacyTerminalPanelMaterializationProbe,
} from '@/components/terminal/terminalPanelMaterialization';

type PanelArrangement = 'even' | 'maximize' | 'expand';

interface TerminalMaterializationTestState extends LegacyTerminalPanelMaterializationProbe {
  readonly bucketRetained: boolean;
  readonly layoutPresent: boolean;
}

interface TerminalPlacementTestState {
  readonly sessionIds: string[];
  /** One entry per bound tab, duplicates included, across main and aux layouts. */
  readonly bindings: { layoutKey: string; terminalId: string }[];
}

interface TerminalMaterializationTestProbe {
  read(): TerminalMaterializationTestState;
  touchStores(): void;
}

/**
 * The imperative test API installed by the desktop renderer test-harness layer.
 * The protocol package owns only the serializable layout projection consumed by
 * this API.
 */
interface CanopyPanelTestApi {
  /** Retains a read-only observer probe after archive removes its scope. */
  captureTerminalMaterializationProbe(): TerminalMaterializationTestProbe;
  /** Renderer terminal sessions, and their panel bindings in the layout family. */
  getTerminalPlacementState(): TerminalPlacementTestState;
  getSerializedLayout(): SerializedPanelLayout;
  /** Throws during render at `panel:<panelId>`, `chart`, `lazy-load` or `window`. */
  failRender(target: RenderFaultTarget): void;
  /** Stops the fault at `target`, or every fault when omitted. */
  clearRenderFault(target?: RenderFaultTarget): void;
  getActiveGroupId(): string | null;
  /** Returns the new group's id. */
  splitPanel(groupId: string, direction: PanelSplitDirection): string;
  focusPanel(groupId: string, panelId?: string): void;
  movePanel(panelId: string, targetGroupId: string, edge: PanelDropEdge): void;
  closeGroup(groupId: string): void;
  maximizeGroup(groupId: string, maximized: boolean): void;
  collapseGroup(groupId: string, collapsed: boolean): void;
  setFixedTopology(fixed: boolean): void;
  getCollapsedBranchCount(): number;
  getCollapseAffordance(groupId: string): PanelCollapseAffordance;
  /**
   * Every distinct collapse state one group has had in this layout since the
   * API was installed, oldest first. The surface installs the API before it
   * ensures the layout, so the history starts at the layout's first state
   * and keeps a collapse that is undone within the same frame.
   */
  getGroupCollapseHistory(groupId: string): GroupCollapseRecord[];
  arrangeGroups(arrangement: PanelArrangement, targetGroupId?: string): void;
  /** Resolves with the auxiliary window id. */
  popOutPanel(groupId: string): Promise<string>;
  getAuxSerializedLayout(auxWindowId: string): SerializablePanelLayoutFile;
  failNextWorkspaceLayoutModeSave(): void;
  mergeBackWindow(auxWindowId: string): Promise<void>;
  /** Test-only: simulate the selected worktree's chat tabs still hydrating. */
  simulateChatHydrationPending(): void;
  /** Test-only: deliver one contiguous prior chat-activation commit. */
  simulateDelayedChatActivation(activeTabId: string): void;
  /** Test-only: hold matching renderer commands, then settle them as rejected. */
  holdChatCommandsAsRejected(commandType: ChatCommand['type']): void;
  releaseRejectedChatCommands(): void;
  /** Test-only: hold renderer chat sends until released, then send them. */
  holdChatSends(afterDispatch?: boolean): void;
  releaseHeldChatSends(): void;
  /** Creates through preload and registers its real result for this worktree. */
  createBrowser(request: BrowserCreateRequest): Promise<BrowserSessionSnapshot>;
  /** Reads a fixed, owner-bound projection of one browser's lifecycle state. */
  getBrowserLifecycle(browserId: string): {
    hydrated: boolean;
    hydrationErrorPresent: boolean;
    known: boolean;
    live: boolean;
    active: boolean;
    status: BrowserSessionSnapshot['status'] | null;
    loading: boolean;
    lastErrorPresent: boolean;
  };
  /** Routes through browser placement, optionally forcing both insertions to fail. */
  requestBrowserPanel(
    browserId: string,
    originChatTabId: string,
    failInsertion?: boolean,
  ): Promise<boolean>;
  /** Dispatches the renderer half of an agent Show File request. */
  showFiles(
    request: ShowFilesRendererRequest,
  ): Promise<ShowFilesRendererResult>;
  /** Returns the in-memory durability boundary for explorer remount restore. */
  getFileTreeScrollPosition(
    projectId: string,
    worktreeId: string,
  ): number | null;
  /**
   * Opens (or reveals) an execution-bound `pipeline-execution` tab through
   * the real store. With `groupId` the tab is added straight to that group of
   * `layoutKey` (default: the owner layout) via `addTab`; without it the
   * shared content placement runs (family search, layout wait, file/chat
   * origin, Minimal/MRU fallback). Bypasses owner resolution and navigation;
   * use `openPipelineExecution` for the user-facing path.
   */
  addPipelineExecutionPanel(
    request: PipelineExecutionPanelTestRequest,
  ): Promise<ContentPanelPlacementResult>;
  /**
   * Runs the real opener every live entry point uses (reads the run, checks
   * the owner hint, navigates to the owner, places or reveals the tab, and
   * applies the target) and returns its typed result.
   */
  openPipelineExecution(
    request: OpenPipelineExecutionRequest,
  ): Promise<OpenPipelineExecutionResult>;
  /** Opens or reveals the installed worktree's Subagents panel. */
  openSubagentsPanel(
    options?: OpenSubagentPanelOptions,
  ): Promise<ContentPanelOpenResult>;
  /** Opens or reveals one subagent chat in the installed worktree. */
  openSubagentChatPanel(
    target: SubagentChatPanelTestTarget,
    options?: OpenSubagentPanelOptions,
  ): Promise<ContentPanelOpenResult>;
  /** Where a run's tab lives anywhere in the owner's layout family, or null. */
  findPipelineExecutionPanel(
    executionId: string,
    worktreeKey?: string,
  ): PanelInstanceLocation | null;
}

interface PipelineExecutionPanelTestRequest {
  readonly executionId: string;
  /** Owner worktree key; defaults to the installed host's worktree. */
  readonly worktreeKey?: string;
  /** Direct-add target layout (main or `#aux:`); defaults to the owner. */
  readonly layoutKey?: string;
  /** Direct-add target group; omit to use the shared placement helper. */
  readonly groupId?: string;
  readonly originChatTabId?: string;
  readonly originFileTabId?: string;
}

/** One recorded collapse state: the edge (`null` when open) and its `auto` flag. */
interface GroupCollapseRecord {
  readonly collapsed: PanelCollapseEdge | null;
  readonly auto: boolean;
}

type SubagentChatPanelTestTarget = Pick<
  SubagentChatPanelTarget,
  'rootChatId' | 'subagentId' | 'subagentKind' | 'title'
>;

declare global {
  interface Window {
    __canopyPanelTestApi?: CanopyPanelTestApi;
  }
}

/**
 * Projects one node of the persisted-schema tree into the doc-09 test
 * projection: defaults are flattened into required fields (`visible`,
 * `maximized`) and branch orientation becomes an explicit string. Branch
 * children alternate orientation with their parent (engine invariant), so
 * each recursion flips the orientation it passes down.
 */
function toSerializedNode(
  node: ISerializedPanelNode,
  orientation: 'horizontal' | 'vertical',
): SerializedPanelNode {
  if (node.type === 'leaf') {
    return {
      type: 'leaf',
      groupId: node.groupId,
      panels: node.panels.map((panel) => ({
        panelId: panel.panelId,
        kind: panel.kind,
        // Per-instance binding passthrough (additive test-projection field).
        ...(panel.instance !== undefined ? { instance: panel.instance } : {}),
        // Pinned-state passthrough (additive test-projection field).
        ...(panel.pinned === true ? { pinned: true } : {}),
      })),
      activePanelId: node.activePanelId,
      size: node.size,
      visible: node.visible ?? true,
      maximized: node.maximized ?? false,
      collapsed: node.collapsed?.edge ?? null,
      // Additive provenance probe: `collapsed` above is flattened to an edge
      // string, so `auto` is otherwise unobservable from a spec.
      ...(node.collapsed?.auto === true ? { collapsedAuto: true } : {}),
    };
  }
  const childOrientation =
    orientation === 'horizontal' ? 'vertical' : 'horizontal';
  return {
    type: 'branch',
    orientation,
    children: node.children.map((child) =>
      toSerializedNode(child, childOrientation),
    ),
    size: node.size,
    visible: node.visible ?? true,
  };
}

/** Resolves the worktree owner of a main- or auxiliary-layout test API. */
function subagentPanelScopeForWorktreeKey(
  worktreeKey: string,
): SubagentPanelScope | null {
  const ownerKey = getAuxPanelLayoutOwnerKey(worktreeKey) ?? worktreeKey;
  const separator = ownerKey.indexOf('/');
  if (separator <= 0 || separator === ownerKey.length - 1) return null;
  return {
    projectId: ownerKey.slice(0, separator),
    worktreeId: ownerKey.slice(separator + 1),
  };
}

/**
 * LIFO stack of installed APIs. Two grid hosts can be mounted at once (the
 * always-mounted WorktreePart plus the Cowork page's grid); the most recently
 * mounted host owns `window.__canopyPanelTestApi`, and unmounting it restores
 * the previous host's API instead of deleting the global.
 */
const installedApis: CanopyPanelTestApi[] = [];

function syncWindowPanelTestApi(): void {
  const top = installedApis[installedApis.length - 1];
  if (top === undefined) {
    delete window.__canopyPanelTestApi;
  } else {
    window.__canopyPanelTestApi = top;
  }
}

/**
 * Installs the test API for one worktree layout. Returns an uninstaller (for
 * the hosting effect's cleanup), or `undefined` outside E2E builds where
 * nothing was installed. Re-invoke on worktree change so the API always
 * addresses the visible layout.
 */
export function installPanelTestApi(
  worktreeKey: string,
): (() => void) | undefined {
  if (!__CANOPY_E2E__) {
    return undefined;
  }

  const store = (): PanelLayoutState => usePanelLayoutStore.getState();
  const originalDispatchChatCommand =
    useChatStore.getState().dispatchChatCommand;
  const rejectedChatCommandReleases: Array<() => void> = [];
  const originalSendMessage = useChatStore.getState().sendMessage;
  const heldChatSendReleases: Array<() => void> = [];
  const subagentScope = subagentPanelScopeForWorktreeKey(worktreeKey);
  const failedPanelOpen: ContentPanelOpenResult = { status: 'failed' };
  const collapseHistory = new Map<string, GroupCollapseRecord[]>();
  const recordCollapseHistory = (state: PanelLayoutState): void => {
    const groups = state.layouts[worktreeKey]?.groups;
    if (groups === undefined) return;
    for (const [groupId, group] of Object.entries(groups)) {
      const record: GroupCollapseRecord = {
        collapsed: group.collapsed?.edge ?? null,
        auto: group.collapsed?.auto === true,
      };
      const history = collapseHistory.get(groupId) ?? [];
      const last = history[history.length - 1];
      if (last?.collapsed === record.collapsed && last.auto === record.auto) {
        continue;
      }
      history.push(record);
      collapseHistory.set(groupId, history);
    }
  };
  recordCollapseHistory(store());
  const stopCollapseHistory = usePanelLayoutStore.subscribe(
    recordCollapseHistory,
  );

  const api: CanopyPanelTestApi = {
    captureTerminalMaterializationProbe:
      (): TerminalMaterializationTestProbe => {
        const probe =
          probeLegacyTerminalPanelMaterializationForE2e(worktreeKey);
        if (!probe) throw new Error('No terminal materialization observer');
        return {
          read: (): TerminalMaterializationTestState => ({
            ...probe(),
            bucketRetained:
              useTerminalStore.getState().worktrees[worktreeKey] !== undefined,
            layoutPresent: store().layouts[worktreeKey] !== undefined,
          }),
          touchStores: (): void => {
            useTerminalStore.setState((state) => ({
              worktrees: { ...state.worktrees },
            }));
            usePanelLayoutStore.setState((state) => ({
              layouts: { ...state.layouts },
            }));
          },
        };
      },
    getTerminalPlacementState: (): TerminalPlacementTestState => ({
      sessionIds: Object.keys(
        useTerminalStore.getState().worktrees[worktreeKey]?.sessions ?? {},
      ),
      bindings: Object.entries(store().layouts).flatMap(
        ([layoutKey, layout]) =>
          layoutKey === worktreeKey ||
          getAuxPanelLayoutOwnerKey(layoutKey) === worktreeKey
            ? Object.values(layout.groups).flatMap((group) =>
                (group.tabs ?? []).flatMap((tab) =>
                  tab.kind === 'terminal' && tab.instance?.terminalId
                    ? [{ layoutKey, terminalId: tab.instance.terminalId }]
                    : [],
                ),
              )
            : [],
      ),
    }),
    failRender,
    clearRenderFault,
    getSerializedLayout: (): SerializedPanelLayout => {
      const file = store().serializeLayout(worktreeKey);
      if (!file) {
        throw new Error(`No panel layout for worktree ${worktreeKey}`);
      }
      // Protocol orientation is numeric for engine parity: 0 = vertical,
      // 1 = horizontal.
      const rootOrientation =
        file.grid.orientation === 1 ? 'horizontal' : 'vertical';
      return {
        root: toSerializedNode(file.grid.root, rootOrientation),
        width: file.grid.width,
        height: file.grid.height,
        activeGroupId: file.activeGroupId,
      };
    },
    getActiveGroupId: (): string | null =>
      getPanelLayoutViewModel(worktreeKey)?.activeGroupId ?? null,
    splitPanel: (groupId, direction): string => {
      const newGroupId = store().splitGroup(worktreeKey, groupId, direction);
      if (newGroupId === null) {
        throw new Error(`splitPanel failed for group ${groupId}`);
      }
      return newGroupId;
    },
    focusPanel: (groupId, panelId): void => {
      if (panelId !== undefined) {
        store().selectTab(worktreeKey, groupId, panelId);
      } else {
        store().focusGroup(worktreeKey, groupId);
      }
    },
    movePanel: (panelId, targetGroupId, edge): void => {
      store().movePanel(worktreeKey, panelId, targetGroupId, edge);
    },
    closeGroup: (groupId): void => {
      store().closeGroup(worktreeKey, groupId);
    },
    maximizeGroup: (groupId, maximized): void => {
      store().maximizeGroup(worktreeKey, groupId, maximized);
    },
    collapseGroup: (groupId, collapsed): void => {
      if (collapsed) {
        store().collapseGroup(worktreeKey, groupId);
      } else {
        store().expandGroup(worktreeKey, groupId);
      }
    },
    setFixedTopology: (fixed): void => {
      setPanelLayoutFixedTopology(worktreeKey, fixed);
    },
    getCollapsedBranchCount: (): number =>
      store().layouts[worktreeKey]?.controller.getCollapsedBranches?.()
        .length ?? 0,
    getCollapseAffordance: (groupId): PanelCollapseAffordance => {
      const model = store().layouts[worktreeKey]?.viewModel.groups.find(
        (group) => group.groupId === groupId,
      );
      return model?.collapseAffordance ?? { state: 'none' };
    },
    getGroupCollapseHistory: (groupId): GroupCollapseRecord[] => [
      ...(collapseHistory.get(groupId) ?? []),
    ],
    arrangeGroups: (arrangement, targetGroupId): void => {
      if (arrangement === 'even') {
        store().arrangeGroups(worktreeKey, 'even');
        return;
      }
      if (arrangement === 'maximize' && targetGroupId !== undefined) {
        store().maximizeGroup(worktreeKey, targetGroupId, true);
        return;
      }
      throw new Error(`arrangeGroups '${arrangement}' not implemented`);
    },
    // Phase 8 auxiliary windows — dispatch through the panel-windows store
    // (the same path as the chrome pop-out button / merge-back header).
    popOutPanel: (groupId): Promise<string> => {
      const auxWindowId = usePanelWindowsStore
        .getState()
        .popOutGroup(worktreeKey, groupId);
      if (auxWindowId === null) {
        return Promise.reject(
          new Error(
            `popOutPanel rejected for group ${groupId} (window-bound tab, last group, or window open failure)`,
          ),
        );
      }
      return Promise.resolve(auxWindowId);
    },
    getAuxSerializedLayout: (auxWindowId): SerializablePanelLayoutFile => {
      const record = usePanelWindowsStore.getState().auxWindows[auxWindowId];
      if (record === undefined) {
        throw new Error(`Unknown auxiliary window ${auxWindowId}`);
      }
      const layout = store().serializeLayout(record.layoutKey);
      if (layout === null) {
        throw new Error(`No layout for auxiliary window ${auxWindowId}`);
      }
      return layout;
    },
    failNextWorkspaceLayoutModeSave: (): void => {
      failNextWorkspaceLayoutModeSaveForE2e();
    },
    mergeBackWindow: (auxWindowId): Promise<void> => {
      const windowsStore = usePanelWindowsStore.getState();
      if (windowsStore.auxWindows[auxWindowId] === undefined) {
        return Promise.reject(
          new Error(`mergeBackWindow: unknown aux window ${auxWindowId}`),
        );
      }
      windowsStore.mergeBack(auxWindowId);
      return Promise.resolve();
    },
    simulateChatHydrationPending: (): void => {
      useChatStore.setState((state) => {
        if (state.worktreeChats[worktreeKey] === undefined) {
          return state;
        }
        const worktreeChats = { ...state.worktreeChats };
        delete worktreeChats[worktreeKey];
        return { worktreeChats };
      });
    },
    simulateDelayedChatActivation: (activeTabId): void => {
      const separator = worktreeKey.indexOf('/');
      const projectId = worktreeKey.slice(0, separator);
      const worktreeId = worktreeKey.slice(separator + 1);
      const revision =
        useChatStore.getState().chatStateSync[worktreeKey]?.revision;
      if (revision === null || revision === undefined) {
        throw new Error(`Chat scope ${worktreeKey} is not revisioned`);
      }
      useChatStore.getState().handleChatStateChanged({
        schemaVersion: 1,
        eventId: `e2e-delayed-activation-${String(revision + 1)}`,
        occurredAt: new Date().toISOString(),
        projectId,
        worktreeId,
        baseRevision: revision,
        revision: revision + 1,
        changes: [{ type: 'tab.active_changed', activeTabId }],
      });
    },
    holdChatCommandsAsRejected: (commandType): void => {
      useChatStore.setState({
        dispatchChatCommand: (target, command, options) => {
          if (command.type !== commandType) {
            return originalDispatchChatCommand(target, command, options);
          }
          return new Promise((resolve) => {
            rejectedChatCommandReleases.push(() => {
              options?.rollback?.();
              resolve('rejected');
            });
          });
        },
      });
    },
    releaseRejectedChatCommands: (): void => {
      const releases = rejectedChatCommandReleases.splice(0);
      for (const release of releases) release();
      useChatStore.setState({
        dispatchChatCommand: originalDispatchChatCommand,
      });
    },
    holdChatSends: (afterDispatch = false): void => {
      useChatStore.setState({
        sendMessage: (...args) => {
          if (afterDispatch) {
            const released = new Promise<void>((resolve) => {
              heldChatSendReleases.push(resolve);
            });
            return originalSendMessage(...args).then(() => released);
          }
          return new Promise((resolve, reject) => {
            heldChatSendReleases.push(() => {
              originalSendMessage(...args).then(resolve, reject);
            });
          });
        },
        // Linked plan implementations send through the canonical command.
        dispatchChatCommand: (target, command, options) => {
          if (command.type !== 'chat.send_message') {
            return originalDispatchChatCommand(target, command, options);
          }
          if (afterDispatch) {
            const released = new Promise<void>((resolve) => {
              heldChatSendReleases.push(resolve);
            });
            return originalDispatchChatCommand(target, command, options).then(
              (disposition) => released.then(() => disposition),
            );
          }
          return new Promise((resolve, reject) => {
            heldChatSendReleases.push(() => {
              originalDispatchChatCommand(target, command, options).then(
                resolve,
                reject,
              );
            });
          });
        },
      });
    },
    releaseHeldChatSends: (): void => {
      useChatStore.setState({
        sendMessage: originalSendMessage,
        dispatchChatCommand: originalDispatchChatCommand,
      });
      const releases = heldChatSendReleases.splice(0);
      for (const release of releases) release();
    },
    createBrowser: async (
      request: BrowserCreateRequest,
    ): Promise<BrowserSessionSnapshot> => {
      const separator = worktreeKey.indexOf('/');
      const projectId = worktreeKey.slice(0, separator);
      const worktreeId = worktreeKey.slice(separator + 1);
      if (
        request.projectId !== projectId ||
        request.worktreeId !== worktreeId
      ) {
        throw new Error(
          `Panel test API for ${worktreeKey} does not own browser request ${request.projectId}/${request.worktreeId}`,
        );
      }
      const snapshot = await window.api.browser.create(request);
      useBrowserStore.getState().registerBrowserSnapshot(snapshot);
      return snapshot;
    },
    getBrowserLifecycle: (browserId) => {
      const bucket = useBrowserStore.getState().worktrees[worktreeKey];
      const snapshot = bucket?.browsers[browserId];
      return {
        hydrated: bucket?.hydrated === true,
        hydrationErrorPresent: bucket?.hydrationError !== undefined,
        known: snapshot !== undefined,
        live: bucket?.live.has(browserId) === true,
        active: bucket?.activeBrowserId === browserId,
        status: snapshot?.status ?? null,
        loading: snapshot?.loading === true,
        lastErrorPresent: snapshot?.lastError !== undefined,
      };
    },
    requestBrowserPanel: async (
      browserId,
      originChatTabId,
      failInsertion = false,
    ): Promise<boolean> => {
      const separator = worktreeKey.indexOf('/');
      const projectId = worktreeKey.slice(0, separator);
      const worktreeId = worktreeKey.slice(separator + 1);
      if (!failInsertion) {
        return requestBrowserPanel(
          projectId,
          worktreeId,
          browserId,
          originChatTabId,
        );
      }

      const panelStore = store();
      const originalAddTab = panelStore.addTab.bind(panelStore);
      usePanelLayoutStore.setState({ addTab: () => null });
      try {
        return await requestBrowserPanel(
          projectId,
          worktreeId,
          browserId,
          originChatTabId,
        );
      } finally {
        usePanelLayoutStore.setState({ addTab: originalAddTab });
      }
    },
    showFiles: (request): Promise<ShowFilesRendererResult> =>
      showFilesInRenderer(request, 'main'),
    getFileTreeScrollPosition: (projectId, worktreeId): number | null =>
      useFileListStore.getState().fileTreeScrollPositions[
        getWorktreeCacheKey(projectId, worktreeId)
      ] ?? null,
    addPipelineExecutionPanel: async (
      request,
    ): Promise<ContentPanelPlacementResult> => {
      const ownerKey = request.worktreeKey ?? worktreeKey;
      const seed = pipelineExecutionPanelSeed(request.executionId);
      if (request.groupId === undefined) {
        const origin = {
          ...(request.originFileTabId !== undefined
            ? { fileTabId: request.originFileTabId }
            : {}),
          ...(request.originChatTabId !== undefined
            ? { chatTabId: request.originChatTabId }
            : {}),
        };
        return placeOrRevealContentPanel({
          worktreeKey: ownerKey,
          seed,
          origin,
        });
      }
      const layoutKey = request.layoutKey ?? ownerKey;
      const panelId = store().addTab(layoutKey, request.groupId, seed.kind, {
        panelId: seed.panelId,
        title: seed.title,
        instance: seed.instance,
      });
      if (panelId === null) {
        return { outcome: 'unavailable' };
      }
      return {
        outcome: 'placed',
        location: { layoutKey, groupId: request.groupId, panelId },
      };
    },
    openPipelineExecution: (request): Promise<OpenPipelineExecutionResult> =>
      openPipelineExecutionPanel(request),
    openSubagentsPanel: (options): Promise<ContentPanelOpenResult> =>
      subagentScope === null
        ? Promise.resolve(failedPanelOpen)
        : openSubagentsPanel(subagentScope, options),
    openSubagentChatPanel: (
      target,
      options,
    ): Promise<ContentPanelOpenResult> =>
      subagentScope === null
        ? Promise.resolve(failedPanelOpen)
        : openSubagentChatPanel(subagentScope, target, options),
    findPipelineExecutionPanel: (
      executionId,
      ownerKey = worktreeKey,
    ): PanelInstanceLocation | null =>
      findPanelByInstanceKey(
        ownerKey,
        getPanelInstanceKey({
          kind: 'pipeline-execution',
          instance: { executionId },
        }),
      ),
  };

  installedApis.push(api);
  syncWindowPanelTestApi();
  return (): void => {
    stopCollapseHistory();
    useChatStore.setState({
      dispatchChatCommand: originalDispatchChatCommand,
      sendMessage: originalSendMessage,
    });
    const index = installedApis.indexOf(api);
    if (index !== -1) {
      installedApis.splice(index, 1);
    }
    syncWindowPanelTestApi();
  };
}
