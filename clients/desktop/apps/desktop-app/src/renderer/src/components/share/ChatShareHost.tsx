import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import {
  refreshChatShareData,
  useChatShareData,
} from '@/hooks/useChatShareData';
import { useShareAction } from '@/hooks/useShareAction';
import { resolveShareTarget } from '@/lib/invocableShareTarget';
import { openAccountSettingsFromRemoteControl } from '@/lib/navigation/remote-control-dialog';
import { trackShareDialogOpen } from '@/lib/shareDialogTelemetry';
import {
  loadPipelineShareTargetDocument,
  type AutomationPipelineDocumentResult,
} from '@/lib/pipelineDocument';
import { useGitHubStore } from '@/stores/githubStore';
import {
  notifyShareCompleted,
  reportSkillShareNudgeResolution,
  useShareRequestStore,
  type ShareRequest,
} from '@/stores/shareRequestStore';

const ShareSkillModal = lazy(() =>
  import('@/components/skills/ShareSkillModal').then((module) => ({
    default: module.ShareSkillModal,
  })),
);
const SharePipelineModal = lazy(() =>
  import('@/components/pipeline/SharePipelineModal').then((module) => ({
    default: module.SharePipelineModal,
  })),
);
const SharePluginModal = lazy(() =>
  import('@/components/plugins/SharePluginModal').then((module) => ({
    default: module.SharePluginModal,
  })),
);

export const SHARE_TARGET_UNRESOLVED_MESSAGE =
  "Couldn't open sharing for this item.";

/** The originating document while its window is still open, else the main one. */
function liveDocument(candidate: Document | undefined): Document {
  if (!candidate || candidate === document) return document;
  const view = candidate.defaultView;
  return view && !view.closed && candidate.body?.isConnected
    ? candidate
    : document;
}

/** Fires once when the lazily loaded dialog has actually mounted. */
function DialogOpened({ onOpened }: { onOpened: () => void }): null {
  const onOpenedRef = useRef(onOpened);
  onOpenedRef.current = onOpened;
  useEffect(() => {
    onOpenedRef.current();
  }, []);
  return null;
}

/** Each request owns its gate, so a replaced request cannot mount a late sign-in prompt. */
function ShareRequestGate({
  request,
  onPassed,
}: {
  request: ShareRequest;
  onPassed: (id: string) => void;
}): JSX.Element | null {
  const { share, shareGateModal } = useShareAction();
  const requestId = request.id;
  const requestKind = request.target.kind;
  useEffect(() => {
    let cancelled = false;
    share(
      requestKind,
      () => {
        if (
          cancelled ||
          useShareRequestStore.getState().request?.id !== requestId
        )
          return;
        onPassed(requestId);
      },
      () => {
        if (!cancelled) useShareRequestStore.getState().clearRequest(requestId);
      },
    );
    return (): void => {
      cancelled = true;
    };
  }, [onPassed, requestId, requestKind, share]);
  const gateOpen = shareGateModal !== null;
  const requestedElsewhere =
    request.ownerDocument !== undefined && request.ownerDocument !== document;
  useEffect(() => {
    if (gateOpen && requestedElsewhere) window.focus();
  }, [gateOpen, requestedElsewhere]);
  return shareGateModal;
}

/**
 * Serves chat-side share requests (CAN-3611): the artifact card, mention
 * details, the activity rail, the usage nudge and the agent action all ask
 * `shareRequestStore`, and this host opens the common skill or plugin dialog.
 *
 * It owns the sign-in gate, so a window without it (the App Advisor window)
 * offers no chat-side Share. Every asynchronous step is tied to the request
 * id: a newer request replaces the current one, and a stale gate, load or
 * callback can neither open nor clear its replacement.
 */
export function ChatShareHost(): JSX.Element {
  const request = useShareRequestStore((state) => state.request);
  const data = useChatShareData(request !== null);
  /** The request whose sign-in gate let it through. */
  const [gatePassedId, setGatePassedId] = useState<string | null>(null);
  /** Bumped when the originating window goes away, to re-pick the document. */
  const [, setDocumentEpoch] = useState(0);
  const openedTelemetryId = useRef<string | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const unregister = useShareRequestStore.getState().registerHost();
    return (): void => {
      mounted.current = false;
      unregister();
    };
  }, []);

  const requestId = request?.id ?? null;
  const requestKind = request?.target.kind ?? null;

  const gatePassed = requestId !== null && gatePassedId === requestId;

  // A pipeline tile's target is a saved-item locator: load the item as it is
  // now, per request, rather than resolving it from the installed inventory.
  const [pipelineLoad, setPipelineLoad] = useState<{
    requestId: string;
    result: AutomationPipelineDocumentResult;
  } | null>(null);
  const pipelineTarget =
    request && gatePassed && request.target.kind === 'pipeline'
      ? request.target
      : null;
  useEffect(() => {
    if (!pipelineTarget || requestId === null) return undefined;
    let cancelled = false;
    void loadPipelineShareTargetDocument(pipelineTarget).then((result) => {
      if (
        cancelled ||
        !mounted.current ||
        useShareRequestStore.getState().request?.id !== requestId
      )
        return;
      if (result.error !== undefined || !result.data) {
        useShareRequestStore.getState().clearRequest(requestId);
        useGitHubStore
          .getState()
          .addToast(SHARE_TARGET_UNRESOLVED_MESSAGE, 'error', undefined, {
            forceInApp: true,
          });
        return;
      }
      setPipelineLoad({ requestId, result });
    });
    return (): void => {
      cancelled = true;
    };
  }, [pipelineTarget, requestId]);

  const resolution = useMemo(
    () =>
      request && gatePassed && request.target.kind !== 'pipeline'
        ? resolveShareTarget(
            request.target,
            data.skillsSettled ? data.installedSkills : null,
            data.marketplacesSettled ? data.marketplaces : null,
          )
        : null,
    [
      data.installedSkills,
      data.marketplaces,
      data.skillsSettled,
      data.marketplacesSettled,
      gatePassed,
      request,
    ],
  );

  // A current request that cannot resolve says so once and is released. An
  // inventory that is still loading keeps waiting; one that failed to load
  // cannot resolve either.
  const unresolvable =
    resolution !== null &&
    (resolution.status === 'ineligible' ||
      (resolution.status === 'unknown' &&
        (requestKind === 'skill'
          ? data.skillsSettled
          : data.marketplacesSettled)));
  useEffect(() => {
    if (!unresolvable || requestId === null) return;
    if (useShareRequestStore.getState().request?.id !== requestId) return;
    useShareRequestStore.getState().clearRequest(requestId);
    useGitHubStore
      .getState()
      .addToast(SHARE_TARGET_UNRESOLVED_MESSAGE, 'error', undefined, {
        forceInApp: true,
      });
  }, [requestId, unresolvable]);

  // Fall back to the main window if the pop-out closes, including while the
  // dialog chunk or the inventory is still loading.
  const requestDocument = request?.ownerDocument;
  useEffect(() => {
    const view = requestDocument?.defaultView;
    if (!view || requestDocument === document) return;
    const repick = (): void => setDocumentEpoch((epoch) => epoch + 1);
    view.addEventListener('pagehide', repick);
    view.addEventListener('unload', repick);
    return (): void => {
      view.removeEventListener('pagehide', repick);
      view.removeEventListener('unload', repick);
    };
  }, [requestDocument]);

  const finish = useCallback((current: ShareRequest): void => {
    if (
      !mounted.current ||
      useShareRequestStore.getState().request?.id !== current.id
    )
      return;
    useShareRequestStore.getState().clearRequest(current.id);
    refreshChatShareData();
  }, []);

  const handleOpened = useCallback((current: ShareRequest): void => {
    if (
      !mounted.current ||
      useShareRequestStore.getState().request?.id !== current.id
    )
      return;
    if (openedTelemetryId.current === current.id) return;
    openedTelemetryId.current = current.id;
    trackShareDialogOpen(current.target.kind, current.source);
  }, []);

  const resolveCompletedNudge = useCallback((current: ShareRequest): void => {
    if (!current.origin || current.target.kind === 'pipeline') return;
    reportSkillShareNudgeResolution({
      ...current.origin,
      target: current.target,
      resolution: 'shared',
    });
  }, []);

  let dialog: JSX.Element | null = null;
  const loadedPipeline =
    request && pipelineLoad?.requestId === request.id
      ? pipelineLoad.result
      : null;
  if (request && loadedPipeline?.data) {
    const pipeline = loadedPipeline.data;
    const close = (): void => finish(request);
    // The dialog portals itself through DialogModal. The pipeline dialog has
    // no pop-out document support; it opens in the main window.
    dialog = (
      <Suspense key={`dialog-${request.id}`} fallback={null}>
        <DialogOpened onOpened={() => handleOpened(request)} />
        <SharePipelineModal
          pipeline={pipeline.content}
          localPipelineInfo={pipeline.info}
          {...(loadedPipeline.worktree
            ? { worktree: loadedPipeline.worktree }
            : {})}
          onClose={close}
          onOpenAccountSettings={() => {
            close();
            openAccountSettingsFromRemoteControl();
          }}
          onShared={() => {
            if (
              !mounted.current ||
              useShareRequestStore.getState().request?.id !== request.id
            )
              return;
            // The dialog stays open on its success notice; Done finishes
            // the request through `onClose`.
            notifyShareCompleted(request);
          }}
        />
      </Suspense>
    );
  } else if (request && resolution?.status === 'resolved') {
    const resolved = resolution.resolved;
    const target = liveDocument(request.ownerDocument);
    const ownerDocument = target === document ? undefined : target;
    const close = (): void => finish(request);
    const completed = (): void => {
      if (
        !mounted.current ||
        useShareRequestStore.getState().request?.id !== request.id
      )
        return;
      resolveCompletedNudge(request);
      // The dialog stays open on its success notice; Done finishes the
      // request through `onClose`, which refreshes the chat's share data.
      // Refreshing here would unsettle the inventory this dialog resolves
      // from and remount it without its success notice.
      notifyShareCompleted(request);
    };
    // Keyed by request so a replacement never inherits dialog state; the
    // `dialog-` prefix keeps the key apart from the gate's beside it. The
    // dialog portals itself (DialogModal) into `ownerDocument`, the window
    // the request came from.
    dialog = (
      <Suspense key={`dialog-${request.id}`} fallback={null}>
        <DialogOpened onOpened={() => handleOpened(request)} />
        {resolved.kind === 'skill' ? (
          <ShareSkillModal
            skill={resolved.skill}
            onClose={close}
            onOpenAccountSettings={() => {
              close();
              openAccountSettingsFromRemoteControl();
            }}
            onShared={completed}
            {...(ownerDocument ? { ownerDocument } : {})}
          />
        ) : (
          <SharePluginModal
            pluginRef={resolved.pluginRef}
            name={resolved.displayName}
            description={resolved.description}
            onClose={close}
            onShared={completed}
            {...(ownerDocument ? { ownerDocument } : {})}
          />
        )}
      </Suspense>
    );
  }

  return (
    <>
      {dialog}
      {request ? (
        <ShareRequestGate
          key={request.id}
          request={request}
          onPassed={setGatePassedId}
        />
      ) : null}
    </>
  );
}
