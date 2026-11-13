import {
  LoadingRegion,
  Button,
  DiffComparisonToggle,
  DiffTurnUnavailableState,
  DiffViewModeToggle,
  HeaderActionButton,
  Notice,
  NoticeButton,
} from '@canopy/ui-shared/components';
import { RefreshSpinner } from '@/components/shared/loading/spinners/RefreshSpinner';
import { brandText } from '@/lib/brand';
import {
  findFileTitle,
  useFilePreviewFindController,
} from '@canopy/ui-app/find';
import { mergeFileReviewComments } from './mergeFileReviewComments';
import { useReviewComments } from '../code-review/useReviewComments';
import type { editor as MonacoEditorTypes } from 'monaco-editor';
import { ReviewLinePopover } from '../code-review/ReviewLinePopover';
import { useWorktreeReview } from '../code-review/useWorktreeReview';
import { submitWorkspaceComments } from './submitWorkspaceComments';
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Descendant } from 'slate';
import type { PortalFileReadPayload } from '@canopy/protocol/portal';
import { documentPreviewMaxBytes } from '@canopy/protocol/document-preview';
import {
  fileViewerKey,
  useFileViewerStore,
  useFileViewerStoreApi,
} from '@canopy/app-state';
import {
  FileViewer,
  isRichDocumentRenderKind,
  resolveFileRenderKind,
  type FileEditorSlot,
  type FileViewerProps,
  type FileRichDocumentSlot,
} from '@canopy/ui-app';
import type { OfficePreviewCopy } from '@canopy/ui-rich/office';
import type {
  FileTabViewMode,
  FileTreeRoot,
} from '@canopy/desktop-shared/types';
import type {
  ReviewAnnotation,
  ReviewCommentAnchor,
} from '@canopy/desktop-shared/types';
import {
  FileChangeMetadata,
  ErrorBanner,
  ErrorState,
  SettingsSelect,
} from '@canopy/ui-shared/components';
import type { FileImageSaveSupport } from '@canopy/protocol/file-image-save';
import { desktopDiagramSaveDestination } from '@/lib/diagramSaveDestination';
import {} from '@canopy/ui-shared/components';
import { useChatStore, useChatTabRenderState } from '@/stores/chatStore';
import {
  isTurnDiffUnavailable,
  useFileDiffSnapshot,
} from './useFileDiffSnapshot';
import type { FileDiffContext } from '@canopy/desktop-shared/types/code-review';
import {
  ExternalIcon,
  FolderIcon,
  GlobeIcon,
  MessageIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { useAgentFilePresentationStore } from '@/stores/agentFilePresentationStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useFileTabUiStore } from '@/stores/fileTabUiStore';
import { hasActiveSetupRun, useScriptsStore } from '@/stores/scriptsStore';
import { desktopFileSessionController } from '@/lib/file-viewer/desktop-file-session-controller';
import { resolveDesktopDocumentBytes } from '@/lib/file-viewer/desktop-document-bytes';
import { createDesktopOfficeWorker } from '@/lib/file-viewer/desktop-office-worker';
import { resolveDesktopPdfPreviewAssets } from '@/lib/pdf-preview-assets';
import { copyTextToClipboard } from '@/lib/clipboard';
import {
  INSERT_CHAT_TEXT_EVENT,
  resolveSelectionTargetTabId,
  type AddEditorSelectionDetail,
  type InsertChatTextDetail,
} from '@/lib/editorSelectionContext';
import { pt } from '@/lib/platform-text';
import { uiText } from '@/lib/ui-text';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import {
  FILE_PREVIEW_SEARCH_EVENT,
  isFilePreviewSearchEventDetail,
} from '@/lib/filePreviewSearchEvents';
import { getMonacoLanguage } from './file-language';
import {
  getChangedFileSources,
  useOpenFileDiffTarget,
} from './useOpenFileDiffTarget';
import { useActivityStore } from '@/stores/activityStore';
import { useTabScrollPosition } from './useTabScrollPosition';
import { useFileComments } from './useFileComments';
import { useWorkspaceIsReadOnly } from '@/lib/workspace-access';
import {
  isLocalFileActionAvailable,
  OPEN_EXTERNAL_FILE_FAILED,
  REVEAL_FILE_FAILED,
  resolveLocalFileActionRequest,
} from '@/lib/file-reveal';
import { openFileInBrowserPanel } from '@/lib/openFileInBrowserPanel';
import { FileCommentsDrawer } from './FileCommentsDrawer';
import { FileSelectionMenu } from './FileSelectionMenu';
import { showsStandaloneFileCommentMarker } from './file-comment-markers';
import { FilePathBreadcrumb } from './FilePathBreadcrumb';
import { requestFilePanelPlacementAsSibling } from '@/lib/panels/chat-panel-sync';
import { ReviewCommentPopover } from '@/components/code-review/ReviewCommentPopover';
import type {
  EditorSelectionRange,
  FileEditorCommentSelection,
  SelectionCaptureTarget,
} from './MonacoFileEditor';
import { resolveRichSelectionLines } from './resolveRichSelectionLines';
import { isWebCoreScope } from '@/lib/chat-authority';
import { workspaceFileSourceFor } from '@/lib/files/workspace-file-source';
import {
  resolveFileSetupRetryPlan,
  resolveFileSetupRetryState,
  type FileSetupRetryState,
} from './file-setup-retry';
import { Tooltip } from '@canopy/ui-shared';

function isSelectableDiffSource(
  value: string,
): value is 'uncommitted' | 'committed' | 'combined' {
  return (
    value === 'uncommitted' || value === 'committed' || value === 'combined'
  );
}

const SETUP_RUN_START_GRACE_MS = 10_000;

const LazyPdfPreview = lazy(() =>
  import('@canopy/ui-app/pdf-preview').then((module) => ({
    default: module.FindablePdfPreview,
  })),
);

const LazyDocxPreview = lazy(() =>
  import('@canopy/ui-rich/office').then((module) => ({
    default: module.DocxPreview,
  })),
);
const LazyXlsxPreview = lazy(() =>
  import('@canopy/ui-rich/office').then((module) => ({
    default: module.XlsxPreview,
  })),
);
const LazyPptxPreview = lazy(() =>
  import('@canopy/ui-rich/office').then((module) => ({
    default: module.PptxPreview,
  })),
);
const SUPPORTED_DOCUMENT_KINDS = [
  'pdf',
  'docx',
  'xlsx',
  'pptx',
  'video',
] as const;

const MonacoFileEditor = lazy(() =>
  import('./MonacoFileEditor').then((module) => ({
    default: module.MonacoFileEditor,
  })),
);

const MonacoFileDiff = lazy(() =>
  import('./MonacoFileDiff').then((module) => ({
    default: module.MonacoFileDiff,
  })),
);
const DiffMediaView = lazy(() =>
  import('../activity/DiffContentView').then((module) => ({
    default: module.DiffContentView,
  })),
);

type PreserveMountedChangeHandler = (
  tabId: string,
  shouldPreserve: boolean,
) => void;

export interface DesktopSharedFileViewerProps {
  tabId: string;
  projectId: string;
  worktreeId: string;
  filePath: string;
  viewMode: FileTabViewMode;
  active: boolean;
  searchShortcutActive?: boolean;
  /** Explicit Branch-from file tabs remain eligible after git-ready. */
  recheckAfterWorktreeSetup?: boolean;
  onPreserveMountedChange?: PreserveMountedChangeHandler;
  /**
   * Host-owned controls appended at the very end of the viewer's header row
   * (after the view-mode toggle), e.g. the embedded file-tree toggle.
   */
  trailingHeaderActions?: ReactNode;
}

type FileCommentPopoverState =
  | {
      mode: 'selection' | 'compose';
      anchorRect: DOMRect;
      anchor: ReviewCommentAnchor;
      annotation?: ReviewAnnotation;
    }
  | { mode: 'line'; side: 'old' | 'new'; line: number; anchorRect: DOMRect }
  | { mode: 'thread'; anchorRect: DOMRect; threadId: string }
  | { mode: 'annotation'; anchorRect: DOMRect; annotationId: string };

function pathInsideRoot(filePath: string, rootPath: string): string | null {
  const caseInsensitive =
    /^[a-z]:[\\/]/i.test(rootPath) ||
    rootPath.startsWith('\\\\') ||
    rootPath.startsWith('//');
  const normalize = (value: string): string =>
    (caseInsensitive ? value.replace(/\\/g, '/') : value).replace(/\/+$/, '');
  const normalizedFilePath = normalize(filePath);
  const root = normalize(rootPath);
  const comparableFilePath = caseInsensitive
    ? normalizedFilePath.toLowerCase()
    : normalizedFilePath;
  const comparableRoot = caseInsensitive ? root.toLowerCase() : root;
  if (comparableFilePath === comparableRoot) return '';
  const prefix = `${root}/`;
  const comparablePrefix = `${comparableRoot}/`;
  return comparableFilePath.startsWith(comparablePrefix)
    ? normalizedFilePath.slice(prefix.length)
    : null;
}

function DesktopSharedFileViewerImpl({
  tabId,
  projectId,
  worktreeId,
  filePath,
  viewMode,
  active,
  searchShortcutActive = active,
  recheckAfterWorktreeSetup = false,
  onPreserveMountedChange,
  trailingHeaderActions,
}: DesktopSharedFileViewerProps): JSX.Element {
  const [request, setRequest] = useState<PortalFileReadPayload | null>(null);
  const [resolvedRoot, setResolvedRoot] = useState<FileTreeRoot | null>(null);
  const [imageSaveSupport, setImageSaveSupport] = useState<
    FileImageSaveSupport | undefined
  >(undefined);
  const [error, setError] = useState<string | null>(null);
  // Read-only scopes (a shared-container recipient) get the read-only viewer:
  // no editor, no comment authoring, no Show in Finder / Open in.
  const readOnly = useWorkspaceIsReadOnly();
  // A cloud chat's sandbox files resolve through the web core, and the OS
  // can't reveal, open or render them (CAN-6175 R9).
  const localFiles = workspaceFileSourceFor(worktreeId).onThisComputer;
  // Main keeps file comments, review artifacts and git diffs for local
  // worktrees only, so a cloud file has none of them yet.
  const commentsAvailable = !readOnly && localFiles;
  const setFileTabViewMode = useChatStore((state) => state.setFileTabViewMode);
  const openFileTab = useChatStore((state) => state.openFileTab);
  const createEmptyFileTab = useChatStore((state) => state.createEmptyFileTab);
  const refreshFile = useFileViewerStore((state) => state.openFile);
  const project = useProjectsStore(
    useShallow((state) =>
      state.projects.find((candidate) => candidate.id === projectId),
    ),
  );
  const worktree =
    project && project.type !== 'cowork'
      ? project.worktrees.find((candidate) => candidate.id === worktreeId)
      : undefined;
  const worktreeSetupPhase = worktree?.setupPhase;
  const worktreeSetupFailed = worktree?.healthIssue?.code === 'git-error';
  const worktreeRuns = useScriptsStore(
    useShallow((state) => state.runs[`${projectId}/${worktreeId}`]),
  );
  const hasActiveSetup = hasActiveSetupRun(worktreeRuns);
  const setupRetryEligibleRef = useRef(recheckAfterWorktreeSetup);
  if (
    recheckAfterWorktreeSetup ||
    worktreeSetupPhase === 'git-pending' ||
    hasActiveSetup
  ) {
    setupRetryEligibleRef.current = true;
  }
  const diffTarget = useOpenFileDiffTarget(
    projectId,
    worktreeId,
    filePath,
    localFiles,
  );
  const storedDiffContext = useChatTabRenderState(
    { projectId, worktreeId, chatId: tabId },
    ({ tab }) => tab?.fileDiffContext,
  );
  const changedFiles = useActivityStore(
    (state) => state.changedFiles[`${projectId}/${worktreeId}`],
  );
  const requestedDiffContext = useMemo<FileDiffContext | undefined>(
    () =>
      storedDiffContext ??
      (diffTarget
        ? {
            path: diffTarget.file.path,
            ...(diffTarget.file.repoId
              ? { repoId: diffTarget.file.repoId }
              : {}),
            ...(diffTarget.file.previousPath
              ? { previousPath: diffTarget.file.previousPath }
              : {}),
            source: diffTarget.source,
          }
        : undefined),
    [storedDiffContext, diffTarget],
  );
  const availableDiffSources = useMemo(
    () =>
      changedFiles && requestedDiffContext
        ? getChangedFileSources(changedFiles, requestedDiffContext)
        : undefined,
    [changedFiles, requestedDiffContext],
  );
  const diffContext = useMemo(() => {
    if (
      !requestedDiffContext ||
      !availableDiffSources ||
      requestedDiffContext.source === 'turn' ||
      requestedDiffContext.source === 'combined' ||
      availableDiffSources.includes(requestedDiffContext.source)
    )
      return requestedDiffContext;
    // Git refresh can move a file from uncommitted to committed while its tab stays open.
    const fallback: FileDiffContext = {
      ...requestedDiffContext,
      source: availableDiffSources[0] ?? 'combined',
    };
    return fallback;
  }, [requestedDiffContext, availableDiffSources]);
  const diffViewState = useRef<{
    split: boolean;
    snapshotId?: string;
    editor?: MonacoEditorTypes.IDiffEditorViewState | null;
  }>({ split: false });
  const [diffSplit, setDiffSplit] = useState(false);
  const [diffRevision, setDiffRevision] = useState(0);
  const { snapshot, error: diffError } = useFileDiffSnapshot(
    projectId,
    worktreeId,
    diffContext,
    viewMode === 'diff',
    diffRevision,
  );
  const turnUnavailable = isTurnDiffUnavailable(diffContext);
  const artifacts = useWorktreeReview(
    projectId,
    worktreeId,
    localFiles,
    active && viewMode === 'diff',
  );
  const availableAnnotations = useMemo(
    () =>
      artifacts.review?.annotations?.derivedFromFingerprint ===
      artifacts.fingerprint
        ? (artifacts.review?.annotations?.data?.annotations.filter(
            (annotation) =>
              annotation.filePath === diffContext?.path &&
              annotation.repoId === (diffContext.repoId ?? 'default'),
          ) ?? [])
        : [],
    [artifacts, diffContext?.path, diffContext?.repoId],
  );
  const annotations = useMemo(
    () => (diffContext?.source === 'combined' ? availableAnnotations : []),
    [availableAnnotations, diffContext?.source],
  );
  const fileComments = useFileComments(
    projectId,
    worktreeId,
    filePath,
    viewMode === 'diff' ? 'diff' : 'file',
    snapshot?.identity,
    annotations,
    localFiles,
  );
  const legacyComments = useReviewComments(
    { projectId, worktreeId },
    artifacts.review ?? null,
    (thread) =>
      thread.anchor.source === 'code' &&
      (thread.anchor.filePath === filePath ||
        (thread.anchor.filePath === diffContext?.path &&
          (thread.anchor.repoId ?? 'default') ===
            (diffContext?.repoId ?? 'default'))),
  );
  const comments = mergeFileReviewComments(fileComments, legacyComments);
  const [diffReveal, setDiffReveal] = useState<{
    anchor: ReviewCommentAnchor;
    revision: number;
  }>();
  const [commentPopover, setCommentPopover] =
    useState<FileCommentPopoverState | null>(null);
  useEffect(
    () => setCommentPopover(null),
    [viewMode, diffContext?.source, diffContext?.path],
  );
  const panelRootRef = useRef<HTMLDivElement>(null);
  const presentation = useAgentFilePresentationStore(
    (state) => state.byTabId[tabId],
  );
  const contentScrollPosition = useTabScrollPosition<HTMLElement>(tabId);
  // Cmd/Ctrl+F file mode (CAN-3048): the shared floating find bar searches
  // this preview through the shared headless preview search. Only searchable
  // previews register, so images and editable raw text (whose editor keeps
  // its own find) leave the shortcut alone. The hook unregisters while the
  // page host or panel tab is hidden, so the bar never outlives the preview.
  const fileFind = useFilePreviewFindController({
    // Shown panels register whether or not they are the active one, so a
    // file beside the active browser group still offers its toggle.
    enabled: active && viewMode !== 'diff',
    scopeKey: tabId,
    title: findFileTitle(filePath),
    rootRef: panelRootRef,
  });
  const previewSearchState = fileFind.state;
  const requestPreviewSearch = fileFind.viewerProps.onPreviewSearchRequest;
  // Projected once per state change: the reporter serializes its value on
  // every change of identity.
  const previewSearchReport = useMemo(
    () => ({ ...previewSearchState }),
    [previewSearchState],
  );
  useCurrentUiStateReporter(
    `files.previewSearch.${tabId}`,
    searchShortcutActive ? previewSearchReport : null,
  );
  useEffect(() => {
    if (!searchShortcutActive) return;
    const listener = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      if (!isFilePreviewSearchEventDetail(detail)) return;
      if (!previewSearchState.enabled) return;
      detail.acknowledge();
      requestPreviewSearch(detail.operation);
    };
    window.addEventListener(FILE_PREVIEW_SEARCH_EVENT, listener);
    return (): void =>
      window.removeEventListener(FILE_PREVIEW_SEARCH_EVENT, listener);
  }, [requestPreviewSearch, previewSearchState.enabled, searchShortcutActive]);
  const contentScrollBinding = useMemo(
    () => ({
      ref: (node: HTMLElement | null): void => {
        contentScrollPosition.scrollRef.current = node;
      },
      onScroll: contentScrollPosition.handleScroll,
      // Late-loading content (images, embedded markdown assets) grows the
      // scroll extents after mount; re-apply the persisted position then.
      onContentLoaded: contentScrollPosition.scheduleRestoreScrollPosition,
    }),
    [
      contentScrollPosition.handleScroll,
      contentScrollPosition.scheduleRestoreScrollPosition,
      contentScrollPosition.scrollRef,
    ],
  );

  useEffect(() => {
    let cancelled = false;
    setRequest(null);
    setResolvedRoot(null);
    setImageSaveSupport(undefined);
    setError(null);
    // A Branch-from destination is registered and selected during two-phase
    // creation, before its checkout directories are guaranteed to exist.
    // Keep the panel neutral and let the git-ready transition perform the
    // first root resolution instead of caching a transient missing failure.
    if (worktreeSetupPhase === 'git-pending') {
      return (): void => {
        cancelled = true;
      };
    }
    void workspaceFileSourceFor(worktreeId)
      .getFileTreeRoots({ projectId, worktreeId })
      .then(({ roots, imageSaveSupport: support }) => {
        if (cancelled) return;
        setImageSaveSupport(support);
        const match = roots
          .map((root) => ({
            root,
            relativePath: pathInsideRoot(filePath, root.absolutePath),
          }))
          .filter((candidate) => candidate.relativePath !== null)
          .sort(
            (left, right) =>
              right.root.absolutePath.length - left.root.absolutePath.length,
          )[0];
        if (!match || match.relativePath === null) {
          setError('File is outside the available project roots.');
          return;
        }
        const resolvedRequest: PortalFileReadPayload = {
          projectId,
          worktreeId,
          fileRootLocalId: match.root.repoId,
          relativePath: match.relativePath,
        };
        // Register this tab against the canonical shared session BEFORE the
        // viewer mounts and opens it. Registration is reference-counted per
        // canonical key and intentionally survives inactive-tab unmounts — the
        // chat-tab close path (releaseTab) is the sole owner of teardown.
        desktopFileSessionController.registerTab(tabId, resolvedRequest);
        setResolvedRoot(match.root);
        setRequest(resolvedRequest);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(
            reason instanceof Error ? reason.message : 'Unable to open file.',
          );
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, [filePath, projectId, tabId, worktreeId, worktreeSetupPhase]);

  const key = request ? fileViewerKey(request) : null;
  const session = useFileViewerStore((state) =>
    key ? state.files[key] : undefined,
  );
  const fileViewerStoreApi = useFileViewerStoreApi();
  const previousActiveRef = useRef(active);
  const setupRetryPlan = useMemo(
    () =>
      setupRetryEligibleRef.current
        ? resolveFileSetupRetryPlan(
            project,
            worktreeId,
            request?.fileRootLocalId ?? request?.repoId,
          )
        : null,
    [project, request?.fileRootLocalId, request?.repoId, worktreeId],
  );
  const resolvedSetupRetryState = resolveFileSetupRetryState(
    setupRetryPlan,
    worktreeRuns,
  );
  const setupCompletionRun = setupRetryPlan
    ? worktreeRuns?.[setupRetryPlan.completionScriptKey]
    : undefined;
  const setupPrerequisiteRun = setupRetryPlan?.prerequisiteScriptKey
    ? worktreeRuns?.[setupRetryPlan.prerequisiteScriptKey]
    : undefined;
  const [setupWaitExpired, setSetupWaitExpired] = useState(false);
  const setupRetryState =
    worktreeSetupFailed ||
    (resolvedSetupRetryState === 'waiting' && setupWaitExpired)
      ? 'finished'
      : resolvedSetupRetryState;
  const [setupRecheckPending, setSetupRecheckPending] = useState(false);
  const [imageRetryGeneration, setImageRetryGeneration] = useState(0);
  const [documentRetryGeneration, setDocumentRetryGeneration] = useState(0);
  const previousSetupRetryStateRef =
    useRef<FileSetupRetryState>('not-applicable');
  const setupRetryJustFinished =
    previousSetupRetryStateRef.current === 'waiting' &&
    setupRetryState === 'finished';
  const setupRetryScope = `${projectId}/${worktreeId}/${filePath}`;
  const sessionMissing = session?.error?.startsWith('File not found:') === true;
  const renderKind = resolveFileRenderKind({
    path: request?.relativePath ?? filePath,
  });
  const rendersAsImage = renderKind === 'image';
  const rendersAsHtml = renderKind === 'html';
  const rendersAsDocument = isRichDocumentRenderKind(renderKind);
  const officePreviewCopy = useMemo<OfficePreviewCopy>(
    () => ({
      banner: pt(uiText.officePreview.banner),
      truncationRecovery: pt(uiText.officePreview.truncationRecovery),
    }),
    [],
  );
  // Reveal and default-app opening are offered for any previewable file with
  // a local path in a writable scope. Main applies each route's authorization;
  // scoped reveal also canonicalizes the path against the workspace roots.
  const localFileRequest = useMemo(
    () =>
      localFiles
        ? resolveLocalFileActionRequest({
            absolutePath: filePath,
            surfaceScope: { projectId, worktreeId },
            surfaceReadOnly: readOnly,
          })
        : undefined,
    [filePath, localFiles, projectId, readOnly, worktreeId],
  );
  // Keyed by the file so a failure never follows the tab to another file.
  const localActionScope = `${projectId}/${worktreeId}/${filePath}`;
  const [localActionError, setLocalActionError] = useState<{
    scope: string;
    message: string;
  } | null>(null);
  const localActionGeneration = useRef(0);
  useEffect(() => {
    setLocalActionError(null);
    return (): void => {
      localActionGeneration.current += 1;
    };
  }, [localActionScope]);
  const canRevealFile = isLocalFileActionAvailable('showInFinder');
  const canOpenExternalFile = isLocalFileActionAvailable('openExternalFile');
  const runLocalFileAction = useCallback(
    (action: 'reveal' | 'open-external'): void => {
      if (!localFileRequest) return;
      if (action === 'reveal' ? !canRevealFile : !canOpenExternalFile) return;
      const generation = ++localActionGeneration.current;
      setLocalActionError(null);
      const pending =
        action === 'reveal'
          ? window.api.showInFinder(localFileRequest)
          : window.api.openExternalFile(localFileRequest);
      pending.catch(() => {
        if (generation !== localActionGeneration.current) return;
        setLocalActionError({
          scope: localActionScope,
          message:
            action === 'reveal'
              ? REVEAL_FILE_FAILED
              : OPEN_EXTERNAL_FILE_FAILED,
        });
      });
    },
    [canOpenExternalFile, canRevealFile, localActionScope, localFileRequest],
  );
  const openOriginalFile = useCallback((): void => {
    runLocalFileAction('reveal');
  }, [runLocalFileAction]);
  const openFileExternally = useCallback((): void => {
    runLocalFileAction('open-external');
  }, [runLocalFileAction]);
  const visibleLocalActionError =
    localActionError?.scope === localActionScope
      ? localActionError.message
      : undefined;

  useEffect(() => {
    setSetupWaitExpired(false);
    setSetupRecheckPending(false);
    previousSetupRetryStateRef.current = 'not-applicable';
  }, [setupRetryScope]);

  useEffect(() => {
    const prerequisiteStatus = setupPrerequisiteRun?.status;
    if (
      resolvedSetupRetryState !== 'waiting' ||
      (!sessionMissing && !rendersAsDocument) ||
      worktreeSetupPhase === 'git-pending' ||
      worktreeSetupFailed ||
      setupWaitExpired ||
      setupCompletionRun !== undefined ||
      hasActiveSetup ||
      prerequisiteStatus === 'running' ||
      prerequisiteStatus === 'stopping'
    ) {
      return;
    }

    // Main resolves scripts again from the checked-out worktree. If that
    // resolution skips a renderer-predicted setup script, no run event exists
    // to end the friendly missing-file state. Allow the event a short grace
    // period, then perform the final one-shot read instead of spinning forever.
    const timeoutId = window.setTimeout(() => {
      setSetupWaitExpired(true);
    }, SETUP_RUN_START_GRACE_MS);
    return (): void => window.clearTimeout(timeoutId);
  }, [
    resolvedSetupRetryState,
    rendersAsDocument,
    sessionMissing,
    hasActiveSetup,
    setupCompletionRun,
    setupPrerequisiteRun?.status,
    setupRetryScope,
    setupWaitExpired,
    worktreeSetupFailed,
    worktreeSetupPhase,
  ]);

  useEffect(() => {
    const previous = previousSetupRetryStateRef.current;
    previousSetupRetryStateRef.current = setupRetryState;
    if (previous === 'waiting' && setupRetryState === 'finished') {
      if (rendersAsDocument) {
        setDocumentRetryGeneration((generation) => generation + 1);
      } else if (rendersAsImage) {
        setImageRetryGeneration((generation) => generation + 1);
      } else {
        // Keep the friendly loading state through the final read. If the first
        // read is still in flight, the effect below waits for it to settle
        // before issuing this setup-complete recheck, avoiding an in-flight
        // dedup race.
        setSetupRecheckPending(true);
      }
    }
  }, [rendersAsDocument, rendersAsImage, setupRetryState]);

  useEffect(() => {
    if (!setupRecheckPending || !request || !session) return;
    if (session.status === 'loading' || session.status === 'saving') return;
    if (!sessionMissing) {
      setSetupRecheckPending(false);
      return;
    }

    // Consume the one-shot latch before openFile synchronously publishes its
    // loading session. Otherwise that new session identity cleans up this
    // effect before the refresh settles and leaves the latch armed forever.
    setSetupRecheckPending(false);
    void refreshFile(request);
  }, [refreshFile, request, session, sessionMissing, setupRecheckPending]);

  // Selection → composer capture (CAN-1250). The editor reports the exact
  // selected range; this host attaches the file/repo identity and the live
  // session's revision state (dirty buffer, confirmed mtime) and stages it
  // directly on the target chat tab. Staging goes through the store — not a
  // visible-composer event — because the default panel layout tabs the editor
  // and the composer into the same leaf, so the composer is usually hidden
  // while the user is selecting text in the editor.
  const requestRef = useRef(request);
  requestRef.current = request;
  const onAddSelectionToChat = useMemo(
    () =>
      (range: EditorSelectionRange): SelectionCaptureTarget | null => {
        const currentRequest = requestRef.current;
        if (!currentRequest) return null;
        const chat = useChatStore.getState();
        const worktreeChat = chat.worktreeChats[`${projectId}/${worktreeId}`];
        if (!worktreeChat) return null;
        // Prefer the active chat tab, then the explicitly tracked last
        // editable chat, then the first editable chat tab — legacy persisted
        // files predate `lastActiveEditableChatId`, and a silent no-op while
        // chat tabs exist reads as "Send to Chat does nothing".
        const targetTabId = resolveSelectionTargetTabId({
          tabs: worktreeChat.tabs,
          activeTabId: worktreeChat.activeTabId,
          ...(worktreeChat.lastActiveEditableChatId
            ? {
                lastActiveEditableChatId: worktreeChat.lastActiveEditableChatId,
              }
            : {}),
        });
        if (targetTabId === null) return null;
        const targetTab = worktreeChat.tabs.find(
          (tab) => tab.id === targetTabId,
        );
        if (!targetTab) return null;
        const sessionKey = fileViewerKey(currentRequest);
        const currentSession = fileViewerStoreApi.getState().files[sessionKey];
        const detail: AddEditorSelectionDetail = {
          projectId,
          worktreeId,
          absolutePath: filePath,
          displayPath: currentRequest.relativePath,
          ...(currentRequest.fileRootLocalId
            ? { repoId: currentRequest.fileRootLocalId }
            : {}),
          startLine: range.startLine,
          startColumn: range.startColumn,
          endLine: range.endLine,
          endColumn: range.endColumn,
          text: range.text,
          ...(currentSession?.preview?.language
            ? { language: currentSession.preview.language }
            : {}),
          capturedDirty: currentSession?.dirty ?? false,
          ...(currentSession?.preview?.modifiedAt
            ? { capturedModifiedAt: currentSession.preview.modifiedAt }
            : {}),
        };
        chat.addPendingEditorSelection(targetTabId, detail);
        return { tabId: targetTabId, title: targetTab.title };
      },
    [fileViewerStoreApi, filePath, projectId, worktreeId],
  );

  // The capture confirmation names its destination chat and offers a jump to
  // it — the composer is usually hidden behind this same panel leaf.
  const onShowSelectionTarget = useMemo(
    () =>
      (targetTabId: string): void => {
        useChatStore.getState().switchTab(targetTabId);
      },
    [],
  );

  const canInsertIntoTargetChat = useChatStore((state) => {
    const worktreeChat = state.worktreeChats[`${projectId}/${worktreeId}`];
    return (
      worktreeChat !== undefined &&
      resolveSelectionTargetTabId(worktreeChat) !== null
    );
  });

  // Appends text to this worktree's selection-target chat composer (the
  // same chat Send to Chat uses) and switches to that chat. Existing draft
  // text is kept; nothing is sent. Returns false when no chat can take it.
  const insertIntoTargetChat = useCallback(
    (text: string): boolean => {
      const chat = useChatStore.getState();
      const worktreeChat = chat.worktreeChats[`${projectId}/${worktreeId}`];
      if (!worktreeChat) return false;
      const targetTabId = resolveSelectionTargetTabId({
        tabs: worktreeChat.tabs,
        activeTabId: worktreeChat.activeTabId,
        ...(worktreeChat.lastActiveEditableChatId
          ? {
              lastActiveEditableChatId: worktreeChat.lastActiveEditableChatId,
            }
          : {}),
      });
      if (targetTabId === null) return false;
      let handled = false;
      const detail: InsertChatTextDetail = {
        text,
        targetTabId,
        markHandled: (): void => {
          handled = true;
        },
      };
      document.dispatchEvent(
        new CustomEvent(INSERT_CHAT_TEXT_EVENT, { detail }),
      );
      // A composer can be absent while its tab is in an unmounted panel.
      // Preserve the old saved-draft path strictly as a fallback; mounted
      // composers must update their live Slate value so the insertion cannot
      // be overwritten by their next draft save.
      if (!handled) {
        const currentDraft = chat.getTabDraft(targetTabId) ?? [];
        const block: Descendant = {
          type: 'paragraph',
          children: [{ text }],
        };
        chat.saveTabDraft(targetTabId, [...currentDraft, block]);
      }
      chat.switchTab(targetTabId, { projectId, worktreeId });
      return true;
    },
    [projectId, worktreeId],
  );

  const sendSelectionToChat = useCallback((): void => {
    if (commentPopover?.mode !== 'selection') return;
    if (!insertIntoTargetChat(commentPopover.anchor.quote)) return;
    setCommentPopover(null);
  }, [commentPopover, insertIntoTargetChat]);

  // CAN-5362: drafts a follow-up for an overlapping passage. It only adds
  // text to the composer; the comparison, choices and buffer are untouched.
  const onAskToKeepEdits = useCallback(
    (prompt: string): void => {
      insertIntoTargetChat(prompt);
    },
    [insertIntoTargetChat],
  );

  useEffect(() => {
    const wasActive = previousActiveRef.current;
    previousActiveRef.current = active;
    if (!active || wasActive || !request) return;
    // A video re-read would reload up to 100 MiB and reset playback position.
    if (renderKind === 'video') return;
    if (rendersAsDocument) {
      setDocumentRetryGeneration((generation) => generation + 1);
    } else {
      void refreshFile(request);
    }
  }, [active, refreshFile, renderKind, rendersAsDocument, request]);

  const resolveDocumentBytes = useMemo<
    NonNullable<FileViewerProps['resolveDocumentBytes']>
  >(
    () =>
      (_request, signal): ReturnType<typeof resolveDesktopDocumentBytes> =>
        resolveDesktopDocumentBytes(
          () =>
            window.api.readFileDocumentBytes({
              absolutePath: filePath,
              workspaceTarget: { projectId, worktreeId },
            }),
          signal,
          documentPreviewMaxBytes(filePath),
        ),
    [filePath, projectId, worktreeId],
  );
  const renderRichDocument = useCallback(
    ({
      bytes,
      displayName,
      onRenderFailure,
      renderKind: slotKind,
    }: FileRichDocumentSlot): JSX.Element => (
      <Suspense fallback={<LoadingRegion layout="fill" />}>
        {slotKind === 'docx' ? (
          <LazyDocxPreview
            bytes={bytes}
            fileName={displayName}
            createWorker={createDesktopOfficeWorker}
            copy={officePreviewCopy}
            onRenderFailure={onRenderFailure}
          />
        ) : slotKind === 'xlsx' ? (
          <LazyXlsxPreview
            bytes={bytes}
            fileName={displayName}
            createWorker={createDesktopOfficeWorker}
            copy={officePreviewCopy}
            onRenderFailure={onRenderFailure}
          />
        ) : slotKind === 'pptx' ? (
          <LazyPptxPreview
            bytes={bytes}
            fileName={displayName}
            createWorker={createDesktopOfficeWorker}
            copy={officePreviewCopy}
            onRenderFailure={onRenderFailure}
          />
        ) : (
          <LazyPdfPreview
            bytes={bytes}
            fileName={displayName}
            onRenderFailure={onRenderFailure}
            resolveAssets={resolveDesktopPdfPreviewAssets}
          />
        )}
      </Suspense>
    ),
    [officePreviewCopy],
  );

  const resolveFileReference = useMemo(
    () =>
      (href: string): ReturnType<typeof window.api.resolveFileReference> =>
        // The web core resolves transcript links only, never markdown-relative ones.
        isWebCoreScope(worktreeId)
          ? Promise.resolve(null)
          : window.api.resolveFileReference({
              projectId,
              worktreeId,
              baseFilePath: filePath,
              href,
            }),
    [filePath, projectId, worktreeId],
  );

  const onOpenRelativePath = useMemo(
    () =>
      (href: string): void => {
        void resolveFileReference(href).then((resolved) => {
          if (resolved) {
            if (resolved.kind === 'directory') {
              const directoryTabId = createEmptyFileTab({
                projectId,
                worktreeId,
              });
              if (directoryTabId !== null) {
                requestFilePanelPlacementAsSibling(directoryTabId, tabId);
                useFileTabUiStore
                  .getState()
                  .openDirectoryInFileTree(
                    directoryTabId,
                    resolved.absolutePath,
                  );
              }
              return;
            }
            openFileTab(
              {
                absolutePath: resolved.absolutePath,
                filename: resolved.filename,
              },
              { projectId, worktreeId },
            );
          }
        });
      },
    [
      createEmptyFileTab,
      openFileTab,
      projectId,
      resolveFileReference,
      tabId,
      worktreeId,
    ],
  );

  // Diagram pictures are created beside the document when this scope can
  // write and main advertises create-only image saves; otherwise they download.
  const diagramSaveDestination = useMemo(
    () =>
      desktopDiagramSaveDestination({
        projectId,
        worktreeId,
        filePath,
        support: imageSaveSupport,
        readOnly,
        saveFileContent: (saveRequest) =>
          window.api.saveFileContent(saveRequest),
        openFile: (file) => openFileTab(file, { projectId, worktreeId }),
      }),
    [filePath, imageSaveSupport, openFileTab, projectId, readOnly, worktreeId],
  );

  const resolveAssetSrc = useMemo(
    () =>
      async (src: string): Promise<string | null> => {
        const resolved = await resolveFileReference(src);
        if (!resolved) return null;
        const result = await workspaceFileSourceFor(worktreeId).readFileContent(
          {
            absolutePath: resolved.absolutePath,
            workspaceTarget: { projectId, worktreeId },
          },
        );
        return result.kind === 'image' ? result.content : null;
      },
    [projectId, resolveFileReference, worktreeId],
  );

  const resolveHtmlAsset = useMemo<
    NonNullable<FileViewerProps['resolveHtmlAsset']>
  >(
    () =>
      async (
        src,
      ): Promise<
        Awaited<ReturnType<NonNullable<FileViewerProps['resolveHtmlAsset']>>>
      > => {
        const resolved = await resolveFileReference(src);
        if (!resolved || resolved.kind !== 'file') return null;
        return {
          identity: resolved.absolutePath,
          read: async (): Promise<string | null> => {
            const result = await workspaceFileSourceFor(
              worktreeId,
            ).readFileContent({
              absolutePath: resolved.absolutePath,
              workspaceTarget: { projectId, worktreeId },
            });
            return result.kind === 'image' ? result.content : null;
          },
        };
      },
    [projectId, resolveFileReference, worktreeId],
  );

  const resolveImageSrc = useMemo(
    () => async (): Promise<string | null> => {
      const result = await workspaceFileSourceFor(worktreeId).readFileContent({
        absolutePath: filePath,
        workspaceTarget: { projectId, worktreeId },
      });
      return result.kind === 'image' ? result.content : null;
    },
    [filePath, projectId, worktreeId],
  );

  const shouldPreserve =
    session?.preview?.language === 'html' &&
    (session.preview.truncated || viewMode === 'preview');
  useEffect(() => {
    onPreserveMountedChange?.(tabId, shouldPreserve);
    return (): void => onPreserveMountedChange?.(tabId, false);
  }, [onPreserveMountedChange, shouldPreserve, tabId]);

  useEffect(() => {
    if (
      viewMode === 'raw' ||
      presentation?.line === undefined ||
      !session?.preview?.content
    ) {
      return;
    }
    const scrollNode = contentScrollPosition.scrollRef.current;
    if (!scrollNode) return;
    const rawLineCount = session.preview.content.split(/\r?\n/).length;
    const ratio =
      rawLineCount <= 1
        ? 0
        : (presentation.line - 1) / Math.max(1, rawLineCount - 1);
    const frameId = requestAnimationFrame(() => {
      const maxScrollTop = Math.max(
        0,
        scrollNode.scrollHeight - scrollNode.clientHeight,
      );
      scrollNode.scrollTop = Math.min(1, Math.max(0, ratio)) * maxScrollTop;
    });
    return (): void => cancelAnimationFrame(frameId);
  }, [
    contentScrollPosition.scrollRef,
    presentation?.line,
    presentation?.revision,
    session?.preview?.content,
    viewMode,
  ]);

  const openSelectionComposer = useCallback(
    (selection: FileEditorCommentSelection | null): void => {
      if (!selection || !commentsAvailable) {
        setCommentPopover((current) =>
          current?.mode === 'selection' ? null : current,
        );
        return;
      }
      setCommentPopover({
        mode: 'selection',
        anchorRect: selection.anchorRect,
        anchor: {
          source: 'code',
          filePath,
          side: 'new',
          lineStart: selection.lineStart,
          lineEnd: selection.lineEnd,
          quote: selection.quote,
        },
      });
    },
    [commentsAvailable, filePath],
  );

  const handleRichSelection = useCallback((): void => {
    if (viewMode === 'raw' || viewMode === 'diff' || rendersAsDocument) return;
    const selection = window.getSelection();
    const container = contentScrollPosition.scrollRef.current;
    if (
      !selection ||
      selection.isCollapsed ||
      !container ||
      !selection.anchorNode ||
      !container.contains(selection.anchorNode)
    ) {
      return;
    }
    const quote = selection.toString().trim();
    const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    const raw = session?.preview?.content ?? '';
    if (!quote || !range || !raw) return;
    const lines = resolveRichSelectionLines(raw, quote);
    const rect = range.getBoundingClientRect();
    setCommentPopover({
      mode: 'selection',
      anchorRect: rect,
      anchor: {
        source: 'code',
        filePath,
        side: 'new',
        quote,
        ...(lines ?? { unanchored: true }),
      },
    });
  }, [
    contentScrollPosition.scrollRef,
    filePath,
    session?.preview?.content,
    viewMode,
    rendersAsDocument,
  ]);

  const openThread = useCallback(
    (threadId: string, anchorRect: DOMRect): void => {
      setCommentPopover({ mode: 'thread', threadId, anchorRect });
    },
    [],
  );

  const openAnnotation = useCallback(
    (annotationId: string, anchorRect: DOMRect): void => {
      setCommentPopover({ mode: 'annotation', annotationId, anchorRect });
    },
    [],
  );

  const revealAnchor = useCallback(
    (anchor: ReviewCommentAnchor): void => {
      if (anchor.view === 'diff') {
        if (!diffContext) return;
        const identity = anchor.diff;
        setFileTabViewMode(
          tabId,
          'diff',
          { projectId, worktreeId },
          {
            ...diffContext,
            ...(identity
              ? {
                  source: identity.source,
                  ...(identity.startTree
                    ? { startTree: identity.startTree }
                    : {}),
                  ...(identity.endTree ? { endTree: identity.endTree } : {}),
                }
              : {}),
          },
        );
        setDiffReveal({ anchor, revision: Date.now() });
        return;
      }
      if (viewMode === 'diff')
        setFileTabViewMode(tabId, 'raw', { projectId, worktreeId });
      if (anchor.lineStart === undefined) return;
      useAgentFilePresentationStore.getState().present(tabId, {
        line: anchor.lineStart,
      });
    },
    [tabId, diffContext, projectId, worktreeId, setFileTabViewMode, viewMode],
  );

  const submitFileComments = useCallback((): void => {
    void comments.submit((message, context) =>
      submitWorkspaceComments({ projectId, worktreeId }, message, context),
    );
  }, [comments, projectId, worktreeId]);

  const renderEditor = useMemo(
    () =>
      (slot: FileEditorSlot): JSX.Element => (
        <Suspense
          fallback={
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <LoadingRegion layout="fill" />
            </div>
          }
        >
          <MonacoFileEditor
            tabId={tabId}
            filePath={filePath}
            language={getMonacoLanguage(slot.filePath, slot.language)}
            value={slot.value}
            onChange={slot.onChange}
            // The shared viewer composes host links with its own reveals
            // (an overlapping passage), so Monaco follows the slot.
            presentation={
              slot.reveal
                ? {
                    revision: slot.reveal.revision ?? 0,
                    line: slot.reveal.line,
                    ...(slot.reveal.lineEnd !== undefined
                      ? { lineEnd: slot.reveal.lineEnd }
                      : {}),
                  }
                : undefined
            }
            revealReady={slot.revealReady}
            annotations={comments.document.annotations}
            commentThreads={comments.document.commentThreads}
            onSelectionComment={openSelectionComposer}
            onOpenAnnotation={openAnnotation}
            onOpenCommentThread={openThread}
            onAddSelectionToChat={onAddSelectionToChat}
            onShowSelectionTarget={onShowSelectionTarget}
          />
        </Suspense>
      ),
    [
      comments.document.annotations,
      comments.document.commentThreads,
      filePath,
      openAnnotation,
      openSelectionComposer,
      openThread,
      onAddSelectionToChat,
      onShowSelectionTarget,
      tabId,
    ],
  );

  // Files picked in the breadcrumb menu open as this tab's SIBLING (same
  // panel group, right after it); already-open files only activate — the
  // sync bridge drops placement hints for tabs whose panel exists.
  const openFileAsSibling = useCallback(
    (file: { absolutePath: string; filename: string }): void => {
      const openedTabId = useChatStore
        .getState()
        .openFileTab(file, { projectId, worktreeId });
      if (openedTabId !== null) {
        requestFilePanelPlacementAsSibling(openedTabId, tabId);
      }
    },
    [projectId, tabId, worktreeId],
  );

  const renderPathBreadcrumb = useMemo(
    () =>
      resolvedRoot
        ? (path: string): ReactNode => (
            <FilePathBreadcrumb
              projectId={projectId}
              worktreeId={worktreeId}
              root={resolvedRoot}
              relativePath={path}
              onOpenFile={openFileAsSibling}
            />
          )
        : undefined,
    [openFileAsSibling, projectId, resolvedRoot, worktreeId],
  );

  // Every header action shares one quiet toolbar control so the row reads as
  // a single set: view controls first (diff, then the viewer's own source
  // toggle), then ways to open the file elsewhere, then panel chrome. Only the
  // diff toggle keeps visible text, because its counts are data.
  const existingDiffHeaderAction =
    diffTarget || viewMode === 'diff' || storedDiffContext ? (
      <HeaderActionButton
        tone="neutral"
        stateStyle="toolbar"
        tooltipLabel={
          viewMode === 'diff'
            ? 'Return to raw file'
            : "View this file's changes"
        }
        onClick={(): void => {
          setCommentPopover(null);
          setFileTabViewMode(
            tabId,
            viewMode === 'diff' ? 'raw' : 'diff',
            { projectId, worktreeId },
            diffContext,
          );
        }}
        aria-label="View diff"
        aria-pressed={viewMode === 'diff'}
        data-testid="file-viewer-view-diff"
      >
        {diffTarget ? (
          <FileChangeMetadata
            insertions={diffTarget.file.insertions}
            deletions={diffTarget.file.deletions}
            status={diffTarget.file.status}
          />
        ) : (
          'Diff'
        )}
        {comments.otherViewCount > 0 && (
          <span
            className="flex items-center gap-1"
            aria-label={`${comments.otherViewCount} open comments in ${viewMode === 'diff' ? 'file' : 'diff'} view`}
          >
            <MessageIcon size={12} />
            {comments.otherViewCount}
          </span>
        )}
      </HeaderActionButton>
    ) : null;
  const openInBrowserHeaderAction = rendersAsHtml ? (
    <HeaderActionButton
      iconOnly
      tone="neutral"
      stateStyle="toolbar"
      aria-label="Open in browser"
      tooltipLabel="Open this page in the browser"
      onClick={(): void => {
        void openFileInBrowserPanel(projectId, worktreeId, filePath);
      }}
      data-testid="file-viewer-open-in-browser"
    >
      <GlobeIcon aria-hidden="true" />
    </HeaderActionButton>
  ) : null;
  const localFileHeaderActions =
    localFileRequest && (canRevealFile || canOpenExternalFile) ? (
      <div
        className="flex shrink-0 items-center gap-1"
        data-testid="file-viewer-local-actions"
      >
        {canRevealFile && (
          <HeaderActionButton
            iconOnly
            tone="neutral"
            stateStyle="toolbar"
            aria-label={pt(uiText.fileManager.openItem)}
            onClick={openOriginalFile}
            data-testid="file-viewer-open-original"
          >
            <FolderIcon aria-hidden="true" />
          </HeaderActionButton>
        )}
        {canOpenExternalFile && (
          <HeaderActionButton
            iconOnly
            tone="neutral"
            stateStyle="toolbar"
            aria-label="Open in default app"
            onClick={openFileExternally}
            data-testid="file-viewer-open-external"
          >
            <ExternalIcon aria-hidden="true" />
          </HeaderActionButton>
        )}
      </div>
    ) : null;
  const localActionErrorNotice = visibleLocalActionError ? (
    <div className="mx-1 min-w-0 max-w-64">
      <ErrorBanner
        error={visibleLocalActionError}
        className=""
        testId="file-viewer-local-action-error"
      />
    </div>
  ) : null;
  const headerActions = existingDiffHeaderAction;
  // After the viewer's source toggle, ahead of the host's panel chrome.
  const openElsewhereActions =
    openInBrowserHeaderAction ||
    localActionErrorNotice ||
    localFileHeaderActions ? (
      <>
        {localActionErrorNotice}
        {openInBrowserHeaderAction}
        {localFileHeaderActions}
      </>
    ) : null;
  const composedTrailingHeaderActions =
    openElsewhereActions || trailingHeaderActions != null ? (
      <>
        {openElsewhereActions}
        {trailingHeaderActions}
      </>
    ) : undefined;
  const rawLineCount = session?.preview?.content
    ? session.preview.content.split(/\r?\n/).length
    : 0;
  const threadedAnnotationIds = new Set(
    comments.document.commentThreads.flatMap((thread) =>
      thread.anchor.annotationId ? [thread.anchor.annotationId] : [],
    ),
  );
  const richMarkers = [
    ...comments.document.annotations.map((annotation) => ({
      id: annotation.id,
      kind: threadedAnnotationIds.has(annotation.id)
        ? ('thread' as const)
        : ('annotation' as const),
      startLine: annotation.lineStart,
      endLine: annotation.lineEnd,
      title: annotation.title,
      threadId: comments.document.commentThreads.find(
        (thread) => thread.anchor.annotationId === annotation.id,
      )?.id,
    })),
    ...comments.document.commentThreads.flatMap((thread) =>
      showsStandaloneFileCommentMarker(thread)
        ? [
            {
              id: thread.id,
              kind: 'thread' as const,
              startLine: thread.anchor.lineStart,
              endLine: thread.anchor.lineEnd ?? thread.anchor.lineStart,
              title: 'File comment thread',
              threadId: thread.id,
            },
          ]
        : [],
    ),
  ];
  const richAnnotationMarkers =
    viewMode !== 'raw' && rawLineCount > 0 && richMarkers.length ? (
      // The strip overlays the scroll container from outside it, so it must
      // stay beside that container's scrollbar rail and let pointer input
      // through everywhere but its marker buttons. Covering the rail stops the
      // thumb from being dragged and swallows wheel input (CAN-3518).
      <div
        className="pointer-events-none absolute bottom-3 right-[var(--canopy-scrollbar-rail-size)] top-14 z-20 w-2"
        aria-label="File annotations"
        data-testid="file-annotation-markers"
      >
        {richMarkers.map((marker) => {
          const startRatio =
            rawLineCount <= 1 ? 0 : (marker.startLine - 1) / (rawLineCount - 1);
          const endRatio =
            rawLineCount <= 1
              ? startRatio
              : (marker.endLine - 1) / (rawLineCount - 1);
          return (
            // The positioned span owns the gutter geometry (the tooltip
            // wrapper is `relative`); the marker button fills it.
            <span
              key={marker.id}
              className="pointer-events-auto absolute right-0 flex min-h-1 w-2"
              style={{
                top: `${Math.min(100, Math.max(0, startRatio * 100))}%`,
                height: `${Math.max(1, (endRatio - startRatio) * 100)}%`,
              }}
            >
              <Tooltip label={marker.title} className="h-full w-full">
                <button
                  type="button"
                  aria-label={marker.title}
                  onClick={(event): void => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    if (marker.kind === 'thread' && marker.threadId) {
                      openThread(marker.threadId, rect);
                    } else {
                      openAnnotation(marker.id, rect);
                    }
                  }}
                  className="focus-ring h-full w-full min-h-1 rounded-full bg-accent shadow-sm hover:opacity-80"
                />
              </Tooltip>
            </span>
          );
        })}
      </div>
    ) : null;
  const activeThread =
    commentPopover?.mode === 'thread'
      ? comments.document.commentThreads.find(
          (thread) => thread.id === commentPopover.threadId,
        )
      : undefined;
  const activeAnnotation =
    commentPopover?.mode === 'annotation'
      ? comments.document.annotations.find(
          (annotation) => annotation.id === commentPopover.annotationId,
        )
      : commentPopover?.mode === 'compose'
        ? commentPopover.annotation
        : undefined;
  const activeAnnotationThread = activeAnnotation
    ? comments.document.commentThreads.find(
        (thread) => thread.anchor.annotationId === activeAnnotation.id,
      )
    : undefined;

  // Session replay records the viewer chrome (path header, diff toolbar,
  // status). The file content blocks itself: `FileViewer` blocks its bodies,
  // and the Monaco editor, Monaco diff, and diff view each carry a block.
  if (error) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <ErrorState space="panel" message={error} />
      </div>
    );
  }
  if (!request) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <LoadingRegion layout="fill" />
      </div>
    );
  }
  return (
    <div
      ref={panelRootRef}
      className="relative flex min-h-0 w-full min-w-0 flex-1 flex-col outline-none"
      {...fileFind.surfaceProps}
      onMouseUp={commentsAvailable ? handleRichSelection : undefined}
    >
      <div
        className="relative min-h-0 w-full min-w-0 flex-1 overflow-hidden"
        data-testid="file-viewer-annotation-surface"
      >
        <FileViewer
          active={active}
          appName={brandText.appName}
          {...(readOnly || !canInsertIntoTargetChat
            ? {}
            : { onAskToKeepEdits })}
          searchShortcutActive={searchShortcutActive}
          {...fileFind.viewerProps}
          request={request}
          revealLine={
            presentation?.line !== undefined
              ? {
                  line: presentation.line,
                  ...(presentation.lineEnd !== undefined
                    ? { lineEnd: presentation.lineEnd }
                    : {}),
                  revision: presentation.revision,
                }
              : undefined
          }
          {...(readOnly ? {} : { renderEditor })}
          // CAN-5004: the file's own project, not the navigation mode, picks
          // the vocabulary; the viewer still falls back to Source when the
          // file cannot be edited.
          rawViewLabel={project?.type === 'cowork' ? 'edit' : 'source'}
          viewMode={viewMode === 'diff' ? 'raw' : viewMode}
          alternateContent={
            viewMode === 'diff' ? (
              <div
                className="flex min-h-0 flex-1 flex-col"
                data-testid="file-panel-diff"
              >
                {diffContext && (
                  <div
                    className="flex flex-wrap items-center gap-2 px-3 py-1 text-xs fg-secondary ring-1 ring-inset ring-line-base"
                    data-testid="file-diff-toolbar"
                  >
                    {diffContext.source === 'turn' ? (
                      <span>Historical turn comparison</span>
                    ) : (
                      <SettingsSelect
                        width="fit"
                        aria-label="Diff source"
                        value={diffContext.source}
                        onValueChange={(source): void => {
                          if (!isSelectableDiffSource(source)) return;
                          setFileTabViewMode(
                            tabId,
                            'diff',
                            { projectId, worktreeId },
                            { ...diffContext, source },
                          );
                        }}
                        options={[
                          ...(!availableDiffSources ||
                          availableDiffSources.includes('uncommitted')
                            ? [{ value: 'uncommitted', label: 'Uncommitted' }]
                            : []),
                          ...(!availableDiffSources ||
                          availableDiffSources.includes('committed')
                            ? [{ value: 'committed', label: 'Committed' }]
                            : []),
                          { value: 'combined', label: 'All branch changes' },
                        ]}
                      />
                    )}
                    {availableAnnotations.length > 0 &&
                      (diffContext.source === 'combined' ? (
                        <span>{availableAnnotations.length} annotations</span>
                      ) : (
                        <Button
                          variant="link"
                          onClick={() =>
                            setFileTabViewMode(
                              tabId,
                              'diff',
                              { projectId, worktreeId },
                              { ...diffContext, source: 'combined' },
                            )
                          }
                        >
                          View {availableAnnotations.length} annotations in all
                          changes
                        </Button>
                      ))}
                    <div className="ml-auto flex items-center gap-2">
                      {diffContext.startTree && diffContext.endTree && (
                        <DiffComparisonToggle
                          value={diffContext.source === 'turn' ? 'turn' : 'all'}
                          onChange={(comparison) =>
                            setFileTabViewMode(
                              tabId,
                              'diff',
                              { projectId, worktreeId },
                              {
                                ...diffContext,
                                source:
                                  comparison === 'turn' ? 'turn' : 'combined',
                              },
                            )
                          }
                          dataTestId="file-diff-comparison"
                        />
                      )}
                      <DiffViewModeToggle
                        value={diffSplit ? 'split' : 'unified'}
                        onChange={(mode) => setDiffSplit(mode === 'split')}
                        dataTestId="file-diff-layout"
                      />
                    </div>
                    <HeaderActionButton
                      iconOnly
                      tone="neutral"
                      aria-label="Refresh diff"
                      onClick={() => setDiffRevision((value) => value + 1)}
                    >
                      <RefreshSpinner
                        spinning={!snapshot && !diffError && !turnUnavailable}
                      />
                    </HeaderActionButton>
                  </div>
                )}

                {diffError ? (
                  <div className="shrink-0 p-4">
                    <Notice
                      intent="destructive"
                      className=""
                      actions={
                        <NoticeButton
                          variant="primary"
                          onClick={() => setDiffRevision((value) => value + 1)}
                        >
                          Try again
                        </NoticeButton>
                      }
                    >
                      {diffError}
                    </Notice>
                  </div>
                ) : !diffContext ? (
                  <p className="p-4 text-xs fg-secondary">
                    No comparison is available for this file.
                  </p>
                ) : turnUnavailable ? (
                  <DiffTurnUnavailableState
                    action={
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          setFileTabViewMode(
                            tabId,
                            'diff',
                            { projectId, worktreeId },
                            { ...diffContext, source: 'combined' },
                          )
                        }
                      >
                        Show all branch changes
                      </Button>
                    }
                  />
                ) : !snapshot ? (
                  <LoadingRegion layout="fill" />
                ) : (
                  <Suspense fallback={<LoadingRegion layout="fill" />}>
                    {snapshot.data.binary || snapshot.data.imagePreview ? (
                      <DiffMediaView
                        {...snapshot.data}
                        loading={false}
                        viewMode={diffSplit ? 'split' : 'unified'}
                      />
                    ) : (
                      <MonacoFileDiff
                        tabId={`${projectId}/${worktreeId}/${tabId}`}
                        filePath={filePath}
                        snapshot={snapshot}
                        viewState={diffViewState}
                        split={diffSplit}
                        onSplitChange={setDiffSplit}
                        annotations={comments.document.annotations}
                        onOpenLine={(side, line, anchorRect): void => {
                          if (!commentsAvailable) return;
                          setCommentPopover({
                            mode: 'line',
                            side,
                            line,
                            anchorRect,
                          });
                        }}
                        threads={comments.document.commentThreads}
                        onComment={(anchor, anchorRect): void => {
                          if (!commentsAvailable) return;
                          setCommentPopover({
                            mode: 'selection',
                            anchor: { ...anchor, repoId: diffContext.repoId },
                            anchorRect,
                          });
                        }}
                        reveal={diffReveal}
                      />
                    )}
                  </Suspense>
                )}
              </div>
            ) : undefined
          }
          onViewModeChange={(mode): void => {
            setCommentPopover(null);
            setFileTabViewMode(tabId, mode, { projectId, worktreeId });
          }}
          headerActions={headerActions}
          {...(renderPathBreadcrumb ? { renderPathBreadcrumb } : {})}
          {...(composedTrailingHeaderActions !== undefined
            ? { trailingHeaderActions: composedTrailingHeaderActions }
            : {})}
          deferMissing={
            setupRetryState === 'waiting' ||
            setupRetryJustFinished ||
            setupRecheckPending
          }
          unsupportedFileActionGap="item"
          unsupportedFileAction={
            localFileRequest === undefined || !canRevealFile ? undefined : (
              <Button
                size="compact"
                onClick={openOriginalFile}
                data-testid="file-viewer-open-unsupported"
              >
                {pt(uiText.fileManager.openItem)}
              </Button>
            )
          }
          contentScrollBinding={contentScrollBinding}
          onOpenRelativePath={onOpenRelativePath}
          diagramSaveDestination={diagramSaveDestination}
          resolveAssetSrc={resolveAssetSrc}
          resolveHtmlAsset={resolveHtmlAsset}
          resolveImageSrc={resolveImageSrc}
          imageRetryGeneration={imageRetryGeneration}
          documentRetryGeneration={documentRetryGeneration}
          resolveDocumentBytes={localFiles ? resolveDocumentBytes : undefined}
          renderRichDocument={renderRichDocument}
          supportedDocumentKinds={SUPPORTED_DOCUMENT_KINDS}
          documentRecoveryHint={pt(uiText.officePreview.parseFailedRecovery)}
          documentDisplayName={
            filePath.replace(/\\/g, '/').split('/').pop() ?? filePath
          }
        />
        {!rendersAsDocument && viewMode !== 'diff' && richAnnotationMarkers}
      </div>
      {commentsAvailable && (!rendersAsDocument || viewMode === 'diff') && (
        <FileCommentsDrawer
          tabId={tabId}
          active={active}
          comments={comments}
          containerRef={panelRootRef}
          onSubmitStaged={submitFileComments}
          onRevealAnchor={revealAnchor}
          canRevealAnchor={(anchor): boolean =>
            anchor.view !== 'diff' || diffContext !== undefined
          }
        />
      )}
      {viewMode === 'diff' && commentPopover?.mode === 'line' && (
        <ReviewLinePopover
          anchorRect={commentPopover.anchorRect}
          annotations={comments.document.annotations.filter(
            (a) =>
              a.side === commentPopover.side &&
              a.lineStart === commentPopover.line,
          )}
          threads={comments.document.commentThreads.filter(
            (t) =>
              t.anchor.side === commentPopover.side &&
              t.anchor.lineStart === commentPopover.line &&
              t.anchorState === 'matched' &&
              t.status === 'open',
          )}
          onReply={comments.addReply}
          onToggleResolved={comments.toggleResolved}
          onEditStagedComment={comments.editStagedComment}
          onDeleteStagedComment={comments.deleteStagedComment}
          onDiscussAnnotation={(id) => {
            const annotation = comments.document.annotations.find(
              (a) => a.id === id,
            );
            if (annotation)
              setCommentPopover({
                mode: 'compose',
                anchorRect: commentPopover.anchorRect,
                annotation,
                anchor: {
                  source: 'code',
                  view: 'diff',
                  filePath,
                  side: annotation.side,
                  lineStart: annotation.lineStart,
                  lineEnd: annotation.lineEnd,
                  quote: '',
                  diff: snapshot?.identity,
                },
              });
          }}
          onClose={() => setCommentPopover(null)}
        />
      )}
      {(!rendersAsDocument || viewMode === 'diff') &&
        commentPopover?.mode === 'selection' && (
          <FileSelectionMenu
            anchorRect={commentPopover.anchorRect}
            onSendToChat={sendSelectionToChat}
            onCopy={(): Promise<boolean> =>
              copyTextToClipboard(commentPopover.anchor.quote)
            }
            onComment={(): void =>
              setCommentPopover({
                ...commentPopover,
                mode: 'compose',
              })
            }
            onClose={(): void => setCommentPopover(null)}
          />
        )}
      {(!rendersAsDocument || viewMode === 'diff') &&
        commentPopover?.mode === 'compose' && (
          <ReviewCommentPopover
            mode="compose"
            anchorRect={commentPopover.anchorRect}
            annotation={commentPopover.annotation}
            onSubmitComment={(body): void => {
              if (commentPopover.annotation) {
                comments.discussAnnotation(commentPopover.annotation, body);
              } else {
                comments.addComment(commentPopover.anchor, body);
              }
              setCommentPopover(null);
              window.getSelection()?.removeAllRanges();
            }}
            onClose={(): void => setCommentPopover(null)}
          />
        )}
      {(!rendersAsDocument || viewMode === 'diff') &&
        commentPopover?.mode === 'thread' &&
        activeThread && (
          <ReviewCommentPopover
            mode="thread"
            anchorRect={commentPopover.anchorRect}
            thread={activeThread}
            onReply={(body): void => comments.addReply(activeThread.id, body)}
            onToggleResolved={(): void =>
              comments.toggleResolved(activeThread.id)
            }
            onEditStagedComment={(commentId, body): void =>
              comments.editStagedComment(activeThread.id, commentId, body)
            }
            onDeleteStagedComment={(commentId): void =>
              comments.deleteStagedComment(activeThread.id, commentId)
            }
            onClose={(): void => setCommentPopover(null)}
          />
        )}
      {(!rendersAsDocument || viewMode === 'diff') &&
        commentPopover?.mode === 'annotation' &&
        activeAnnotation && (
          <ReviewCommentPopover
            mode="annotation"
            anchorRect={commentPopover.anchorRect}
            annotation={activeAnnotation}
            onDiscussAnnotation={(): void => {
              if (activeAnnotationThread) {
                setCommentPopover({
                  mode: 'thread',
                  anchorRect: commentPopover.anchorRect,
                  threadId: activeAnnotationThread.id,
                });
              } else {
                setCommentPopover({
                  mode: 'compose',
                  anchorRect: commentPopover.anchorRect,
                  annotation: activeAnnotation,
                  anchor: {
                    source: 'code',
                    filePath,
                    side: activeAnnotation.side,
                    lineStart: activeAnnotation.lineStart,
                    lineEnd: activeAnnotation.lineEnd,
                    quote: '',
                    annotationId: activeAnnotation.id,
                  },
                });
              }
            }}
            annotationSourceLabel="Agent highlight"
            annotationDiscussLabel={
              activeAnnotationThread ? 'View comments' : 'Comment'
            }
            onClearAnnotation={
              viewMode === 'diff'
                ? undefined
                : (): void => {
                    comments.dismissAnnotation(activeAnnotation.id);
                    setCommentPopover(null);
                  }
            }
            onClose={(): void => setCommentPopover(null)}
          />
        )}
    </div>
  );
}

export const DesktopSharedFileViewer = memo(DesktopSharedFileViewerImpl);
