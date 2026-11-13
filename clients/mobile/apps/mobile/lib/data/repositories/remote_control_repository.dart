import 'dart:async';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_cached_chat_tail.dart';
import 'package:mobile/data/models/remote_pr.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/data/models/remote_control_exception.dart';
import 'package:mobile/data/models/remote_file_diff.dart';
import 'package:mobile/data/models/remote_file.dart';
import 'package:mobile/data/models/remote_pipeline_chat_follow_up.dart';
import 'package:mobile/data/models/remote_pipeline_run.dart';
import 'package:mobile/data/models/remote_session_predicates.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/mock_remote_project_clones.dart';
import 'package:mobile/data/repositories/mock_remote_watchers.dart';
import 'package:mobile/data/repositories/remote_watcher_commands.dart';
import 'package:mobile/data/repositories/remote_app_advisor_commands.dart';
import 'package:mobile/data/repositories/remote_composer_commands.dart';
import 'package:mobile/data/repositories/remote_response_commands.dart';
import 'package:mobile/data/repositories/remote_pairing_failure.dart';
import 'package:mobile/data/repositories/remote_pipeline_content_commands.dart';
import 'package:mobile/data/repositories/remote_project_commands.dart';
import 'package:mobile/data/repositories/remote_provider_usage_commands.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/portal_event_stream.dart';
import 'package:mobile/data/services/portal_read_client.dart';
import 'package:mobile/data/services/portal_file_client.dart';
import 'package:mobile/data/services/remote_control_api_service.dart';

export 'package:mobile/data/models/remote_control_exception.dart';

/// Contract for the mobile Remote Control ("Workspaces") feature: pair with a
/// desktop over the Portal relay, read the desktop's session shell state, and
/// chat with its agents.
///
/// This interface is the single seam where the Portal transport plugs in.
/// [MockRemoteControlRepository] backs demo mode and tests;
/// [HttpRemoteControlRepository] is the live transport over the browser
/// Portal routes (`/api/v1/desktop-app/portal/browser/*`).
abstract interface class RemoteControlRepository {
  RemoteWatcherCommands get watchers;

  /// Restores the user's existing Portal pairing, if the server still has an
  /// active session (`GET .../session`). Returns null when there is nothing
  /// to restore; never throws for the "no session" case.
  Future<RemoteConnection?> restoreSession();

  /// Refreshes metadata for the already-paired session without adopting a
  /// different session that may now be current for the account.
  Future<RemoteConnection?> refreshSessionMetadata();

  /// Reads the same session as [restoreSession], but distinguishes "the server
  /// says this pairing is gone" from "the server could not be asked".
  ///
  /// [restoreSession] deliberately collapses both into `null`: a restore that
  /// cannot reach the server should just fall back to the pairing form, and no
  /// harm is done if it was wrong. A caller that *drops the pairing* on the
  /// answer cannot afford that conflation — re-pairing needs the desktop, so
  /// a transient 5xx would strand a pairing that was about to heal — so it
  /// probes instead. See [RemoteSessionProbeOutcome].
  ///
  /// The read returns the account's current session, which can be another
  /// desktop's. While a session is held, a different one is
  /// [RemoteSessionProbeOutcome.unknown] and is not adopted (CAN-3624).
  Future<RemoteSessionProbe> probeSession();

  /// Pairs with a desktop using a 6-digit [pairingCode].
  ///
  /// Throws [RemoteControlException] on an invalid code or a failed handshake.
  Future<RemoteConnection> connect(String pairingCode);

  /// Ends the current pairing on the server and forgets it locally. Only the
  /// user's Disconnect action calls this. Safe to call when already
  /// disconnected.
  Future<void> disconnect();

  /// Forgets the current pairing on this phone only: its session identity,
  /// event cursor and capability gates, and stops live delivery. Leaves the
  /// server session alone, for when the server already reported it gone.
  void clearLocalSession();

  /// Fetches the current session snapshot (workspaces + worktrees +
  /// standalone chats + hydrated chat tabs/transcripts) from the paired
  /// desktop's projected state.
  Future<RemoteSessionSnapshot> fetchSnapshot();

  /// Live event batches for the paired session. Broadcast; quiescent until
  /// [resumeEvents] is called after a successful connect/restore + snapshot.
  Stream<RemotePortalEventBatch> get events;

  /// Whether live event delivery can currently reach this client. Broadcast;
  /// reports true once the server answers after [resumeEvents] and false while
  /// delivery waits to retry a connection that failed.
  Stream<bool> get eventsLive;

  /// Starts (or restarts) live event delivery from the last known cursor.
  /// No-op when not connected.
  void resumeEvents();

  /// Stops live event delivery, closing any held-open connection. Safe to
  /// call repeatedly; used when the app backgrounds.
  void pauseEvents();

  /// Stops live event delivery and forgets its cursor, so the next
  /// [fetchSnapshot] seeds it again and [resumeEvents] starts after that read
  /// instead of replaying every event missed since the last delivery.
  void discardEventCursor();

  /// Asks the desktop to project the given worktree's subtree (chat tabs,
  /// activity) into the session state. Fire-and-forget; results arrive as
  /// state events.
  Future<void> requestWorktreeState({
    required String workspaceLocalId,
    required String worktreeLocalId,
  });

  /// Reads the server's cached worktree-scoped state slices (changed files,
  /// summaries, plans, todos, script/hook/pipeline runs) for one worktree.
  /// The overview-scoped snapshot deliberately excludes these entity types,
  /// so the sidebar must read them through this scoped fetch. [refreshing]
  /// echoes the server's flag: the cache is cold or mid-refresh, so the
  /// slices are not authoritative yet.
  Future<({Map<String, dynamic> slices, bool refreshing})>
  fetchWorktreeStateSlices({
    required String workspaceLocalId,
    required String worktreeLocalId,
  });

  /// Reads only the `pipelines` scope of one worktree (descriptors and
  /// runs). On a cold server cache the server asks the desktop to project
  /// just that worktree's pipelines, never the full worktree.
  Future<({Map<String, dynamic> slices, bool refreshing})>
  fetchWorktreePipelineSlices({
    required String workspaceLocalId,
    required String worktreeLocalId,
  });

  /// Asks the desktop to project one chat's transcript into the session
  /// state. Results arrive as a state snapshot event carrying the messages.
  /// Returns its command id so asynchronous failures can be correlated.
  Future<String?> requestChatTranscript(RemoteChatTarget target);

  /// Best-effort cached rows for a known chat. This does not establish an
  /// authoritative empty transcript or advance the live event cursor.
  Future<List<RemoteChatMessage>> fetchCachedChatMessages(
    RemoteChatTarget target,
  );

  /// Cached rows with freshness evidence. Never advances the live stream's
  /// cursor; unrelated events still need delivery.
  Future<RemoteCachedChatTail> fetchCachedChatTail(RemoteChatTarget target);

  /// Sends a user message to the targeted chat. For worktree targets with a
  /// null `chatId` the desktop mints a new chat thread; the returned result
  /// echoes the canonical id.
  ///
  /// [options] carries composer selections and input metadata supported by the
  /// target's wire contract.
  Future<RemoteChatSendResult> sendChatMessage(
    RemoteChatTarget target,
    String text, {
    RemoteChatSendOptions? options,
  });

  /// True when the paired desktop can turn uploaded attachments into local
  /// files (`chat_attachments` capability). Composer gates the attach control.
  bool get supportsChatAttachments;

  /// Whether the paired desktop supports the standalone (Cowork) chat create
  /// handshake (`standalone_chat_create` capability). Standalone attachments
  /// and creating a chat before its first message require it; without it the
  /// first text send creates the chat. `chat_attachments` does not imply it.
  bool get supportsStandaloneChatCreate;

  /// Uploads one file for the current session and returns the ready ref to
  /// send as `cloudAttachments`. Throws [RemoteControlException] with the
  /// server's reason (too large, unsupported type, too many in flight).
  Future<ChatAttachmentRef> uploadChatAttachment({
    required String filename,
    required String mediaType,
    required Uint8List bytes,
  });

  /// Removes a not-yet-sent upload. Best-effort; failures are swallowed by
  /// callers because the server sweep reclaims orphans.
  Future<void> deleteChatAttachment(String attachmentId);

  /// Creates an empty chat tab on the desktop with a client-minted
  /// `target.chatId` (`portal.chat.create_tab`) — the same optimistic new-tab
  /// flow the web portal uses (CAN-1233). The desktop appends the tab through
  /// its renderer (the single tabs-file writer) and re-projects the summary.
  Future<String> createChatTab(RemoteWorktreeChatTarget target);

  Future<String> createStandaloneChat(RemoteStandaloneChatTarget target);

  /// Server permission for the existing Portal worktree archive command.
  bool get canArchiveWorktrees;

  /// Enqueues an archive; the returned command id is pending until a terminal event.
  Future<String> archiveWorktree({
    required String workspaceLocalId,
    required String worktreeLocalId,
  });

  /// Closes a tab through the desktop, which owns archiving and busy guards.
  Future<String> closeChatTab(RemoteWorktreeChatTarget target);

  /// Persists the chat's model without sending a message. Routes to
  /// `portal.chat.set_model` (worktree) or `portal.standalone_chat.set_model`.
  Future<String> setChatModel(RemoteChatTarget target, String model);

  /// Turns on Auto for a worktree chat: `portal.chat.set_model` with
  /// `selectionMode: 'auto'` and no model. Standalone chats have no Auto.
  Future<String> setChatAutoModel(RemoteWorktreeChatTarget target);

  bool get supportsPrActions;
  bool get supportsPrStatusPush;
  Future<RemotePortalCommandResult> runPrAction({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required RemotePrAction action,
    String? repoId,
    RemotePrActionIdentity? identity,
    bool confirmUnresolvedComments = false,
  });

  /// Capability announced by desktops that accept portal.chat.mark_read.
  bool get supportsChatMarkRead;

  /// Acknowledges displayed output without activating the desktop tab.
  Future<String> markChatRead(RemoteChatTarget target, String? lastMessageId);

  /// Toggles plan mode on a worktree chat (`portal.chat.set_plan_mode`).
  Future<String> setChatPlanMode(
    RemoteWorktreeChatTarget target,
    bool planMode,
  );

  /// Sets the thinking level on a worktree chat
  /// (`portal.chat.set_thinking_level`).
  Future<String> setChatThinkingLevel(
    RemoteWorktreeChatTarget target,
    String thinkingLevel,
  );

  /// Toggles Codex fast mode on a worktree chat (`portal.chat.set_fast_mode`).
  Future<String> setChatFastMode(
    RemoteWorktreeChatTarget target,
    bool fastMode,
  );

  /// Saves a chat's complete plugin selection without sending a message:
  /// `portal.chat.set_plugin_selections` for a worktree chat, and
  /// `portal.standalone_chat.set_plugin_selections` for a standalone chat on
  /// a desktop with the invocable inventory (CAN-3923).
  Future<String> setChatPluginSelections(
    RemoteChatTarget target,
    Map<String, Object?> selections,
  );

  /// Interrupts the chat's active run. Routes to `portal.chat.cancel`
  /// (worktree) or `portal.standalone_chat.cancel` (standalone).
  Future<String> cancelChat(RemoteChatTarget target);

  /// Answers an awaiting AskUserQuestion request on a worktree chat
  /// (`portal.chat.answer_question`). [answers] are sent raw; the desktop
  /// forwards them to the provider and redacts secrets before re-projecting.
  Future<String> answerChatQuestion(
    RemoteWorktreeChatTarget target, {
    required String requestId,
    required List<AskUserQuestionAnswer> answers,
  });

  /// Dismisses an awaiting AskUserQuestion request without answering
  /// (`portal.chat.dismiss_question`).
  Future<String> dismissChatQuestion(
    RemoteWorktreeChatTarget target, {
    required String requestId,
  });

  /// Asks the desktop to re-project the workspace/worktree overview
  /// (`portal.state.request` with `scope: 'overview'`, `refresh: true`).
  ///
  /// The server waits for this command to reach a terminal state, and the
  /// desktop processes portal commands serially, so awaiting this after a
  /// mutation guarantees the next [fetchSnapshot] observes that mutation
  /// rather than a stale cached projection.
  /// Returns true only when the server observed the command complete during
  /// its waited response, making the next [fetchSnapshot] authoritative.
  Future<bool> requestOverviewState();

  /// True when the paired desktop announced the batched
  /// `worktree_chat_summaries` snapshot scope
  /// (`PortalSessionForBrowser.capabilities`). Browsers gate the chat-search
  /// hydration request on this flag; older desktops coerce unknown scopes.
  bool get supportsWorktreeChatSummariesScope;

  /// Host supports selected-only foreground hydration through the chat scope.
  bool get supportsForegroundChat;

  /// Asks the desktop to publish `chat_summary` entities for every worktree
  /// across all workspaces (`portal.state.request` with
  /// `scope: 'worktree_chat_summaries'`), feeding the chat-search index.
  Future<void> requestWorktreeChatSummariesState();

  /// Reads one older transcript page for [target] from the server's history
  /// cache (`POST .../chat/history`). [before] is the opaque cursor from the
  /// previous page's chunk; `null` requests the newest historical page.
  /// Throws [RemoteControlException] on transport failure.
  Future<RemoteChatHistoryChunk> fetchChatHistory(
    RemoteChatTarget target, {
    String? before,
    int? limitTurns,
  });

  /// Creates a new worktree ("task") in [workspaceLocalId]
  /// (`portal.worktree.create`). The desktop generates the branch name and
  /// picks single- vs multi-repo creation from the workspace type.
  ///
  /// [existingWorktreeIds] lets the desktop keep the generated branch name
  /// unique. [baseWorktreeId] branches the new worktree from an existing one;
  /// [forkOpenTabs] additionally copies that worktree's open chat/file tabs
  /// and is only meaningful alongside [baseWorktreeId].
  ///
  /// Throws [RemoteControlException] when the desktop rejects the create. A
  /// create that is merely still running returns a pending
  /// [RemoteWorktreeCreateResult] rather than throwing.
  Future<RemoteWorktreeCreateResult> createWorktree({
    required String workspaceLocalId,
    List<String> existingWorktreeIds = const [],
    String? baseWorktreeId,
    bool forkOpenTabs = false,
  });

  /// Pauses ([paused] true → `portal.hook.pause`) or resumes
  /// (`portal.hook.resume`) hooks in a worktree. Provide exactly one of
  /// [hookKey] (one hook) or [all] (every hook in the worktree).
  Future<String> setHooksPaused({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required bool paused,
    String? hookKey,
    bool all = false,
  });

  /// Reads one changed file's unified diff from the paired desktop
  /// (`POST .../diff/read` → `portal.diff.read`). [source] selects the
  /// working tree or the branch range so a committed-only file is read from
  /// its commits rather than an unchanged working copy.
  /// Throws [RemoteControlException] on transport failure.
  Future<RemoteFileDiff> readFileDiff({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String path,
    required RemoteDiffSource source,
    String? repoId,
  });

  /// Reads a root-scoped text file, including gitignored report artifacts.
  Future<RemoteFileContents> readFile(RemoteFileRequest request);

  /// Resolves an agent-authored link on the paired desktop. Null means that
  /// the desktop could not resolve it to an existing workspace file.
  Future<RemoteFileLink?> resolveLink({
    required String projectId,
    required String worktreeId,
    required String href,
  });

  /// Reads verified image bytes through the desktop's chunked asset command.
  Future<RemoteFileAsset> readAsset(RemoteFileRequest request);

  /// Asks the desktop to project one pipeline execution
  /// (`portal.pipeline.execution.get`). The run is NOT returned here: the
  /// command is not a small RPC, and the desktop answers with a
  /// `portal.pipeline.event` upsert carrying the full row.
  Future<String> requestPipelineExecution({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String executionId,
  });

  /// Asks the desktop for a larger tail of one step's log
  /// (`portal.pipeline.log_request`). Answered the same way: the lines land
  /// as that step's replaced `outputTail` on the next run upsert.
  Future<String> requestPipelineStepLog({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String executionId,
    required String jobId,
    required String stepId,
  });

  /// Cancels, resumes or retries one root run (`portal.pipeline.cancel` /
  /// `resume` / `retry`). Returns the command id; the command completes once
  /// the desktop has acted, and the run's new state arrives as a
  /// `portal.pipeline.event` upsert. A resume carries no pause responses, so
  /// it only releases a pause that is not waiting for input.
  Future<String> submitPipelineRunAction({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String executionId,
    required RemotePipelineRunAction action,
  });

  /// Capability announced by desktops whose `portal.pipeline.get` carries
  /// dispatch inputs and resolves bundled and user pipelines (CAN-3174).
  bool get supportsPipelineDispatch;

  /// Claude and Codex plan usage commands on the paired session (CAN-3635).
  RemoteProviderUsageCommands get providerUsage;

  /// Adds a project to the paired desktop by cloning a git URL (CAN-3988).
  RemoteProjectCommands get projects;

  /// App Advisor commands on the paired session (CAN-3989).
  RemoteAppAdvisorCommands get appAdvisor;

  /// Slash commands the paired desktop discovered for a worktree, for the
  /// composer's `/` suggestions (CAN-3921).
  RemoteComposerCommands get composerCommands;

  RemoteResponseCommands get responseCommands;

  /// Capability announced by desktops whose `pipeline_run` rows carry the
  /// chat turns each run is attributed to (CAN-3619). Without it a chat shows
  /// no Agent activity panel.
  bool get supportsPipelineRunChatLinks;

  /// Capability announced by desktops whose `pipeline_run` rows say which
  /// saved outputs a chat follow-up can review (CAN-3719).
  bool get supportsPipelineChatFollowUp;

  /// Asks the run owner's desktop for the review prompt of one saved output
  /// and the owner chat to send it to
  /// (`portal.pipeline.chat_follow_up.prepare`). A small RPC like
  /// [requestPipelineDispatchForm]: the answer is in
  /// [RemotePortalCommandResult.result], or arrives later as the command's
  /// terminal event. Creates no chat and sends nothing.
  Future<RemotePortalCommandResult> preparePipelineChatFollowUp({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String executionId,
    required RemotePipelineFollowUpOutput output,
  });

  /// Complete pipeline step output and saved report reads.
  RemotePipelineContentCommands get pipelineContent;

  /// Asks the desktop for one pipeline's dispatch form
  /// (`portal.pipeline.get`). A small RPC: the server waits for the answer and
  /// returns it in [RemotePortalCommandResult.result]. When the wait times out
  /// the result is absent and the answer arrives later as the command's
  /// terminal event.
  Future<RemotePortalCommandResult> requestPipelineDispatchForm({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String pipelineId,
  });

  /// Starts [pipelineId] on the worktree with the dispatch trigger
  /// (`portal.pipeline.run`). Returns the command id; the command completes
  /// with `{executionId}` once the run has started. Throws
  /// [RemotePipelineDispatchOutcomeUnknownException] when the request may
  /// have been enqueued but its response was lost, and
  /// [RemotePipelineDispatchQueuedException] when the relay queued it because
  /// the desktop is reconnecting.
  Future<String> dispatchPipeline({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String pipelineId,
    required Map<String, String> inputs,
  });
}

/// The send may have been accepted, but its HTTP acknowledgement was lost.
/// Reconcile the unique user message id before offering the draft again.
class RemoteChatSendOutcomeUnknownException extends RemoteControlException {
  const RemoteChatSendOutcomeUnknownException(super.message);
}

/// The message is saved as a not-sent or uncertain row (CAN-3556). Callers
/// must not put the text back in the composer; the transcript row offers
/// Resend and Discard. [chatId] is the chat the row lives in, which may have
/// been minted for this send.
class RemoteChatSendNotSentException extends RemoteControlException {
  const RemoteChatSendNotSentException(super.message, {this.chatId});

  final String? chatId;
}

/// What an authoritative "does this pairing still exist?" read established.
enum RemoteSessionProbeOutcome {
  /// The server answered, and has no session this client may render.
  gone,

  /// The server answered with a session the cached shell may keep rendering.
  renderable,

  /// The server could not be asked — a transport failure, a 5xx, or an auth
  /// error — or it answered about another desktop's session. Not proof of
  /// anything, and must never drop the pairing.
  unknown,
}

/// Result of [RemoteControlRepository.probeSession]. [connection] is non-null
/// only for [RemoteSessionProbeOutcome.renderable].
typedef RemoteSessionProbe = ({
  RemoteSessionProbeOutcome outcome,
  RemoteConnection? connection,
});

/// Whether [error] is the response the commands route returns when it has no
/// ACTIVE desktop-owned session for this pairing.
///
/// Mirrors the string `apps/web/.../portal/browser/sessions/[sessionId]/
/// commands/route.ts` composes from `REMOTE_CONTROL_LABEL`; the Dart side
/// cannot import it. `ui-labels-mobile-mirror.test.ts` fails if they drift.
///
/// Note this is *not* proof that the session is orphaned — the route answers
/// it for any persisted session whose status is not ACTIVE, including a
/// recoverable `inactive` row. Callers must confirm with
/// [RemoteControlRepository.probeSession] before dropping the pairing.
bool isRemoteSessionUnavailableError(Object error) {
  if (error is! RemoteControlException) return false;
  return error.message.trim().toLowerCase() ==
      'active remote control session not found';
}

/// A worktree create may have reached the server even though its response was
/// lost. Callers must reconcile the session snapshot instead of retrying the
/// non-idempotent create command.
class RemoteWorktreeCreateOutcomeUnknownException
    extends RemoteControlException {
  const RemoteWorktreeCreateOutcomeUnknownException(super.message);
}

/// Shown when the paired desktop cannot prepare a pipeline chat follow-up.
const String kRemotePipelineFollowUpUnsupported =
    'Update the desktop app to start a chat follow-up from your phone.';

/// A pipeline dispatch may have reached the desktop, but its response was
/// lost. Never retry automatically: a second send could start a second run.
class RemotePipelineDispatchOutcomeUnknownException
    extends RemoteControlException {
  const RemotePipelineDispatchOutcomeUnknownException(super.message);
}

/// The relay held a pipeline dispatch because the desktop is reconnecting; it
/// runs once the desktop is back. [commandId] tracks its eventual result.
class RemotePipelineDispatchQueuedException extends RemoteControlException {
  const RemotePipelineDispatchQueuedException(this.commandId)
    : super("Your desktop is reconnecting. The run starts when it's back.");

  final String commandId;
}

void _validateHookPauseTarget({String? hookKey, required bool all}) {
  final hasHookKey = hookKey != null && hookKey.trim().isNotEmpty;
  if (hasHookKey == all) {
    throw ArgumentError(
      'Provide exactly one of hookKey (one hook) or all (every hook).',
    );
  }
}

/// Matches the desktop/web Portal pairing-code shape
/// (`PORTAL_PAIRING_CODE_PATTERN` in `packages/protocol/src/portal/pairing-link.ts`,
/// `/^\d{6}$/`).  Kept in sync manually until the mobile codegen mirrors the
/// portal constants.
final RegExp _pairingCodePattern = RegExp(r'^\d{6}$');

const String _malformedCodeMessage =
    'Enter the 6-digit code shown on your desktop.';

/// Fully-working in-memory [RemoteControlRepository] that keeps `flutter test`
/// and CI green with no configuration, and backs reviewer demo mode.
///
/// [connect] validates the 6-digit code shape and treats [errorCode]
/// (`'000000'` by default) as a rejected pairing so the error path is
/// demoable.  [fetchSnapshot] returns rich sample data spanning workspace
/// types, worktree badge states, standalone chats, chat tabs, and transcripts.
/// [sendChatMessage] scripts a short streamed assistant reply over [events].
final class MockRemoteControlRepository implements RemoteControlRepository {
  MockRemoteControlRepository({
    this.latency = const Duration(milliseconds: 600),
    this.errorCode = '000000',
    this.restorableConnection,
  });

  /// Simulated network round-trip so loading states are visible.
  final Duration latency;

  /// A well-formed 6-digit code that is always rejected, to exercise the error
  /// path in the UI and tests.
  final String errorCode;

  /// When set, [restoreSession] restores this pairing without a code.
  final RemoteConnection? restorableConnection;

  bool _connected = false;
  int _mockCommandSeq = 0;
  int _mockWorktreeSeq = 0;
  final List<RemoteWorktree> _createdWorktrees = [];
  final Set<(String, String)> _archivedWorktrees = {};
  final Map<String, List<RemoteChatMessage>> _transcripts = {};
  final StreamController<RemotePortalEventBatch> _events =
      StreamController.broadcast();
  final StreamController<bool> _eventsLive = StreamController.broadcast();

  @override
  Stream<RemotePortalEventBatch> get events => _events.stream;

  @override
  Stream<bool> get eventsLive => _eventsLive.stream;

  @override
  Future<RemoteConnection?> restoreSession() async {
    await Future<void>.delayed(latency);
    final restorable = restorableConnection;
    if (restorable == null) return null;
    _connected = true;
    _seedTranscripts();
    return restorable;
  }

  @override
  Future<RemoteConnection?> refreshSessionMetadata() => restoreSession();

  @override
  Future<RemoteSessionProbe> probeSession() async {
    final connection = await restoreSession();
    return connection == null
        ? (outcome: RemoteSessionProbeOutcome.gone, connection: null)
        : (
            outcome: RemoteSessionProbeOutcome.renderable,
            connection: connection,
          );
  }

  @override
  Future<RemoteConnection> connect(String pairingCode) async {
    await Future<void>.delayed(latency);
    final code = pairingCode.trim();
    if (!_pairingCodePattern.hasMatch(code)) {
      throw const RemoteControlException(_malformedCodeMessage);
    }
    if (code == errorCode) {
      throw const RemoteControlException(
        'That code was not recognized. Check your desktop and try again.',
      );
    }
    _connected = true;
    _seedTranscripts();
    return RemoteConnection(
      sessionId: 'mock-session',
      deviceLabel: "Alex's MacBook Pro",
      pairedAt: DateTime.now(),
    );
  }

  @override
  Future<void> disconnect() async {
    await Future<void>.delayed(latency);
    clearLocalSession();
  }

  @override
  void clearLocalSession() {
    watchers.invalidateSession();
    _connected = false;
  }

  @override
  Future<RemoteSessionSnapshot> fetchSnapshot() async {
    await Future<void>.delayed(latency);
    if (!_connected) {
      throw const RemoteControlException('Not connected to a desktop.');
    }
    final sample = _sampleSnapshot(_transcripts);
    if (_createdWorktrees.isEmpty &&
        _archivedWorktrees.isEmpty &&
        _projectClones.workspaces.isEmpty) {
      return sample;
    }
    return RemoteSessionSnapshot(
      workspaces: [...sample.workspaces, ..._projectClones.workspaces],
      worktrees: [
        for (final worktree in [...sample.worktrees, ..._createdWorktrees])
          if (!_archivedWorktrees.contains((
            worktree.workspaceLocalId,
            worktree.localId,
          )))
            worktree,
      ],
      standaloneChats: sample.standaloneChats,
      chatSummaries: sample.chatSummaries,
      chatMessages: sample.chatMessages,
      refreshing: sample.refreshing,
      raw: sample.raw,
    );
  }

  @override
  void resumeEvents() {
    if (_connected) _eventsLive.add(true);
  }

  @override
  void pauseEvents() {}

  @override
  void discardEventCursor() {}

  @override
  Future<({Map<String, dynamic> slices, bool refreshing})>
  fetchWorktreeStateSlices({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) async {
    await Future<void>.delayed(latency);
    // Demo-mode worktree activity, mirroring what a worktree-scoped state
    // read returns from the live server cache.
    if (worktreeLocalId != 'wt-feature-auth') {
      return (slices: const <String, dynamic>{}, refreshing: false);
    }
    return (
      refreshing: false,
      slices: {
        'worktreeSummaries': [
          {
            'worktreeLocalId': worktreeLocalId,
            'title': 'OAuth PKCE hardening',
            'description':
                'Implemented code-verifier generation and the token exchange; '
                'auth suite is green.',
          },
        ],
        'changedFiles': {
          worktreeLocalId: {
            'uncommitted': [
              {
                'filePath': 'lib/auth/oauth_pkce.dart',
                'status': 'modified',
                'insertions': 96,
                'deletions': 12,
              },
              {
                'filePath': 'test/auth/oauth_pkce_test.dart',
                'status': 'added',
                'insertions': 21,
                'deletions': 4,
              },
            ],
            'committed': [
              {
                'filePath': 'lib/auth/token_store.dart',
                'status': 'modified',
                'insertions': 14,
                'deletions': 2,
              },
            ],
          },
        },
        'todoLists': [
          {
            'worktreeLocalId': worktreeLocalId,
            'chatId': 'chat-auth-plan',
            'items': [
              {
                'id': 't-1',
                'content': 'Generate the code verifier',
                'status': 'completed',
              },
              {
                'id': 't-2',
                'content': 'Wire the token exchange',
                'status': 'in_progress',
              },
            ],
          },
        ],
        // Configured scripts where only setup has run, so demo mode shows
        // the full Scripts card with one status (CAN-4433).
        'scriptDescriptors': [
          for (final (scriptName, name) in const [
            ('setup', 'setup'),
            ('launch', 'launch'),
            ('teardown', 'teardown'),
            ('test', 'Test'),
            ('storybook', 'Storybook'),
          ])
            {
              'scriptKey': 'project:$scriptName',
              'scriptName': scriptName,
              'name': name,
              'target': 'project',
              'worktreeLocalId': worktreeLocalId,
            },
        ],
        'scriptRuns': [
          {
            'scriptKey': 'project:setup',
            'scriptName': 'setup',
            'name': 'setup',
            'target': 'project',
            'status': 'completed',
            'startedAt': DateTime.now()
                .subtract(const Duration(hours: 2))
                .toIso8601String(),
            'worktreeLocalId': worktreeLocalId,
          },
        ],
        // Dispatchable pipelines so demo mode exercises the Run picker
        // (CAN-3174).
        'pipelines': [
          {
            'pipelineId': 'pipeline-deploy',
            'name': 'Deploy',
            'description': 'Ship the current branch to an environment.',
            'origin': 'project',
            'triggerTypes': ['dispatch'],
            'worktreeLocalId': worktreeLocalId,
          },
          {
            'pipelineId': 'pipeline-ci',
            'name': 'CI',
            'description': 'Build and test.',
            'origin': 'bundled',
            'triggerTypes': ['dispatch'],
            'worktreeLocalId': worktreeLocalId,
          },
        ],
        'watchers': _mockWatchers.rows(
          projectId: workspaceLocalId,
          worktreeId: worktreeLocalId,
          chatId: 'chat-auth-plan',
        ),
        // A running delegate and shell, and a finished one (CAN-5253).
        'backgroundProcesses': [
          for (final (localId, kind, status, description, minutes) in const [
            ('bg-mock-review', 'agent', 'running', 'Review the PKCE flow', 3),
            ('bg-mock-tests', 'bash', 'running', 'flutter test test/auth', 1),
            ('bg-mock-lint', 'bash', 'completed', 'dart analyze', 9),
          ])
            {
              'localId': localId,
              'workspaceLocalId': workspaceLocalId,
              'worktreeLocalId': worktreeLocalId,
              'chatId': 'chat-auth-plan',
              'toolUseId': 'tool-$localId',
              'kind': kind,
              'description': description,
              'status': status,
              'startedAt': DateTime.now()
                  .subtract(Duration(minutes: minutes))
                  .millisecondsSinceEpoch,
              'updatedAt': DateTime.now().millisecondsSinceEpoch,
              if (status == 'completed') 'summary': 'No issues found.',
              'canStop': status == 'running',
            },
        ],
        // One running run with jobs and a matrix variant, one paused on a
        // status reason, and one succeeded — so demo mode exercises the
        // Pipeline Runs card and the read-only run screen (CAN-3043), not
        // just the empty "None yet" state.
        'pipelineRuns': [
          {
            'localId': 'exec-mock-ci',
            'worktreeLocalId': worktreeLocalId,
            'pipelineId': 'pipeline-ci',
            'pipelineName': 'CI',
            'status': 'running',
            'startedAt': DateTime.now()
                .subtract(const Duration(minutes: 4))
                .toIso8601String(),
            'triggerSource': 'chat',
            'progress': {'completedSteps': 2, 'totalSteps': 5},
            'jobs': [
              {
                'jobId': 'build',
                'name': 'Build',
                'status': 'success',
                'steps': [
                  {
                    'stepId': 'compile',
                    'name': 'Compile',
                    'status': 'success',
                    'outputTail': 'Compiled 42 files\n',
                  },
                ],
              },
              {
                'jobId': 'test',
                'name': 'Test',
                'status': 'running',
                'needs': ['build'],
                'variants': [
                  {
                    'jobId': 'test_linux',
                    'name': 'Test (linux)',
                    'status': 'running',
                    'matrix': {'os': 'linux'},
                    'steps': [
                      {'stepId': 'run', 'name': 'Run', 'status': 'running'},
                    ],
                  },
                ],
              },
            ],
          },
          {
            'localId': 'exec-mock-deploy',
            'worktreeLocalId': worktreeLocalId,
            'pipelineId': 'pipeline-deploy',
            'pipelineName': 'Deploy',
            'status': 'paused',
            'startedAt': DateTime.now()
                .subtract(const Duration(minutes: 20))
                .toIso8601String(),
            'triggerSource': 'hook',
            'statusReasons': [
              {
                'id': 'reason-usage-limit',
                'kind': 'pause',
                'code': 'usage_limit',
                'provider': 'anthropic',
              },
            ],
            'jobs': [
              {
                'jobId': 'publish',
                'name': 'Publish',
                'status': 'paused',
                'steps': [
                  {'stepId': 'push', 'name': 'Push image', 'status': 'paused'},
                ],
              },
            ],
          },
          {
            'localId': 'exec-mock-nightly',
            'worktreeLocalId': worktreeLocalId,
            'pipelineId': 'pipeline-nightly',
            'pipelineName': 'Nightly',
            'status': 'success',
            'startedAt': DateTime.now()
                .subtract(const Duration(hours: 6))
                .toIso8601String(),
            'finishedAt': DateTime.now()
                .subtract(const Duration(hours: 5, minutes: 52))
                .toIso8601String(),
            'triggerSource': 'plan',
            'progress': {'completedSteps': 1, 'totalSteps': 1},
            'jobs': [
              {
                'jobId': 'suite',
                'name': 'Full suite',
                'status': 'success',
                'steps': [
                  {
                    'stepId': 'run-suite',
                    'name': 'Run suite',
                    'status': 'success',
                    'outputTail': 'All 214 tests passed\n',
                  },
                ],
              },
            ],
          },
        ],
      },
    );
  }

  @override
  bool get supportsForegroundChat => false;

  @override
  Future<({Map<String, dynamic> slices, bool refreshing})>
  fetchWorktreePipelineSlices({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) async {
    await Future<void>.delayed(latency);
    return (slices: const <String, dynamic>{}, refreshing: false);
  }

  @override
  Future<void> requestWorktreeState({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) async {
    await Future<void>.delayed(latency);
    // Echo the hydrated-worktree snapshot like the live desktop does, so
    // chat-tab loading placeholders resolve in demo mode and tests.
    _emitBatch([
      RemoteStateSnapshotEvent(
        scope: 'worktree',
        targetWorkspaceLocalId: workspaceLocalId,
        targetWorktreeLocalId: worktreeLocalId,
      ),
    ]);
  }

  @override
  Future<List<RemoteChatMessage>> fetchCachedChatMessages(
    RemoteChatTarget target,
  ) async => const [];

  @override
  Future<RemoteCachedChatTail> fetchCachedChatTail(
    RemoteChatTarget target,
  ) async =>
      RemoteCachedChatTail(messages: await fetchCachedChatMessages(target));

  @override
  Future<String?> requestChatTranscript(RemoteChatTarget target) async {
    await Future<void>.delayed(latency);
    final chatId = switch (target) {
      RemoteWorktreeChatTarget(:final chatId) => chatId,
      RemoteStandaloneChatTarget(:final chatId) => chatId,
    };
    if (chatId == null) return null;
    _emitBatch([
      RemoteStateSnapshotEvent(
        scope: 'chat',
        targetChatId: chatId,
        targetChatScope: target.scope,
        chatMessages: List.unmodifiable(_transcripts[chatId] ?? const []),
      ),
    ]);
    return null;
  }

  @override
  Future<RemoteChatSendResult> sendChatMessage(
    RemoteChatTarget target,
    String text, {
    RemoteChatSendOptions? options,
  }) async {
    await Future<void>.delayed(latency);
    if (!_connected) {
      throw const RemoteControlException('Not connected to a desktop.');
    }
    final chatId = switch (target) {
      RemoteWorktreeChatTarget(:final chatId) => chatId ?? 'chat-new-mock',
      RemoteStandaloneChatTarget(:final chatId) => chatId,
    };
    final seq = ++_mockCommandSeq;
    final userMessage = RemoteChatMessage(
      messageId: options?.userMessageId ?? 'mock-user-$seq',
      chatId: chatId,
      role: ChatRole.user,
      status: ChatMessageStatus.complete,
      text: text,
      occurredAt: DateTime.now(),
    );
    _appendMessage(chatId, userMessage);
    _emitBatch([
      RemoteChatMessageEvent(
        chatId: chatId,
        message: userMessage,
        scope: target.scope,
      ),
    ]);
    unawaited(_scriptAssistantReply(chatId, target.scope, seq));
    return RemoteChatSendResult(commandId: 'mock-cmd-$seq', chatId: chatId);
  }

  @override
  bool get supportsChatAttachments => true;

  @override
  bool get supportsStandaloneChatCreate => true;

  int _mockAttachmentSeq = 0;

  @override
  Future<ChatAttachmentRef> uploadChatAttachment({
    required String filename,
    required String mediaType,
    required Uint8List bytes,
  }) async {
    await Future<void>.delayed(latency);
    final seq = ++_mockAttachmentSeq;
    return ChatAttachmentRef(
      attachmentId:
          '00000000-0000-4000-8000-${seq.toString().padLeft(12, '0')}',
      filename: filename,
      mediaType: mediaType,
      size: bytes.length,
      contentSha256: sha256.convert(bytes).toString(),
      storageKind: 'blob',
      source: '/mock/$seq',
    );
  }

  @override
  Future<void> deleteChatAttachment(String attachmentId) async {}

  @override
  bool get supportsPrActions => false;
  @override
  bool get supportsPrStatusPush => false;
  @override
  Future<RemotePortalCommandResult> runPrAction({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required RemotePrAction action,
    String? repoId,
    RemotePrActionIdentity? identity,
    bool confirmUnresolvedComments = false,
  }) async => const RemotePortalCommandResult(
    commandId: '',
    result: {'repos': [], 'busy': false},
  );

  @override
  bool get supportsChatMarkRead => false;

  @override
  Future<String> markChatRead(
    RemoteChatTarget target,
    String? lastMessageId,
  ) async => '';

  @override
  Future<String> setChatModel(RemoteChatTarget target, String model) async {
    await Future<void>.delayed(latency);
    return 'mock-cmd-${++_mockCommandSeq}';
  }

  @override
  Future<String> setChatAutoModel(RemoteWorktreeChatTarget target) async {
    await Future<void>.delayed(latency);
    return 'mock-cmd-${++_mockCommandSeq}';
  }

  @override
  Future<String> setChatPlanMode(
    RemoteWorktreeChatTarget target,
    bool planMode,
  ) async {
    await Future<void>.delayed(latency);
    return 'mock-cmd-${++_mockCommandSeq}';
  }

  @override
  Future<String> setChatThinkingLevel(
    RemoteWorktreeChatTarget target,
    String thinkingLevel,
  ) async {
    await Future<void>.delayed(latency);
    return 'mock-cmd-${++_mockCommandSeq}';
  }

  @override
  Future<String> setChatFastMode(
    RemoteWorktreeChatTarget target,
    bool fastMode,
  ) async {
    await Future<void>.delayed(latency);
    return 'mock-cmd-${++_mockCommandSeq}';
  }

  @override
  Future<String> setChatPluginSelections(
    RemoteChatTarget target,
    Map<String, Object?> selections,
  ) async {
    await Future<void>.delayed(latency);
    return 'mock-cmd-${++_mockCommandSeq}';
  }

  @override
  bool get canArchiveWorktrees => true;

  @override
  Future<String> archiveWorktree({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) async {
    await Future<void>.delayed(latency);
    if (!_connected) {
      throw const RemoteControlException('Not connected to a desktop.');
    }
    _archivedWorktrees.add((workspaceLocalId, worktreeLocalId));
    final commandId = 'mock-cmd-${++_mockCommandSeq}';
    _events.add(
      RemotePortalEventBatch.fromJson({
        'events': [
          {
            'type': 'portal.command.completed',
            'payload': {
              'commandId': commandId,
              'result': {'success': true},
            },
          },
        ],
        'nextCursor': _mockCommandSeq,
      }),
    );
    return commandId;
  }

  @override
  Future<String> closeChatTab(RemoteWorktreeChatTarget target) async {
    await Future<void>.delayed(latency);
    return 'mock-cmd-${++_mockCommandSeq}';
  }

  @override
  Future<String> createChatTab(RemoteWorktreeChatTarget target) async {
    await Future<void>.delayed(latency);
    return 'mock-cmd-${++_mockCommandSeq}';
  }

  @override
  Future<String> createStandaloneChat(RemoteStandaloneChatTarget target) async {
    await Future<void>.delayed(latency);
    final commandId = 'mock-cmd-${++_mockCommandSeq}';
    _transcripts.putIfAbsent(target.chatId, () => []);
    _emitBatch([
      RemoteCommandCompletedEvent(
        commandId: commandId,
        result: {'chatId': target.chatId},
      ),
    ]);
    return commandId;
  }

  @override
  Future<String> cancelChat(RemoteChatTarget target) async {
    await Future<void>.delayed(latency);
    return 'mock-cmd-${++_mockCommandSeq}';
  }

  /// Recorded by [answerChatQuestion] / [dismissChatQuestion] so demo-mode
  /// tests can assert the resolution flow.
  String? lastAnsweredRequestId;
  List<AskUserQuestionAnswer>? lastAnswers;
  String? lastDismissedRequestId;

  @override
  Future<String> answerChatQuestion(
    RemoteWorktreeChatTarget target, {
    required String requestId,
    required List<AskUserQuestionAnswer> answers,
  }) async {
    await Future<void>.delayed(latency);
    lastAnsweredRequestId = requestId;
    lastAnswers = answers;
    return 'mock-cmd-${++_mockCommandSeq}';
  }

  @override
  Future<String> dismissChatQuestion(
    RemoteWorktreeChatTarget target, {
    required String requestId,
  }) async {
    await Future<void>.delayed(latency);
    lastDismissedRequestId = requestId;
    return 'mock-cmd-${++_mockCommandSeq}';
  }

  @override
  Future<String> setHooksPaused({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required bool paused,
    String? hookKey,
    bool all = false,
  }) async {
    _validateHookPauseTarget(hookKey: hookKey, all: all);
    await Future<void>.delayed(latency);
    return 'mock-cmd-${++_mockCommandSeq}';
  }

  @override
  Future<RemoteFileDiff> readFileDiff({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String path,
    required RemoteDiffSource source,
    String? repoId,
  }) async {
    await Future<void>.delayed(latency);
    if (!_connected) {
      throw const RemoteControlException('Not connected to a desktop.');
    }
    return RemoteFileDiff(
      filePath: path,
      repoId: repoId,
      insertions: 2,
      deletions: 1,
      rangeLabel: source == RemoteDiffSource.committed ? 'main..HEAD' : null,
      patch:
          'diff --git a/$path b/$path\n'
          '--- a/$path\n'
          '+++ b/$path\n'
          '@@ -1,3 +1,4 @@\n'
          ' // $path\n'
          '-const greeting = "hello";\n'
          '+const greeting = "hello, world";\n'
          '+const source = "${source.wireValue}";\n'
          ' export default greeting;\n',
    );
  }

  @override
  Future<RemoteFileContents> readFile(RemoteFileRequest request) async =>
      throw const RemoteFileException(
        RemoteFileFailure.unavailable,
        'File reads are unavailable in demo mode.',
      );

  @override
  Future<RemoteFileLink?> resolveLink({
    required String projectId,
    required String worktreeId,
    required String href,
  }) async => null;

  @override
  Future<RemoteFileAsset> readAsset(RemoteFileRequest request) async =>
      throw const RemoteFileException(
        RemoteFileFailure.unavailable,
        'File reads are unavailable in demo mode.',
      );

  @override
  Future<String> requestPipelineExecution({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String executionId,
  }) async {
    await Future<void>.delayed(latency);
    return 'pipeline-execution-$executionId';
  }

  @override
  Future<String> requestPipelineStepLog({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String executionId,
    required String jobId,
    required String stepId,
  }) async {
    await Future<void>.delayed(latency);
    return 'pipeline-log-$executionId-$jobId-$stepId';
  }

  @override
  Future<String> submitPipelineRunAction({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String executionId,
    required RemotePipelineRunAction action,
  }) async {
    await Future<void>.delayed(latency);
    return 'pipeline-${action.name}-$executionId';
  }

  @override
  bool get supportsPipelineDispatch => true;

  late final _projectClones = MockRemoteProjectClones(
    latency: latency,
    isConnected: () => _connected,
    nextCommandId: () => 'mock-cmd-${++_mockCommandSeq}',
  );

  @override
  RemoteProjectCommands get projects => _projectClones.commands;

  late final _mockWatchers = MockRemoteWatchers(
    onDeleted: (watcherId, parents) => _emitBatch([
      RemotePortalEventBatch.fromJson({
        'events': [
          {
            'type': 'portal.state.delta',
            'payload': {
              'scope': 'worktree',
              'removed': [
                for (final parent in parents)
                  {
                    'entityType': 'watcher',
                    'localId': watcherId,
                    'parentLocalId': parent,
                  },
              ],
            },
          },
        ],
        'nextCursor': 0,
      }).events.single,
    ]),
  );

  @override
  late final watchers = RemoteWatcherCommands(
    hasCapability: (_) => true,
    events: events,
    submit: _mockWatchers.submit,
  );

  @override
  late final providerUsage = RemoteProviderUsageCommands(
    hasCapability: (_) => false,
    submit: ({required type, required payload}) async {
      await Future<void>.delayed(latency);
      return 'mock-$type';
    },
  );

  @override
  late final appAdvisor = RemoteAppAdvisorCommands(
    hasCapability: (_) => false,
    submit: ({required type, required payload}) async {
      await Future<void>.delayed(latency);
      return 'mock-$type';
    },
    request: ({required type, required payload, target}) async {
      await Future<void>.delayed(latency);
      return RemotePortalCommandResult(commandId: 'mock-$type');
    },
  );

  @override
  late final responseCommands = RemoteResponseCommands(
    submit: ({required type, required target, required payload}) async =>
        RemotePortalCommandResult(commandId: 'mock-$type'),
  );

  @override
  late final composerCommands = RemoteComposerCommands(
    sessionId: () => 'mock-session',
    supportsInvocableInventory: () => false,
    submit: ({required type, required target, required payload}) async {
      await Future<void>.delayed(latency);
      return RemotePortalCommandResult(
        commandId: 'mock-$type',
        result: {
          'commands': [
            {'name': 'review', 'description': 'Review the current changes'},
            {'name': 'test', 'description': 'Run the project tests'},
          ],
        },
      );
    },
  );

  @override
  bool get supportsPipelineRunChatLinks => true;

  @override
  bool get supportsPipelineChatFollowUp => false;

  @override
  Future<RemotePortalCommandResult> preparePipelineChatFollowUp({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String executionId,
    required RemotePipelineFollowUpOutput output,
  }) async =>
      throw const RemoteControlException(kRemotePipelineFollowUpUnsupported);

  @override
  late final pipelineContent = RemotePipelineContentCommands(
    hasCapability: (_) => false,
    request: ({required type, required payload, target}) async =>
        throw const RemoteControlException(kRemotePipelineContentUnsupported),
  );

  @override
  Future<RemotePortalCommandResult> requestPipelineDispatchForm({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String pipelineId,
  }) async {
    await Future<void>.delayed(latency);
    return RemotePortalCommandResult(
      commandId: 'pipeline-get-$pipelineId',
      result: {
        'definition': {'name': pipelineId},
        'dispatchInputs': pipelineId == 'pipeline-deploy'
            ? {
                'environment': {
                  'type': 'choice',
                  'required': true,
                  'options': ['staging', 'production'],
                  'description': 'Where to deploy',
                },
                'dry_run': {'type': 'boolean', 'default': true},
              }
            : <String, dynamic>{},
      },
    );
  }

  @override
  Future<String> dispatchPipeline({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String pipelineId,
    required Map<String, String> inputs,
  }) async {
    await Future<void>.delayed(latency);
    return 'pipeline-run-$pipelineId';
  }

  @override
  Future<bool> requestOverviewState() async {
    await Future<void>.delayed(latency);
    return true;
  }

  @override
  bool get supportsWorktreeChatSummariesScope => true;

  @override
  Future<void> requestWorktreeChatSummariesState() async {
    await Future<void>.delayed(latency);
  }

  @override
  Future<RemoteChatHistoryChunk> fetchChatHistory(
    RemoteChatTarget target, {
    String? before,
    int? limitTurns,
  }) async {
    await Future<void>.delayed(latency);
    // The mock keeps whole transcripts in memory, so there is no older page.
    return const RemoteChatHistoryChunk(messages: [], nextCursor: null);
  }

  @override
  Future<RemoteWorktreeCreateResult> createWorktree({
    required String workspaceLocalId,
    List<String> existingWorktreeIds = const [],
    String? baseWorktreeId,
    bool forkOpenTabs = false,
  }) async {
    await Future<void>.delayed(latency);
    if (!_connected) {
      throw const RemoteControlException('Not connected to a desktop.');
    }
    final seq = ++_mockWorktreeSeq;
    final worktree = RemoteWorktree(
      localId: 'wt-mock-$seq',
      workspaceLocalId: workspaceLocalId,
      branch: 'mobile/new-task-$seq',
      label: 'new-task-$seq',
      lastActivityAt: DateTime.now().toIso8601String(),
    );
    _createdWorktrees.add(worktree);
    return RemoteWorktreeCreateResult(
      commandId: 'mock-cmd-${++_mockCommandSeq}',
      worktreeLocalId: worktree.localId,
    );
  }

  Future<void> _scriptAssistantReply(
    String chatId,
    RemoteChatScope scope,
    int seq,
  ) async {
    final streaming = RemoteChatMessage(
      messageId: 'mock-assistant-$seq',
      chatId: chatId,
      role: ChatRole.assistant,
      status: ChatMessageStatus.streaming,
      text: 'On it — taking a look now…',
      occurredAt: DateTime.now(),
    );
    await Future<void>.delayed(latency);
    if (!_connected) return;
    _appendMessage(chatId, streaming);
    _emitBatch([
      RemoteChatMessageEvent(chatId: chatId, message: streaming, scope: scope),
    ]);

    final complete = RemoteChatMessage(
      messageId: 'mock-assistant-$seq',
      chatId: chatId,
      role: ChatRole.assistant,
      status: ChatMessageStatus.complete,
      text:
          'On it — taking a look now…\n\nDone. I ran the checks and everything '
          'passes locally; the diff is ready for review.',
      occurredAt: DateTime.now(),
    );
    await Future<void>.delayed(latency);
    if (!_connected) return;
    _appendMessage(chatId, complete);
    _emitBatch([
      RemoteChatMessageEvent(chatId: chatId, message: complete, scope: scope),
    ]);
  }

  void _appendMessage(String chatId, RemoteChatMessage message) {
    final transcript = _transcripts.putIfAbsent(chatId, () => []);
    final index = transcript.indexWhere(
      (m) => m.messageId == message.messageId,
    );
    if (index == -1) {
      transcript.add(message);
    } else {
      transcript[index] = message;
    }
  }

  void _emitBatch(List<RemotePortalEvent> batchEvents) {
    if (_events.isClosed) return;
    _events.add(
      RemotePortalEventBatch(
        events: batchEvents,
        nextCursor: ++_mockCommandSeq,
        connectionStatus: RemotePortalConnectionStatus.active,
      ),
    );
  }

  void _seedTranscripts() {
    if (_transcripts.isNotEmpty) return;
    final now = DateTime.now();
    _transcripts['chat-auth-plan'] = [
      RemoteChatMessage(
        messageId: 'seed-1',
        chatId: 'chat-auth-plan',
        role: ChatRole.user,
        status: ChatMessageStatus.complete,
        text: 'Add PKCE to the mobile OAuth flow',
        occurredAt: now.subtract(const Duration(minutes: 20)),
      ),
      // Intermediate agent steps (tool calls, no prose): collapse behind the
      // steps summary row, mirroring the live desktop projection shape.
      RemoteChatMessage(
        messageId: 'seed-1b',
        chatId: 'chat-auth-plan',
        role: ChatRole.assistant,
        status: ChatMessageStatus.complete,
        text: '',
        parts: const [
          ChatPart(
            kind: 'tool_use',
            toolFamily: 'bash',
            data: {
              'toolUseId': 'seed-tu-1',
              'name': 'Bash',
              'input':
                  '{"command": "npm test -- auth", '
                  '"description": "run the auth tests"}',
            },
          ),
          ChatPart(
            kind: 'tool_use',
            toolFamily: 'edit',
            data: {
              'toolUseId': 'seed-tu-2',
              'name': 'Edit',
              'input': '{"file_path": "lib/auth/oauth_pkce.dart"}',
            },
          ),
          ChatPart(
            kind: 'tool_result',
            data: {
              'toolUseId': 'seed-tu-1',
              'output': '42 passing (3.1s)',
              'isError': false,
            },
          ),
        ],
        occurredAt: now.subtract(const Duration(minutes: 19)),
      ),
      RemoteChatMessage(
        messageId: 'seed-2',
        chatId: 'chat-auth-plan',
        role: ChatRole.assistant,
        status: ChatMessageStatus.complete,
        text:
            'Implemented the code-verifier generation and token exchange. '
            'All 42 auth tests pass.',
        occurredAt: now.subtract(const Duration(minutes: 18)),
      ),
    ];
    _transcripts['chat-arch'] = [
      RemoteChatMessage(
        messageId: 'seed-3',
        chatId: 'chat-arch',
        role: ChatRole.user,
        status: ChatMessageStatus.complete,
        text: 'How should we break the executor circular dependency?',
        occurredAt: now.subtract(const Duration(minutes: 45)),
      ),
      RemoteChatMessage(
        messageId: 'seed-4',
        chatId: 'chat-arch',
        role: ChatRole.assistant,
        status: ChatMessageStatus.complete,
        text:
            'The cleanest option is keeping the dynamic import at the '
            'step-runner boundary and documenting it as intentional.',
        occurredAt: now.subtract(const Duration(minutes: 40)),
      ),
    ];
  }
}

RemoteSessionSnapshot _sampleSnapshot(
  Map<String, List<RemoteChatMessage>> transcripts,
) {
  final now = DateTime.now();
  String ago(Duration d) => now.subtract(d).toIso8601String();

  const workspaces = <RemoteWorkspace>[
    RemoteWorkspace(
      localId: 'ws-app',
      name: 'acme-web',
      type: RemoteWorkspaceType.singleRepo,
      rootPath: '~/code/acme-web',
      color: '#4f46e5',
    ),
    RemoteWorkspace(
      localId: 'ws-platform',
      name: 'platform',
      type: RemoteWorkspaceType.multiRepo,
      rootPath: '~/code/platform',
      color: '#0891b2',
      repos: [
        RemoteRepo(id: 'repo-api', name: 'api', repoPath: 'packages/api'),
        RemoteRepo(id: 'repo-web', name: 'web', repoPath: 'apps/web'),
        RemoteRepo(
          id: 'repo-worker',
          name: 'worker',
          repoPath: 'services/worker',
        ),
      ],
    ),
    RemoteWorkspace(
      localId: 'ws-notes',
      name: 'Research notes',
      type: RemoteWorkspaceType.cowork,
      color: '#059669',
    ),
  ];

  final worktrees = <RemoteWorktree>[
    RemoteWorktree(
      localId: 'wt-feature-auth',
      workspaceLocalId: 'ws-app',
      branch: 'feature/oauth-pkce',
      label: 'lion',
      status: 'active',
      busy: true,
      insertions: 117,
      deletions: 16,
      prStatuses: const [RemoteWorktreePr(prNumber: 1304, state: 'open')],
      lastActivityAt: ago(const Duration(minutes: 2)),
    ),
    RemoteWorktree(
      localId: 'wt-bugfix',
      workspaceLocalId: 'ws-app',
      branch: 'fix/overflow',
      label: 'krill',
      hasUnread: true,
      awaitingApproval: true,
      insertions: 64,
      deletions: 2,
      lastActivityAt: ago(const Duration(minutes: 18)),
    ),
    RemoteWorktree(
      localId: 'wt-ci',
      workspaceLocalId: 'ws-platform',
      branch: 'chore/ci-speedup',
      label: 'koala',
      pipelineStatus: RemoteWorktreePipelineStatus.running,
      lastActivityAt: ago(const Duration(hours: 1)),
    ),
    RemoteWorktree(
      localId: 'wt-migrate',
      workspaceLocalId: 'ws-platform',
      branch: 'feat/prisma-7',
      label: 'okapi',
      pipelineStatus: RemoteWorktreePipelineStatus.unseenFailure,
      hasUnread: true,
      prStatuses: const [RemoteWorktreePr(prNumber: 1395, state: 'merged')],
      lastActivityAt: ago(const Duration(hours: 4)),
    ),
  ];

  final standaloneChats = <RemoteStandaloneChat>[
    RemoteStandaloneChat(
      localId: 'chat-arch',
      projectLocalId: 'ws-app',
      title: 'Refactor the executor module graph',
      modelLabel: 'Claude Sonnet 4.5',
      providerType: 'claude',
      lastMessageAt: ago(const Duration(minutes: 40)),
    ),
    RemoteStandaloneChat(
      localId: 'chat-notes',
      projectLocalId: 'ws-notes',
      title: 'Weekly planning brainstorm',
      modelLabel: 'GPT-5 Codex',
      providerType: 'codex',
      lastMessageAt: ago(const Duration(hours: 6)),
    ),
    RemoteStandaloneChat(
      localId: 'chat-notes-archived',
      projectLocalId: 'ws-notes',
      title: 'Old spike (archived)',
      modelLabel: 'Claude Sonnet 4.5',
      providerType: 'claude',
      archived: true,
      lastMessageAt: ago(const Duration(days: 3)),
    ),
  ];

  final chatSummaries = <RemoteChatSummary>[
    RemoteChatSummary(
      chatId: 'chat-auth-plan',
      scope: RemoteChatScope.worktree,
      workspaceLocalId: 'ws-app',
      worktreeLocalId: 'wt-feature-auth',
      title: 'PKCE implementation',
      order: 0,
      modelLabel: 'Claude Sonnet 4.5',
      providerType: 'claude',
      lastMessageAt: ago(const Duration(minutes: 18)),
      active: true,
      // Matches the two running demo background processes.
      turnPhase: RemoteChatTurnPhase.background,
      backgroundTasks: 2,
      backgroundDelegations: 1,
    ),
    RemoteChatSummary(
      chatId: 'chat-auth-tests',
      scope: RemoteChatScope.worktree,
      workspaceLocalId: 'ws-app',
      worktreeLocalId: 'wt-feature-auth',
      title: 'Widget test cleanup',
      order: 1,
      modelLabel: 'Claude Sonnet 4.5',
      providerType: 'claude',
      lastMessageAt: ago(const Duration(hours: 2)),
    ),
  ];

  final chatMessages = <RemoteChatMessage>[
    for (final transcript in transcripts.values) ...transcript,
  ];

  return RemoteSessionSnapshot(
    workspaces: workspaces,
    worktrees: worktrees,
    standaloneChats: standaloneChats,
    chatSummaries: chatSummaries,
    chatMessages: chatMessages,
  );
}

/// Live [RemoteControlRepository] backed by the desktop Portal relay through
/// the browser Portal routes (see `remote_control_api_service.dart` for the
/// route contract and `portal_event_stream.dart` for the event channel).
final class HttpRemoteControlRepository implements RemoteControlRepository {
  HttpRemoteControlRepository({
    required this.service,
    required this.eventStream,
    http.Client Function()? recoveryClientFactory,
  }) : _recoveryClientFactory = recoveryClientFactory ?? http.Client.new,
       _reads = PortalReadClient(clientFactory: recoveryClientFactory);

  /// Convenience factory wiring both collaborators from one [ApiClient].
  factory HttpRemoteControlRepository.fromApiClient(ApiClient apiClient) =>
      HttpRemoteControlRepository(
        service: RemoteControlApiService(apiClient: apiClient),
        eventStream: PortalEventStream(
          baseUrl: '${apiClient.baseUrl}$portalBrowserBasePath',
          headersProvider: apiClient.buildHeaders,
        ),
      );

  final RemoteControlApiService service;
  final PortalEventStream eventStream;
  final http.Client Function() _recoveryClientFactory;

  /// Shared connection pool for session, overview and chat-cache reads.
  final PortalReadClient _reads;

  late final _files = PortalFileClient(
    apiClient: service.apiClient,
    reads: _reads,
  );

  String? _sessionId;

  /// The session this phone last ended with Disconnect. Its end request can
  /// time out before reaching the server, which then still reports it as
  /// current; an automatic restore must not reattach it (CAN-4426). A new
  /// code pairing may.
  String? _disconnectedSessionId;

  /// End requests from Disconnect that have not settled. The desktop can
  /// re-arm a code on the session being ended, so a code pairing waits for
  /// them; a later end would end the new pairing on the server (CAN-4426).
  final Set<Future<void>> _pendingEnds = {};
  Map<String, bool> _sessionCapabilities = const {};
  bool _destructiveActionsEnabled = false;
  int _eventCursor = 0;
  bool _eventCursorSeeded = false;
  int _eventCursorGeneration = 0;
  StreamSubscription<RemotePortalEventBatch>? _eventSubscription;

  /// Tells the current subscription that its desktop is back.
  StreamController<void>? _eventWake;
  final StreamController<RemotePortalEventBatch> _events =
      StreamController.broadcast();
  final StreamController<bool> _eventsLive = StreamController.broadcast();

  /// Upper bounds for the session reads that pairing restore and foreground
  /// recovery wait on (CAN-3557), and for the end request Disconnect sends
  /// (CAN-4426). After Android resumes the app, a pooled connection can be
  /// dead without being closed, and a request on it neither answers nor fails.
  static const Duration _sessionReadTimeout = Duration(seconds: 15);
  static const Duration _snapshotReadTimeout = Duration(seconds: 30);

  Future<RemotePortalSession?> _fetchCurrentSessionBounded() async {
    final wake = _eventWake;
    final session = await _reads.run(
      _sessionReadTimeout,
      (client) =>
          service.fetchCurrentSession(httpClient: client, retryTransient: true),
    );
    // The held desktop is back: retry its event stream now instead of after
    // the rest of a reconnect backoff step. Only the subscription this read
    // started under is woken; a replacement has its own backoff.
    if (session != null &&
        session.id == _sessionId &&
        session.connectionStatus == RemotePortalConnectionStatus.active &&
        identical(wake, _eventWake)) {
      wake?.add(null);
    }
    return session;
  }

  @override
  bool get supportsForegroundChat =>
      _sessionCapabilities['foreground_worktree_chat'] == true;

  @override
  Stream<RemotePortalEventBatch> get events => _events.stream;

  @override
  Stream<bool> get eventsLive => _eventsLive.stream;

  @override
  bool get supportsWorktreeChatSummariesScope =>
      _sessionCapabilities['worktree_chat_summaries_scope'] == true;

  @override
  Future<RemoteConnection?> restoreSession() async =>
      (await probeSession()).connection;

  @override
  Future<RemoteConnection?> refreshSessionMetadata() async {
    final sessionId = _sessionId;
    if (sessionId == null) return null;
    final RemotePortalSession? session;
    try {
      session = await _fetchCurrentSessionBounded();
    } on ApiException {
      return null;
    } catch (_) {
      return null;
    }
    if (session == null ||
        session.id != sessionId ||
        !canRenderRemoteShell(
          sessionStatus: session.status,
          connectionStatus: session.connectionStatus,
        )) {
      return null;
    }
    _sessionCapabilities = session.capabilities;
    _destructiveActionsEnabled = session.destructiveActionsEnabled;
    return _connectionFromSession(session);
  }

  @override
  Future<RemoteSessionProbe> probeSession() async {
    const unknown = (
      outcome: RemoteSessionProbeOutcome.unknown,
      connection: null,
    );
    const gone = (outcome: RemoteSessionProbeOutcome.gone, connection: null);
    final heldSessionId = _sessionId;
    final RemotePortalSession? session;
    try {
      session = await _fetchCurrentSessionBounded();
    } on ApiException {
      // No status code is an answer here. The route reports an absent session
      // as 200 with a null body, handled below — its *only* 404 is the
      // feature/entitlement gate, and both halves of that gate fail closed on
      // a transient resolution failure. Reading that 404 as "your pairing is
      // gone" would let a LaunchDarkly blip drop a live pairing.
      return unknown;
    } catch (_) {
      return unknown;
    }
    // The user disconnected (or the pairing was reset) while the read was in
    // flight. Its answer describes a pairing this client no longer holds.
    if (_sessionId != heldSessionId) return unknown;
    // CAN-4426: the session the user just left, still current only because
    // its end request never reached the server.
    if (heldSessionId == null &&
        session != null &&
        session.id == _disconnectedSessionId) {
      return gone;
    }
    // CAN-3624: the read returns the account's current session, ACTIVE first,
    // otherwise newest. While the paired desktop sleeps, that can be another
    // desktop's row, which says nothing about this pairing. Adopting it would
    // retarget commands and events to the other desktop.
    if (session != null &&
        heldSessionId != null &&
        session.id != heldSessionId) {
      return unknown;
    }
    // CAN-2651: `inactive` is a recoverable stale flag, not a teardown — the
    // server sweep sets it when the desktop's heartbeat lapsed past 90s and
    // any desktop-facing request revives the row. Rejecting it here dropped
    // the user to the pairing form for a session that was about to heal.
    // Mirrors web's contract; see `remote_session_predicates.dart`.
    if (session == null ||
        !canRenderRemoteShell(
          sessionStatus: session.status,
          connectionStatus: session.connectionStatus,
        )) {
      return gone;
    }
    _adoptSession(session.id);
    _sessionCapabilities = session.capabilities;
    _destructiveActionsEnabled = session.destructiveActionsEnabled;
    return (
      outcome: RemoteSessionProbeOutcome.renderable,
      connection: _connectionFromSession(session),
    );
  }

  @override
  Future<RemoteConnection> connect(String pairingCode) async {
    final code = pairingCode.trim();
    if (!_pairingCodePattern.hasMatch(code)) {
      throw const RemoteControlException(_malformedCodeMessage);
    }
    await Future.wait(_pendingEnds.toList());
    final String sessionId;
    try {
      sessionId = await service.connect(code);
    } on ApiException catch (e) {
      throw remotePairingFailure(e);
    } catch (_) {
      throw const RemoteControlException(
        'Could not reach the server. Check your connection and try again.',
      );
    }
    if (_disconnectedSessionId == sessionId) _disconnectedSessionId = null;
    _adoptSession(sessionId);

    // Best-effort metadata read; the pairing itself already succeeded.
    RemotePortalSession? session;
    try {
      session = await service.fetchCurrentSession();
    } catch (_) {
      session = null;
    }
    _sessionCapabilities = session?.capabilities ?? const {};
    _destructiveActionsEnabled = session?.destructiveActionsEnabled ?? false;
    return _connectionFromSession(session);
  }

  @override
  Future<void> disconnect() async {
    final sessionId = _sessionId;
    clearLocalSession();
    if (sessionId == null) return;
    _disconnectedSessionId = sessionId;
    final end = _endSession(sessionId);
    _pendingEnds.add(end);
    await end;
    _pendingEnds.remove(end);
  }

  Future<void> _endSession(String sessionId) async {
    try {
      // Bounded like the session reads on its own client, so a timeout
      // aborts the socket and completes the disconnect.
      final client = _recoveryClientFactory();
      try {
        await service
            .endSession(sessionId, httpClient: client)
            .timeout(_sessionReadTimeout);
      } finally {
        client.close();
      }
    } catch (_) {
      // Disconnect is best-effort; local state is already reset.
    }
  }

  @override
  void clearLocalSession() {
    watchers.invalidateSession();
    _sessionId = null;
    _sessionCapabilities = const {};
    _destructiveActionsEnabled = false;
    _eventCursor = 0;
    _eventCursorSeeded = false;
    _eventCursorGeneration++;
    pauseEvents();
  }

  void _adoptSession(String sessionId) {
    if (_sessionId != sessionId) {
      watchers.invalidateSession();
      // A replaced pairing's subscription and pooled reads belong to it; the
      // first adoption keeps the pool its own probe just used.
      if (_sessionId != null) pauseEvents();
      _eventCursor = 0;
      _eventCursorSeeded = false;
      _eventCursorGeneration++;
    }
    _sessionId = sessionId;
  }

  @override
  Future<RemoteSessionSnapshot> fetchSnapshot() async {
    final sessionId = _requireSession();
    final cursorGeneration = _eventCursorGeneration;
    final RemotePortalStateResult result;
    try {
      result = await _reads.run(
        _snapshotReadTimeout,
        (client) => service.fetchState(sessionId, httpClient: client),
      );
    } on ApiException catch (e) {
      throw RemoteControlException(
        apiErrorMessage(e) ?? 'Could not load projects from your desktop.',
      );
    } catch (_) {
      throw const RemoteControlException(
        'Could not reach the server. Check your connection and try again.',
      );
    }
    final cursor = result.eventCursor;
    // Only the initial snapshot seeds replay. An overview refresh omits chat
    // history, so using its newer cursor would skip unseen transcript events
    // on the next resume, even though those rows were never applied locally.
    // Reads started before a discard cannot seed the new subscription.
    if (_sessionId == sessionId &&
        cursorGeneration == _eventCursorGeneration &&
        !_eventCursorSeeded) {
      if (cursor != null && cursor > _eventCursor) _eventCursor = cursor;
      _eventCursorSeeded = true;
    }
    // Every read still reports the cursor its shell covers, so the store can
    // skip replayed shell events this read already includes.
    return result.snapshot.copyWith(
      eventCursor: cursor,
      refreshing:
          result.refreshing ||
          result.projectionPending ||
          result.snapshot.refreshing,
    );
  }

  @override
  void resumeEvents() {
    final sessionId = _sessionId;
    if (sessionId == null || _eventSubscription != null) return;
    final wake = _eventWake = StreamController<void>.broadcast(sync: true);
    _eventSubscription = eventStream
        .subscribe(
          sessionId: sessionId,
          initialCursor: _eventCursor,
          wake: wake.stream,
          confirmSessionEnded: (confirmationClient) async {
            // Availability/auth errors on events do not prove the pairing
            // expired. The current-session endpoint can return another live
            // device's newer session, so only the subscribed session's own
            // terminal state (or no live session) is authoritative here.
            // Never adopt a different session into this subscription: its
            // cursor and requests belong to sessionId.
            final session = await service.fetchCurrentSession(
              httpClient: confirmationClient,
            );
            return session == null ||
                (session.id == sessionId &&
                    !canRenderRemoteShell(
                      sessionStatus: session.status,
                      connectionStatus: session.connectionStatus,
                    ));
          },
          onLiveChanged: (live) {
            if (_sessionId != sessionId || _eventsLive.isClosed) return;
            if (!live) watchers.deliveryStopped();
            _eventsLive.add(live);
          },
        )
        .listen((batch) {
          if (_sessionId != sessionId) return;
          if (batch.nextCursor > _eventCursor) {
            _eventCursor = batch.nextCursor;
          }
          if (!_events.isClosed) _events.add(batch);
        }, onDone: () => _eventSubscription = null);
  }

  /// Also retires the read pool: this runs when the app backgrounds and when
  /// the session is torn down or replaced, and a connection kept across
  /// either can be dead on return.
  @override
  void pauseEvents() {
    _stopEvents();
    _reads.reset();
  }

  void _stopEvents() {
    watchers.deliveryStopped();
    final subscription = _eventSubscription;
    _eventSubscription = null;
    unawaited(subscription?.cancel());
    unawaited(_eventWake?.close());
    _eventWake = null;
  }

  /// Keeps the read pool: a read already in flight still completes, and the
  /// cursor generation stops it from seeding the fresh cursor.
  @override
  void discardEventCursor() {
    _stopEvents();
    _eventCursor = 0;
    _eventCursorSeeded = false;
    _eventCursorGeneration++;
  }

  @override
  Future<void> requestWorktreeState({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) async {
    final target = {
      'workspaceLocalId': workspaceLocalId,
      'worktreeLocalId': worktreeLocalId,
    };
    await _submitVoidCommand(
      type: 'portal.state.request',
      target: target,
      payload: {'scope': 'worktree', 'target': target},
    );
  }

  @override
  Future<({Map<String, dynamic> slices, bool refreshing})>
  fetchWorktreeStateSlices({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) => _fetchWorktreeScope(
    'worktree',
    workspaceLocalId: workspaceLocalId,
    worktreeLocalId: worktreeLocalId,
  );

  @override
  Future<({Map<String, dynamic> slices, bool refreshing})>
  fetchWorktreePipelineSlices({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) => _fetchWorktreeScope(
    'pipelines',
    workspaceLocalId: workspaceLocalId,
    worktreeLocalId: worktreeLocalId,
  );

  Future<({Map<String, dynamic> slices, bool refreshing})> _fetchWorktreeScope(
    String scope, {
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) async {
    final sessionId = _requireSession();
    try {
      final result = await service.fetchState(
        sessionId,
        scope: scope,
        target: {
          'workspaceLocalId': workspaceLocalId,
          'worktreeLocalId': worktreeLocalId,
        },
      );
      return (slices: result.snapshot.raw, refreshing: result.refreshing);
    } on ApiException catch (e) {
      throw RemoteControlException(
        apiErrorMessage(e) ?? 'Could not load worktree activity.',
      );
    } catch (_) {
      throw const RemoteControlException(
        'Could not reach the server. Check your connection and try again.',
      );
    }
  }

  Map<String, String> _chatWireTarget(RemoteChatTarget target) {
    return switch (target) {
      RemoteWorktreeChatTarget(
        :final workspaceLocalId,
        :final worktreeLocalId,
        :final chatId,
      ) =>
        {
          'workspaceLocalId': workspaceLocalId,
          'worktreeLocalId': worktreeLocalId,
          'chatLocalId': ?chatId,
        },
      RemoteStandaloneChatTarget(:final chatId, :final projectLocalId) => {
        'standaloneChatLocalId': chatId,
        'projectLocalId': ?projectLocalId,
      },
    };
  }

  @override
  Future<List<RemoteChatMessage>> fetchCachedChatMessages(
    RemoteChatTarget target,
  ) async => (await fetchCachedChatTail(target)).messages;

  @override
  Future<RemoteCachedChatTail> fetchCachedChatTail(
    RemoteChatTarget target,
  ) async {
    if (target.chatId == null) return const RemoteCachedChatTail();
    final sessionId = _requireSession();
    final result = await _reads.run(
      const Duration(seconds: 10),
      (client) => service.fetchState(
        sessionId,
        scope: 'chat',
        target: _chatWireTarget(target),
        httpClient: client,
      ),
    );
    if (_sessionId != sessionId) return const RemoteCachedChatTail();
    // Keep the projection watermark with its rows for per-chat validation.
    // A scoped read never advances _eventCursor or proves an empty transcript.
    return RemoteCachedChatTail(
      messages: result.snapshot.chatMessages,
      eventCursor: result.eventCursor,
      coverage: result.chatTailCoverage,
      stale:
          result.refreshing ||
          result.projectionPending ||
          result.snapshot.refreshing ||
          result.connectionStatus != RemotePortalConnectionStatus.active,
    );
  }

  @override
  Future<String?> requestChatTranscript(RemoteChatTarget target) async {
    final wireTarget = _chatWireTarget(target);
    return _submitVoidCommand(
      type: 'portal.state.request',
      target: wireTarget,
      payload: {
        'scope': 'chat',
        'target': wireTarget,
        if (supportsForegroundChat && target is RemoteWorktreeChatTarget)
          'selectedChatOnly': true,
      },
    );
  }

  @override
  Future<RemoteChatSendResult> sendChatMessage(
    RemoteChatTarget target,
    String text, {
    RemoteChatSendOptions? options,
  }) async {
    final result = switch (target) {
      RemoteWorktreeChatTarget(
        :final workspaceLocalId,
        :final worktreeLocalId,
        :final chatId,
      ) =>
        await _submit(
          type: 'portal.chat.send',
          unknownSendOutcomeOnTransportFailure: true,
          target: {
            'workspaceLocalId': workspaceLocalId,
            'worktreeLocalId': worktreeLocalId,
          },
          payload: {
            'projectId': workspaceLocalId,
            'worktreeId': worktreeLocalId,
            'chatId': ?chatId,
            'userMessageId': ?options?.userMessageId,
            'text': text,
            // Composer selections in the web submission's payload shape.
            // Unset fields stay off the wire so the desktop tab's persisted
            // defaults keep applying.
            'model': ?options?.model,
            'providerType': ?options?.providerType,
            'planMode': ?options?.planMode,
            if (options != null &&
                (options.thinkingLevel != null || options.fastMode != null))
              'modelConfig': {
                'thinkingLevel': ?options.thinkingLevel,
                'fastMode': ?options.fastMode,
              },
            'inputMode': ?options?.inputMode,
            if (options?.attachments case final attachments?
                when attachments.isNotEmpty)
              'cloudAttachments': [
                for (final attachment in attachments) attachment.toJson(),
              ],
          },
        ),
      RemoteStandaloneChatTarget(:final chatId, :final projectLocalId) =>
        await _submit(
          type: 'portal.standalone_chat.send',
          unknownSendOutcomeOnTransportFailure: true,
          target: {'standaloneChatLocalId': chatId},
          payload: {
            'projectLocalId': ?projectLocalId,
            'chatId': chatId,
            'userMessageId': ?options?.userMessageId,
            'message': text,
            // Composer selections supported by
            // `PortalStandaloneChatSendPayload`. Standalone chats do not
            // carry worktree-only plan mode.
            'model': ?options?.model,
            if (options != null &&
                (options.thinkingLevel != null || options.fastMode != null))
              'modelConfig': {
                'thinkingLevel': ?options.thinkingLevel,
                'fastMode': ?options.fastMode,
              },
            'inputMode': ?options?.inputMode,
            if (options?.attachments case final attachments?
                when attachments.isNotEmpty)
              'cloudAttachments': [
                for (final attachment in attachments) attachment.toJson(),
              ],
          },
        ),
    };
    final error = result.error;
    if (error != null && error.isNotEmpty) {
      throw RemoteControlException(error);
    }
    final fallbackChatId = switch (target) {
      RemoteWorktreeChatTarget(:final chatId) => chatId,
      RemoteStandaloneChatTarget(:final chatId) => chatId,
    };
    return RemoteChatSendResult(
      commandId: result.commandId,
      chatId: result.chatId ?? fallbackChatId,
      queuedWhileReconnecting: result.queuedWhileReconnecting,
    );
  }

  @override
  bool get supportsChatAttachments =>
      _sessionCapabilities['chat_attachments'] == true;

  @override
  bool get supportsStandaloneChatCreate =>
      _sessionCapabilities['standalone_chat_create'] == true;

  @override
  Future<ChatAttachmentRef> uploadChatAttachment({
    required String filename,
    required String mediaType,
    required Uint8List bytes,
  }) async {
    final sessionId = _requireSession();
    try {
      return await service.uploadChatAttachment(
        sessionId,
        filename: filename,
        mediaType: mediaType,
        bytes: bytes,
      );
    } on ApiException catch (e) {
      throw RemoteControlException(
        apiErrorMessage(e) ?? "Couldn't upload the attachment.",
      );
    } catch (_) {
      throw const RemoteControlException(
        'Could not reach the server. Check your connection and try again.',
      );
    }
  }

  @override
  Future<void> deleteChatAttachment(String attachmentId) async {
    final sessionId = _requireSession();
    await service.deleteChatAttachment(sessionId, attachmentId);
  }

  @override
  bool get supportsPrActions =>
      _sessionCapabilities['pr_worktree_actions'] == true;

  @override
  bool get supportsPrStatusPush =>
      _sessionCapabilities['pr_status_push_v1'] == true;

  @override
  bool get supportsPipelineDispatch =>
      _sessionCapabilities['pipeline_dispatch'] == true;

  @override
  late final watchers = RemoteWatcherCommands(
    hasCapability: (capability) => _sessionCapabilities[capability] == true,
    events: events,
    submit: (sessionId, {required type, required payload}) {
      if (sessionId != _requireSession()) {
        throw const RemoteWatcherDeleteException(
          RemoteWatcherDeleteFailure.forbidden,
          'This paired session has ended.',
        );
      }
      return service.submitCommand(sessionId, type: type, payload: payload);
    },
  );

  @override
  late final providerUsage = RemoteProviderUsageCommands(
    hasCapability: (capability) => _sessionCapabilities[capability] == true,
    submit: _submitVoidCommand,
  );

  @override
  late final projects = RemoteProjectCommands(
    submit: ({required type, required payload}) =>
        service.submitCommand(_requireSession(), type: type, payload: payload),
    readStatus: (commandId) =>
        service.fetchCommandStatus(_requireSession(), commandId),
  );

  @override
  late final appAdvisor = RemoteAppAdvisorCommands(
    hasCapability: (capability) => _sessionCapabilities[capability] == true,
    submit: ({required type, required payload}) => _submitVoidCommand(
      type: type,
      payload: payload,
      unknownSendOutcomeOnTransportFailure: type == 'portal.app_advisor.send',
    ),
    request: ({required type, required payload, target}) =>
        _submit(type: type, target: target, payload: payload),
  );

  @override
  late final responseCommands = RemoteResponseCommands(
    submit: ({required type, required target, required payload}) =>
        _submit(type: type, target: target, payload: payload),
  );

  @override
  late final composerCommands = RemoteComposerCommands(
    sessionId: () => _sessionId,
    supportsInvocableInventory: () =>
        _sessionCapabilities['invocable_inventory'] == true,
    submit: ({required type, required target, required payload}) =>
        _submit(type: type, target: target, payload: payload),
  );

  @override
  bool get supportsPipelineRunChatLinks =>
      _sessionCapabilities['pipeline_run_chat_links'] == true;

  @override
  bool get supportsPipelineChatFollowUp =>
      _sessionCapabilities['pipeline_chat_follow_up'] == true;

  @override
  Future<RemotePortalCommandResult> preparePipelineChatFollowUp({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String executionId,
    required RemotePipelineFollowUpOutput output,
  }) async {
    if (!supportsPipelineChatFollowUp) {
      throw const RemoteControlException(kRemotePipelineFollowUpUnsupported);
    }
    final result = await _submit(
      type: 'portal.pipeline.chat_follow_up.prepare',
      target: {
        'workspaceLocalId': workspaceLocalId,
        'worktreeLocalId': worktreeLocalId,
      },
      payload: {
        'projectId': workspaceLocalId,
        'worktreeId': worktreeLocalId,
        'executionId': executionId,
        'output': output.name,
      },
    );
    if (result.error case final error? when error.isNotEmpty) {
      throw RemoteControlException(error);
    }
    return result;
  }

  @override
  late final pipelineContent = RemotePipelineContentCommands(
    hasCapability: (capability) => _sessionCapabilities[capability] == true,
    request: ({required type, required payload, target}) =>
        _submit(type: type, target: target, payload: payload),
  );

  @override
  Future<RemotePortalCommandResult> runPrAction({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required RemotePrAction action,
    String? repoId,
    RemotePrActionIdentity? identity,
    bool confirmUnresolvedComments = false,
  }) async {
    if (!supportsPrActions) {
      throw const RemoteControlException(
        'Update the desktop app to use PR actions.',
      );
    }
    final result = await _submit(
      type: 'portal.pr.action',
      target: {
        'workspaceLocalId': workspaceLocalId,
        'worktreeLocalId': worktreeLocalId,
      },
      payload: {
        'workspaceLocalId': workspaceLocalId,
        'worktreeLocalId': worktreeLocalId,
        'action': action.wireValue,
        if (repoId != null) 'repoIds': [repoId],
        if (identity != null) ...{
          'expectedBaseBranch': identity.baseBranch,
          'expectedHeadBranch': identity.headBranch,
          if (identity.prNumber != null) 'expectedPrNumber': identity.prNumber,
        },
        if (action == RemotePrAction.merge)
          'confirmUnresolvedComments': confirmUnresolvedComments,
      },
    );
    if (result.error case final error? when error.isNotEmpty) {
      throw RemoteControlException(error);
    }
    return result;
  }

  @override
  bool get supportsChatMarkRead =>
      _sessionCapabilities['chat_mark_read'] == true;

  @override
  Future<String> markChatRead(
    RemoteChatTarget target,
    String? lastMessageId,
  ) async {
    if (!supportsChatMarkRead) return '';
    return switch (target) {
      RemoteWorktreeChatTarget() => _submitWorktreeChatSetter(
        target,
        'portal.chat.mark_read',
        {'scope': 'worktree', 'lastMessageId': lastMessageId},
      ),
      RemoteStandaloneChatTarget(:final chatId, :final projectLocalId) =>
        _submitVoidCommand(
          type: 'portal.chat.mark_read',
          target: {'standaloneChatLocalId': chatId},
          payload: {
            'scope': 'standalone',
            'projectLocalId': projectLocalId,
            'chatId': chatId,
            'lastMessageId': lastMessageId,
          },
        ),
    };
  }

  @override
  Future<String> setChatModel(RemoteChatTarget target, String model) =>
      switch (target) {
        RemoteWorktreeChatTarget(
          :final workspaceLocalId,
          :final worktreeLocalId,
          :final chatId,
        ) =>
          _submitVoidCommand(
            type: 'portal.chat.set_model',
            target: {
              'workspaceLocalId': workspaceLocalId,
              'worktreeLocalId': worktreeLocalId,
            },
            payload: {
              'projectId': workspaceLocalId,
              'worktreeId': worktreeLocalId,
              'chatId': ?chatId,
              'model': model,
            },
          ),
        RemoteStandaloneChatTarget(:final chatId, :final projectLocalId) =>
          _submitVoidCommand(
            type: 'portal.standalone_chat.set_model',
            target: {'standaloneChatLocalId': chatId},
            payload: {
              'projectLocalId': ?projectLocalId,
              'chatId': chatId,
              'model': model,
            },
          ),
      };

  @override
  Future<String> setChatAutoModel(RemoteWorktreeChatTarget target) =>
      _submitWorktreeChatSetter(target, 'portal.chat.set_model', {
        'selectionMode': 'auto',
      });

  @override
  Future<String> setChatPlanMode(
    RemoteWorktreeChatTarget target,
    bool planMode,
  ) => _submitWorktreeChatSetter(target, 'portal.chat.set_plan_mode', {
    'planMode': planMode,
  });

  @override
  Future<String> setChatThinkingLevel(
    RemoteWorktreeChatTarget target,
    String thinkingLevel,
  ) => _submitWorktreeChatSetter(target, 'portal.chat.set_thinking_level', {
    'thinkingLevel': thinkingLevel,
  });

  @override
  Future<String> setChatFastMode(
    RemoteWorktreeChatTarget target,
    bool fastMode,
  ) => _submitWorktreeChatSetter(target, 'portal.chat.set_fast_mode', {
    'fastMode': fastMode,
  });

  @override
  Future<String> setChatPluginSelections(
    RemoteChatTarget target,
    Map<String, Object?> selections,
  ) => switch (target) {
    RemoteWorktreeChatTarget() => _submitWorktreeChatSetter(
      target,
      'portal.chat.set_plugin_selections',
      {'selections': selections},
    ),
    RemoteStandaloneChatTarget(:final chatId, :final projectLocalId) =>
      composerCommands.supportsInvocableInventory
          ? _submitVoidCommand(
              type: 'portal.standalone_chat.set_plugin_selections',
              target: {'standaloneChatLocalId': chatId},
              payload: {
                'projectLocalId': ?projectLocalId,
                'chatId': chatId,
                'selections': selections,
              },
            )
          : Future.error(
              const RemoteControlException(
                'Plugins are not available for this chat.',
              ),
            ),
  };

  @override
  Future<String> cancelChat(RemoteChatTarget target) => switch (target) {
    RemoteWorktreeChatTarget() => _submitWorktreeChatSetter(
      target,
      'portal.chat.cancel',
      const {},
    ),
    RemoteStandaloneChatTarget(:final chatId, :final projectLocalId) =>
      _submitVoidCommand(
        type: 'portal.standalone_chat.cancel',
        target: {'standaloneChatLocalId': chatId},
        payload: {'projectLocalId': ?projectLocalId, 'chatId': chatId},
      ),
  };

  @override
  bool get canArchiveWorktrees => _destructiveActionsEnabled;

  @override
  Future<String> archiveWorktree({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) {
    if (!canArchiveWorktrees) {
      throw const RemoteControlException(
        'Worktree archiving is not available.',
      );
    }
    return _submitVoidCommand(
      type: 'portal.worktree.archive',
      target: {
        'workspaceLocalId': workspaceLocalId,
        'worktreeLocalId': worktreeLocalId,
      },
      payload: {'workspaceId': workspaceLocalId, 'worktreeId': worktreeLocalId},
    );
  }

  @override
  Future<String> closeChatTab(RemoteWorktreeChatTarget target) =>
      _submitWorktreeChatSetter(target, 'portal.chat.close_tab', const {});

  @override
  Future<String> createChatTab(RemoteWorktreeChatTarget target) =>
      _submitWorktreeChatSetter(target, 'portal.chat.create_tab', const {});

  @override
  Future<String> createStandaloneChat(RemoteStandaloneChatTarget target) {
    final projectLocalId = target.projectLocalId;
    if (projectLocalId == null || projectLocalId.isEmpty) {
      throw const RemoteControlException('Choose a project for this chat.');
    }
    return _submitVoidCommand(
      type: 'portal.standalone_chat.create',
      target: {'standaloneChatLocalId': target.chatId},
      payload: {'projectLocalId': projectLocalId, 'chatId': target.chatId},
    );
  }

  @override
  Future<String> answerChatQuestion(
    RemoteWorktreeChatTarget target, {
    required String requestId,
    required List<AskUserQuestionAnswer> answers,
  }) => _submitWorktreeChatSetter(target, 'portal.chat.answer_question', {
    'requestId': requestId,
    'answers': [for (final answer in answers) answer.toJson()],
  });

  @override
  Future<String> dismissChatQuestion(
    RemoteWorktreeChatTarget target, {
    required String requestId,
  }) => _submitWorktreeChatSetter(target, 'portal.chat.dismiss_question', {
    'requestId': requestId,
  });

  @override
  Future<String> setHooksPaused({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required bool paused,
    String? hookKey,
    bool all = false,
  }) {
    _validateHookPauseTarget(hookKey: hookKey, all: all);
    return _submitVoidCommand(
      type: paused ? 'portal.hook.pause' : 'portal.hook.resume',
      target: {
        'workspaceLocalId': workspaceLocalId,
        'worktreeLocalId': worktreeLocalId,
      },
      payload: {
        'projectId': workspaceLocalId,
        'worktreeId': worktreeLocalId,
        'hookKey': ?hookKey,
        if (all) 'all': true,
      },
    );
  }

  @override
  Future<bool> requestOverviewState() async {
    final result = await _submit(
      type: 'portal.state.request',
      payload: {'scope': 'overview', 'refresh': true},
    );
    final error = result.error;
    if (error != null && error.isNotEmpty) {
      throw RemoteControlException(error);
    }
    return result.result != null;
  }

  @override
  Future<void> requestWorktreeChatSummariesState() async {
    final result = await _submit(
      type: 'portal.state.request',
      payload: {'scope': 'worktree_chat_summaries'},
    );
    final error = result.error;
    if (error != null && error.isNotEmpty) {
      throw RemoteControlException(error);
    }
  }

  @override
  Future<RemoteChatHistoryChunk> fetchChatHistory(
    RemoteChatTarget target, {
    String? before,
    int? limitTurns,
  }) async {
    final sessionId = _requireSession();
    try {
      return switch (target) {
        RemoteWorktreeChatTarget(
          :final workspaceLocalId,
          :final worktreeLocalId,
          :final chatId,
        ) =>
          await service.fetchChatHistory(
            sessionId,
            scope: 'worktree',
            chatId: chatId ?? '',
            workspaceLocalId: workspaceLocalId,
            worktreeLocalId: worktreeLocalId,
            before: before,
            limitTurns: limitTurns,
          ),
        RemoteStandaloneChatTarget(:final chatId) =>
          await service.fetchChatHistory(
            sessionId,
            scope: 'standalone',
            chatId: chatId,
            before: before,
            limitTurns: limitTurns,
          ),
      };
    } on ApiException catch (e) {
      throw RemoteControlException(
        apiErrorMessage(e) ?? 'Could not load older messages.',
      );
    } catch (_) {
      throw const RemoteControlException(
        'Could not reach the server. Check your connection and try again.',
      );
    }
  }

  @override
  Future<RemoteWorktreeCreateResult> createWorktree({
    required String workspaceLocalId,
    List<String> existingWorktreeIds = const [],
    String? baseWorktreeId,
    bool forkOpenTabs = false,
  }) async {
    final result = await _submit(
      type: 'portal.worktree.create',
      target: {'workspaceLocalId': workspaceLocalId},
      unknownCreateOutcomeOnTransportFailure: true,
      payload: {
        'workspaceId': workspaceLocalId,
        if (existingWorktreeIds.isNotEmpty)
          'existingWorktreeIds': existingWorktreeIds,
        'baseWorktreeId': ?baseWorktreeId,
        // Only meaningful with a base worktree, and the desktop ignores it
        // otherwise; omit it entirely so the payload stays minimal.
        if (forkOpenTabs && baseWorktreeId != null) 'forkOpenTabs': true,
      },
    );
    final error = result.error;
    if (error != null && error.isNotEmpty) {
      throw RemoteControlException(error);
    }
    final createdId = result.result?['id'];
    return RemoteWorktreeCreateResult(
      commandId: result.commandId,
      worktreeLocalId: createdId is String && createdId.isNotEmpty
          ? createdId
          : null,
    );
  }

  /// Shared shape for the worktree `portal.chat.*` setter/cancel commands: they
  /// all route by `{workspaceLocalId, worktreeLocalId}` and carry
  /// `{projectId, worktreeId, chatId, ...extra}` in the payload.
  Future<String> _submitWorktreeChatSetter(
    RemoteWorktreeChatTarget target,
    String type,
    Map<String, dynamic> extra,
  ) => _submitVoidCommand(
    type: type,
    target: {
      'workspaceLocalId': target.workspaceLocalId,
      'worktreeLocalId': target.worktreeLocalId,
    },
    payload: {
      'projectId': target.workspaceLocalId,
      'worktreeId': target.worktreeLocalId,
      'chatId': ?target.chatId,
      ...extra,
    },
  );

  /// Submits a command whose result carries no data, surfacing a command-level
  /// error as a [RemoteControlException] so the composer can revert + report.
  Future<String> _submitVoidCommand({
    required String type,
    Map<String, String>? target,
    required Map<String, dynamic> payload,
    bool unknownSendOutcomeOnTransportFailure = false,
  }) async {
    final result = await _submit(
      type: type,
      target: target,
      payload: payload,
      unknownSendOutcomeOnTransportFailure:
          unknownSendOutcomeOnTransportFailure,
    );
    final error = result.error;
    if (error != null && error.isNotEmpty) {
      throw RemoteControlException(error);
    }
    return result.commandId;
  }

  Future<RemotePortalCommandResult> _submit({
    required String type,
    Map<String, String>? target,
    required Map<String, dynamic> payload,
    bool unknownCreateOutcomeOnTransportFailure = false,
    bool unknownSendOutcomeOnTransportFailure = false,
    bool unknownDispatchOutcomeOnTransportFailure = false,
  }) async {
    final sessionId = _requireSession();
    try {
      return await service.submitCommand(
        sessionId,
        type: type,
        target: target,
        payload: payload,
      );
    } on ApiException catch (e) {
      final serverMessage = apiErrorMessage(e);
      final definitelyRejectedBeforeEnqueue =
          e.statusCode == 503 &&
          serverMessage == 'Secure command delivery is unavailable.';
      if (unknownSendOutcomeOnTransportFailure &&
          !definitelyRejectedBeforeEnqueue &&
          (e.statusCode == 408 || e.statusCode >= 500)) {
        throw RemoteChatSendOutcomeUnknownException(
          serverMessage ?? 'The server response was lost after sending.',
        );
      }
      if (unknownCreateOutcomeOnTransportFailure &&
          !definitelyRejectedBeforeEnqueue &&
          (e.statusCode == 408 || e.statusCode >= 500)) {
        throw RemoteWorktreeCreateOutcomeUnknownException(
          serverMessage ??
              'The server response was lost after the task create was sent.',
        );
      }
      if (unknownDispatchOutcomeOnTransportFailure &&
          !definitelyRejectedBeforeEnqueue &&
          (e.statusCode == 408 || e.statusCode >= 500)) {
        throw RemotePipelineDispatchOutcomeUnknownException(
          serverMessage ??
              'The server response was lost after the run was sent.',
        );
      }
      throw RemoteControlException(
        serverMessage ?? 'The desktop did not accept the request.',
      );
    } catch (_) {
      if (unknownSendOutcomeOnTransportFailure) {
        throw const RemoteChatSendOutcomeUnknownException(
          'Could not reach the server. Check your connection and try again.',
        );
      }
      if (unknownCreateOutcomeOnTransportFailure) {
        throw const RemoteWorktreeCreateOutcomeUnknownException(
          'The connection was lost after the task create was sent.',
        );
      }
      if (unknownDispatchOutcomeOnTransportFailure) {
        throw const RemotePipelineDispatchOutcomeUnknownException(
          'The connection was lost after the run was sent.',
        );
      }
      throw const RemoteControlException(
        'Could not reach the server. Check your connection and try again.',
      );
    }
  }

  @override
  Future<RemoteFileDiff> readFileDiff({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String path,
    required RemoteDiffSource source,
    String? repoId,
  }) async {
    final sessionId = _requireSession();
    try {
      return await service.readDiff(
        sessionId,
        workspaceLocalId: workspaceLocalId,
        worktreeLocalId: worktreeLocalId,
        path: path,
        source: source,
        repoId: repoId,
      );
    } on ApiException catch (e) {
      throw RemoteControlException(
        apiErrorMessage(e) ?? 'Could not load the diff.',
      );
    } catch (_) {
      throw const RemoteControlException(
        'Could not reach the server. Check your connection and try again.',
      );
    }
  }

  @override
  Future<RemoteFileContents> readFile(RemoteFileRequest request) =>
      _files.readFile(_requireSession(), request);

  @override
  Future<RemoteFileLink?> resolveLink({
    required String projectId,
    required String worktreeId,
    required String href,
  }) => _files.resolveLink(
    _requireSession(),
    projectId: projectId,
    worktreeId: worktreeId,
    href: href,
  );

  @override
  Future<RemoteFileAsset> readAsset(RemoteFileRequest request) =>
      _files.readAsset(
        _requireSession(),
        request,
        capabilities: _sessionCapabilities,
      );

  @override
  Future<String> requestPipelineExecution({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String executionId,
  }) => _submitVoidCommand(
    type: 'portal.pipeline.execution.get',
    target: {
      'workspaceLocalId': workspaceLocalId,
      'worktreeLocalId': worktreeLocalId,
    },
    payload: {
      'projectId': workspaceLocalId,
      'worktreeId': worktreeLocalId,
      'executionId': executionId,
    },
  );

  @override
  Future<String> requestPipelineStepLog({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String executionId,
    required String jobId,
    required String stepId,
  }) => _submitVoidCommand(
    type: 'portal.pipeline.log_request',
    target: {
      'workspaceLocalId': workspaceLocalId,
      'worktreeLocalId': worktreeLocalId,
    },
    payload: {
      'projectId': workspaceLocalId,
      'worktreeId': worktreeLocalId,
      'executionId': executionId,
      'jobId': jobId,
      'stepId': stepId,
    },
  );

  @override
  Future<String> submitPipelineRunAction({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String executionId,
    required RemotePipelineRunAction action,
  }) => _submitVoidCommand(
    type: action.commandType,
    target: {
      'workspaceLocalId': workspaceLocalId,
      'worktreeLocalId': worktreeLocalId,
    },
    payload: {
      'projectId': workspaceLocalId,
      'worktreeId': worktreeLocalId,
      'executionId': executionId,
    },
  );

  @override
  Future<RemotePortalCommandResult> requestPipelineDispatchForm({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String pipelineId,
  }) async {
    final result = await _submit(
      type: 'portal.pipeline.get',
      target: {
        'workspaceLocalId': workspaceLocalId,
        'worktreeLocalId': worktreeLocalId,
      },
      payload: {
        'projectId': workspaceLocalId,
        'worktreeId': worktreeLocalId,
        'pipelineId': pipelineId,
      },
    );
    if (result.error case final error? when error.isNotEmpty) {
      throw RemoteControlException(error);
    }
    return result;
  }

  @override
  Future<String> dispatchPipeline({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String pipelineId,
    required Map<String, String> inputs,
  }) async {
    final result = await _submit(
      type: 'portal.pipeline.run',
      target: {
        'workspaceLocalId': workspaceLocalId,
        'worktreeLocalId': worktreeLocalId,
      },
      payload: {
        'projectId': workspaceLocalId,
        'worktreeId': worktreeLocalId,
        'pipelineId': pipelineId,
        if (inputs.isNotEmpty) 'inputs': inputs,
      },
      unknownDispatchOutcomeOnTransportFailure: true,
    );
    if (result.error case final error? when error.isNotEmpty) {
      throw RemoteControlException(error);
    }
    if (result.queuedWhileReconnecting) {
      throw RemotePipelineDispatchQueuedException(result.commandId);
    }
    return result.commandId;
  }

  String _requireSession() {
    final sessionId = _sessionId;
    if (sessionId == null) {
      throw const RemoteControlException('Not connected to a desktop.');
    }
    return sessionId;
  }

  RemoteConnection _connectionFromSession(RemotePortalSession? session) {
    final clientName = session?.clientName;
    final activatedAt = session?.activatedAt;
    return RemoteConnection(
      sessionId: session?.id ?? _sessionId,
      deviceLabel: clientName != null && clientName.isNotEmpty
          ? clientName
          : 'Your desktop',
      pairedAt: activatedAt == null
          ? DateTime.now()
          : DateTime.tryParse(activatedAt) ?? DateTime.now(),
      // Carried rather than discarded (CAN-2651) so a restore onto a stale
      // session can render the degraded banner immediately.
      connectionStatus: session?.connectionStatus,
      lastSeenAt: DateTime.tryParse(session?.lastSeenAt ?? ''),
      spaceNotificationSettingsEnabled:
          session?.spaceNotificationSettingsEnabled ?? false,
    );
  }
}
