/**
 * App Advisor window/session store.
 *
 * After the Work Entries workspace rework this store owns ONLY:
 *  (a) popout window/session state (visibility mirror + legacy persisted
 *      bounds preference);
 *  (b) pending ask-user questions raised by the App Advisor tool runtime;
 *  (c) global App Advisor preference defaults consumed by existing entry
 *      points (quick prompts, automations, settings surfaces).
 *
 * Chat data lives EXCLUSIVELY in the standard chat store's entry-keyed
 * slices (`chatStore.worktreeChats['app-advisor/<entryId>']`) — there is no
 * tab/message mirroring or sentinel-slice hydration here anymore. The main
 * renderer aggregates nav status by listing Work Entries and loading each
 * entry's tab metadata ({@link AppAdvisorStore.hydrateForNavigation}).
 */
import { create } from 'zustand';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  APP_ADVISOR_FLOATING_DEFAULT_SIZE,
  APP_ADVISOR_PROJECT_ID,
  DEFAULT_APP_ADVISOR_MODEL,
  type AppAdvisorFloatingSize,
  type AppAdvisorAskUserAnswer,
  type AppAdvisorAskUserQuestion,
  type AppAdvisorUiStateEnvelope,
  type AppAdvisorWindowLayout,
  type AppAdvisorWindowOpenRequest,
  type AppAdvisorWindowState,
  type ChatInterfaceMode,
  type ChatModel,
  type ChatTabPluginSelections,
  type PreferencesData,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { getLabsFeatureEnabled } from '@/stores/labsExperimentsStore';
import { ORCHESTRATOR_PAGE_EXPERIMENT_ID } from '@/lib/orchestratorPageExperiment';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { getEffectiveClaudeChatInterfaceMode } from '@/lib/claude-tui-chats';
import { normalizeAppAdvisorPluginSelections } from '@/lib/appAdvisorPluginSelections';

/**
 * Legacy-named persisted window bounds for the standalone App Advisor
 * BrowserWindow. The preference key is `appAdvisorDialogBounds`, retained
 * from the original floating-dialog implementation to avoid a preference
 * migration; today the value is the BrowserWindow bounds owned by the main
 * process. The renderer no longer reads or writes this from the panel — it
 * remains exported for hydration/test compatibility.
 */
export interface AppAdvisorDialogBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AppAdvisorPendingQuestion {
  requestId: string;
  question: AppAdvisorAskUserQuestion;
  /**
   * The App Advisor chat tab that asked, when main reports it; its composer
   * asks the question. Without one, any App Advisor composer may ask it.
   */
  chatId?: string;
}

export interface AppAdvisorStore {
  /**
   * Mirror of the main-process App Advisor BrowserWindow visibility, kept
   * in sync via {@link syncWindowState}. Both renderers read this from
   * `useNavigationStore.appAdvisorOpen`; the field on this store exists
   * for backwards compatibility with existing selectors.
   */
  open: boolean;
  /**
   * Mirror of the App Advisor window's layout: the early access floating
   * chat or the full window. Until the main process reports one, the layout
   * its page was made for (early access), else `full`.
   */
  layout: AppAdvisorWindowLayout;
  /** Mirror of the floating panel's size (CSS px at 100%). */
  floatingSize: AppAdvisorFloatingSize;
  /** Resizes the floating panel (early access). */
  setFloatingSize: (size: AppAdvisorFloatingSize) => void;
  /**
   * Mirror of the floating panel being minimized to its bubble in the main
   * window (early access).
   */
  minimized: boolean;
  bounds: AppAdvisorDialogBounds | null;
  pendingQuestions: AppAdvisorPendingQuestion[];
  appAdvisorModel: ChatModel;
  appAdvisorThinkingLevel: ThinkingLevel;
  appAdvisorPluginSelections: ChatTabPluginSelections;
  appAdvisorDefaultInterfaceMode: ChatInterfaceMode;
  /**
   * Cross-renderer App Advisor aggregation. Loads preferences, lists Work
   * Entries, and hydrates each entry's tab metadata. The main renderer uses
   * the read-only mirrors for Sidebar status; the authoritative App Advisor
   * renderer uses the same complete set to persist focus-driven unread clears.
   * Idempotent and safe to call repeatedly (`loadTabsForTarget` short-circuits
   * hydrated slices).
   */
  hydrateForNavigation: () => Promise<void>;
  /**
   * Apply a window-state broadcast from the main process. Updates the
   * local `open` mirror, `useNavigationStore.appAdvisorOpen`,
   * `useNavigationStore.appAdvisorFocused`, the App Advisor UI-state
   * slice, and clears App Advisor unread across every hydrated entry when
   * the window becomes focused (the chat-store helper's surface guard
   * decides whether the clear is persisted).
   */
  syncWindowState: (state: AppAdvisorWindowState) => void;
  openDialog: () => void;
  /**
   * Opens the Orchestrator as a page in the main window, in the normal chat
   * layout (the docked placement). `request` selects what it opens on.
   */
  openDocked: (
    request?: Pick<
      AppAdvisorWindowOpenRequest,
      'workEntryId' | 'newWorkEntry' | 'openSettings' | 'archivedOverview'
    >,
  ) => void;
  /** Turns the floating chat into the Orchestrator page in the main window. */
  expandDialog: () => void;
  /**
   * Moves the Orchestrator into its separate window, where its in-app
   * browser panels show.
   */
  openSeparateWindow: () => void;
  closeDialog: () => void;
  /** Minimizes the floating chat to its bubble in the main window. */
  minimizeDialog: () => void;
  toggleDialog: () => void;
  setBounds: (bounds: AppAdvisorDialogBounds) => void;
  askUserQuestion: (
    requestId: string,
    question: AppAdvisorAskUserQuestion,
    chatId?: string,
  ) => Promise<AppAdvisorAskUserAnswer | null>;
  answerQuestion: (requestId: string, answer: AppAdvisorAskUserAnswer) => void;
  dismissQuestion: (requestId: string) => void;
  dismissAllQuestions: () => void;
  applyPreferences: (
    prefs: Pick<
      PreferencesData,
      | 'appAdvisorModel'
      | 'appAdvisorThinkingLevel'
      | 'appAdvisorPluginSelections'
      | 'defaultAppAdvisorInterfaceMode'
    >,
  ) => void;
  /**
   * Returns the latest envelope after yielding a microtask so any
   * synchronous reporter updates from the same user gesture are applied
   * first. Exposed for callers (e.g., the pipeline-debug action handler)
   * that mutate UI state and then call `sendMessage` in the same tick.
   */
  readEnvelopeAfterFlush: () => Promise<AppAdvisorUiStateEnvelope>;
}

const pendingQuestionResolvers = new Map<
  string,
  Array<(answer: AppAdvisorAskUserAnswer | null) => void>
>();

const CACHED_QUESTION_ANSWER_LIMIT = 100;

/**
 * Cached ask-user responses keyed by `requestId`. When the App Advisor
 * renderer is re-asked the same question (e.g. a tool retried after a hide
 * cycle), the cached answer is re-emitted so the tool handler stays
 * idempotent without re-prompting the user.
 */
const cachedQuestionAnswers = new Map<string, AppAdvisorAskUserAnswer | null>();

function rememberCachedQuestionAnswer(
  requestId: string,
  answer: AppAdvisorAskUserAnswer | null,
): void {
  if (cachedQuestionAnswers.has(requestId)) {
    cachedQuestionAnswers.delete(requestId);
  }
  cachedQuestionAnswers.set(requestId, answer);
  if (cachedQuestionAnswers.size > CACHED_QUESTION_ANSWER_LIMIT) {
    const firstKey = cachedQuestionAnswers.keys().next().value;
    if (firstKey !== undefined) {
      cachedQuestionAnswers.delete(firstKey);
    }
  }
}

/**
 * Clears App Advisor unread across every hydrated `app-advisor/<worktreeId>`
 * chat slice when the App Advisor window is focused. The chat-store helper's
 * `__chatStoreSurface` guard decides whether each clear is durable: the App
 * Advisor renderer issues the canonical read command; the main renderer only
 * updates its in-memory mirror so the Sidebar amber treatment drops
 * immediately.
 */
function markAppAdvisorReadIfFocused(focused: boolean): void {
  if (!focused && !useNavigationStore.getState().appAdvisorFocused) {
    return;
  }

  const chatStore = useChatStore.getState();
  const prefix = `${APP_ADVISOR_PROJECT_ID}/`;
  for (const key of Object.keys(chatStore.worktreeChats)) {
    if (!key.startsWith(prefix)) continue;
    const worktreeId = key.slice(prefix.length);
    chatStore.markTargetRead(APP_ADVISOR_PROJECT_ID, worktreeId, {
      allTabs: true,
    });
  }
}

/**
 * The layout before the main process reports one: early access gives App
 * Advisor's own page the layout it opens in, so its first frame is already
 * in it. Everywhere else, `full`.
 */
function initialAppAdvisorLayout(): AppAdvisorWindowLayout {
  const api =
    typeof window !== 'undefined' ? window.api?.appAdvisor : undefined;
  return api?.initialLayout ?? 'full';
}

export const useAppAdvisorStore = create<AppAdvisorStore>((set, get) => ({
  open: false,
  layout: initialAppAdvisorLayout(),
  floatingSize: APP_ADVISOR_FLOATING_DEFAULT_SIZE,
  minimized: false,
  bounds: null,
  pendingQuestions: [],
  appAdvisorModel: DEFAULT_APP_ADVISOR_MODEL,
  appAdvisorThinkingLevel: 'high',
  appAdvisorPluginSelections: normalizeAppAdvisorPluginSelections(undefined),
  appAdvisorDefaultInterfaceMode: 'canopy',
  applyPreferences: (prefs): void => {
    set({
      appAdvisorModel: prefs.appAdvisorModel,
      appAdvisorThinkingLevel: prefs.appAdvisorThinkingLevel,
      appAdvisorPluginSelections: normalizeAppAdvisorPluginSelections(
        prefs.appAdvisorPluginSelections,
      ),
      appAdvisorDefaultInterfaceMode:
        prefs.defaultAppAdvisorInterfaceMode ?? 'canopy',
    });
  },
  hydrateForNavigation: async (): Promise<void> => {
    try {
      const prefs = await window.api.loadPreferences();
      const appAdvisorModel =
        prefs.appAdvisorModel ?? DEFAULT_APP_ADVISOR_MODEL;
      const appAdvisorThinkingLevel = prefs.appAdvisorThinkingLevel ?? 'high';
      const appAdvisorPluginSelections = normalizeAppAdvisorPluginSelections(
        prefs.appAdvisorPluginSelections,
      );
      const appAdvisorDefaultInterfaceMode =
        prefs.defaultAppAdvisorInterfaceMode ?? 'canopy';
      const effectiveAppAdvisorInterfaceMode =
        getEffectiveClaudeChatInterfaceMode(appAdvisorDefaultInterfaceMode);
      get().applyPreferences({
        appAdvisorModel,
        appAdvisorThinkingLevel,
        appAdvisorPluginSelections,
        defaultAppAdvisorInterfaceMode: appAdvisorDefaultInterfaceMode,
      });

      // Aggregate: list Work Entries and hydrate each entry's tab metadata
      // into the read-only mirror. No sentinel slice is involved.
      const listResponse = await window.api.workEntries.list({
        projectId: APP_ADVISOR_PROJECT_ID,
      });
      await Promise.all(
        listResponse.entries.map((entry) =>
          useChatStore
            .getState()
            .loadTabsForTarget(APP_ADVISOR_PROJECT_ID, entry.id, {
              model: appAdvisorModel,
              thinkingLevel: appAdvisorThinkingLevel,
              pluginSelections: appAdvisorPluginSelections,
              defaultChatInterfaceMode: effectiveAppAdvisorInterfaceMode,
            })
            .catch(() => undefined),
        ),
      );
      markAppAdvisorReadIfFocused(
        useNavigationStore.getState().appAdvisorFocused,
      );
    } catch {
      // Preference/entry loading is best-effort; nav-status derivation falls
      // back to "no App Advisor activity" until the next attempt.
    }
  },
  syncWindowState: (state): void => {
    const layout = state.layout ?? 'full';
    set({
      open: state.open,
      layout,
      floatingSize: state.floatingSize ?? APP_ADVISOR_FLOATING_DEFAULT_SIZE,
      minimized: state.minimized === true,
    });
    const mainWindowOpen = state.mainWindowOpen !== false;
    useNavigationStore.setState((nav) => ({
      appAdvisorOpen: state.open,
      appAdvisorFocused: state.open && state.focused,
      appAdvisorMainWindowOpen: mainWindowOpen,
      appAdvisorMainWindowDownCount: mainWindowOpen
        ? nav.appAdvisorMainWindowDownCount
        : nav.appAdvisorMainWindowDownCount + 1,
    }));
    useCurrentUiStateStore
      .getState()
      .updateSlice('appAdvisor.dialogOpen', state.open);
    useCurrentUiStateStore
      .getState()
      .updateSlice('appAdvisor.dialogLayout', layout);
    if (state.open && state.focused) {
      // Becoming focused (re-)clears App Advisor unread across entries. The
      // chat-store helper's `__chatStoreSurface` guard decides whether this
      // clear is persisted (popout renderer) or in-memory only (main).
      markAppAdvisorReadIfFocused(state.focused);
    }
  },
  openDialog: (): void => {
    void window.api.appAdvisor
      .openWindow({ focus: true, focusComposer: true })
      .then((state) => get().syncWindowState(state))
      .catch(() => undefined);
  },
  expandDialog: (): void => {
    // The Orchestrator page experiment opens the page in the main window;
    // otherwise the separate window, as before.
    const layout = getLabsFeatureEnabled(ORCHESTRATOR_PAGE_EXPERIMENT_ID)
      ? 'docked'
      : 'full';
    void window.api.appAdvisor
      .openWindow({ layout, focus: true })
      .then((state) => get().syncWindowState(state))
      .catch(() => undefined);
  },
  closeDialog: (): void => {
    // Hide-only: do NOT call `dismissAllQuestions()` here. Pending
    // questions, transcripts, and sessions must survive a user-visible
    // close because the BrowserWindow remains alive in main.
    void window.api.appAdvisor
      .closeWindow()
      .then((state) => get().syncWindowState(state))
      .catch(() => undefined);
  },
  minimizeDialog: (): void => {
    // Hide-only, like closeDialog; the main window then shows the bubble.
    void window.api.appAdvisor
      .closeWindow({ minimize: true })
      .then((state) => get().syncWindowState(state))
      .catch(() => undefined);
  },
  setFloatingSize: (size): void => {
    void window.api.appAdvisor
      .setFloatingSize(size)
      .then((state) => get().syncWindowState(state))
      .catch(() => undefined);
  },
  toggleDialog: (): void => {
    void window.api.appAdvisor
      .toggleWindow({ focus: true })
      .then((state) => get().syncWindowState(state))
      .catch(() => undefined);
  },
  setBounds: (bounds): void => {
    set({ bounds });
    void window.api
      .savePreferences({ appAdvisorDialogBounds: bounds })
      .catch(() => {
        // Persisting bounds is best-effort.
      });
  },
  askUserQuestion: (
    requestId,
    question,
    chatId,
  ): Promise<AppAdvisorAskUserAnswer | null> => {
    // Re-asks for an already-answered requestId resolve immediately with
    // the cached answer so tool handlers stay idempotent across retries
    // and across hide/show cycles.
    if (cachedQuestionAnswers.has(requestId)) {
      return Promise.resolve(cachedQuestionAnswers.get(requestId) ?? null);
    }
    // Ensure the App Advisor window is visible so the question is
    // actually reachable for the user. Hidden-create is insufficient
    // here: ask-user is an explicit prompt for human input.
    void window.api.appAdvisor
      .openWindow({ focus: true })
      .catch(() => undefined);
    return new Promise((resolve) => {
      const existingResolvers = pendingQuestionResolvers.get(requestId);
      if (existingResolvers) {
        existingResolvers.push(resolve);
        return;
      }
      pendingQuestionResolvers.set(requestId, [resolve]);
      set((s) => {
        // Idempotency: if a card is already mounted for this requestId,
        // don't append a duplicate.
        const exists = s.pendingQuestions.some(
          (entry) => entry.requestId === requestId,
        );
        if (exists) return {};
        return {
          pendingQuestions: [
            ...s.pendingQuestions,
            { requestId, question, ...(chatId ? { chatId } : {}) },
          ],
        };
      });
    });
  },
  answerQuestion: (requestId, answer): void => {
    const resolvers = pendingQuestionResolvers.get(requestId) ?? [];
    pendingQuestionResolvers.delete(requestId);
    rememberCachedQuestionAnswer(requestId, answer);
    set((s) => ({
      pendingQuestions: s.pendingQuestions.filter(
        (entry) => entry.requestId !== requestId,
      ),
    }));
    for (const resolve of resolvers) {
      resolve(answer);
    }
  },
  dismissQuestion: (requestId): void => {
    const resolvers = pendingQuestionResolvers.get(requestId) ?? [];
    pendingQuestionResolvers.delete(requestId);
    rememberCachedQuestionAnswer(requestId, null);
    set((s) => ({
      pendingQuestions: s.pendingQuestions.filter(
        (entry) => entry.requestId !== requestId,
      ),
    }));
    for (const resolve of resolvers) {
      resolve(null);
    }
  },
  dismissAllQuestions: (): void => {
    for (const requestId of Array.from(pendingQuestionResolvers.keys())) {
      rememberCachedQuestionAnswer(requestId, null);
    }
    for (const resolvers of Array.from(pendingQuestionResolvers.values())) {
      for (const resolve of resolvers) {
        resolve(null);
      }
    }
    pendingQuestionResolvers.clear();
    set({ pendingQuestions: [] });
  },
  readEnvelopeAfterFlush: async (): Promise<AppAdvisorUiStateEnvelope> => {
    await Promise.resolve();
    return useCurrentUiStateStore.getState().getEnvelope();
  },
  openDocked: (request): void => {
    void window.api.appAdvisor
      .openWindow({
        ...request,
        layout: 'docked',
        focus: true,
        focusComposer: request === undefined,
      })
      .then((state) => get().syncWindowState(state))
      .catch((error: unknown) => {
        reportClientAppError(error);
      });
  },
  openSeparateWindow: (): void => {
    void window.api.appAdvisor
      .openWindow({ layout: 'full', focus: true })
      .then((state) => get().syncWindowState(state))
      .catch((error: unknown) => {
        reportClientAppError(error);
      });
  },
}));
