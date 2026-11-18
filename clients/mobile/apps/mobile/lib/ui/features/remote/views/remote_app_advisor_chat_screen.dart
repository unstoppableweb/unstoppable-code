import 'package:mobile/data/models/agent_model_selection.dart';
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/composer/canopy_effort_control.dart';
import 'package:mobile/core/design-system/overlay-action/canopy_overlay_action.dart';
import 'package:mobile/core/design-system/spinner/comet_spinner.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/core/chat/widgets/chat_body.dart';
import 'package:mobile/ui/core/chat/widgets/chat_feed.dart';
import 'package:mobile/ui/core/chat/widgets/chat_input.dart';
import 'package:mobile/ui/core/chat/widgets/composer_controls.dart';
import 'package:mobile/ui/core/chat/widgets/pending_question_card.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/remote_app_advisor_screen.dart';
import 'package:mobile/ui/features/remote/views/widgets/chat_tabs_sheet.dart';
import 'package:mobile/ui/features/remote/views/widgets/command_failure_banner.dart';
import 'package:mobile/ui/features/remote/views/widgets/remote_degraded_banner.dart';
import 'package:provider/provider.dart';

/// One App Advisor chat on the paired desktop (CAN-3989): the live
/// transcript, its questions, and a composer that can send and stop. The
/// Chats button lists the Work Entry's tabs and opens a new one; Advisor
/// tabs are closed on the desktop.
///
/// A null [chatId] composes a new chat. Its first send omits the chat id and
/// the screen binds to the one the desktop returns, holding the composer
/// until then.
class RemoteAppAdvisorChatScreen extends StatefulWidget {
  const RemoteAppAdvisorChatScreen({super.key, this.chatId});

  final String? chatId;

  @override
  State<RemoteAppAdvisorChatScreen> createState() =>
      _RemoteAppAdvisorChatScreenState();
}

class _RemoteAppAdvisorChatScreenState
    extends State<RemoteAppAdvisorChatScreen> {
  final TextEditingController _composer = TextEditingController();
  final Set<String> _expandedTurns = {};
  late String? _chatId = widget.chatId;
  bool _sending = false;
  String? _newChatMessageId;
  String? _entryKey;
  int _selectionGeneration = 0;

  /// The model picked for a new chat before its first send.
  String? _newChatModel;

  @override
  void initState() {
    super.initState();
    // The picker shows the Advisor default for a new chat or tab.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        unawaited(
          context.read<RemoteControlViewModel>().appAdvisor.loadSettings(),
        );
      }
    });
  }

  @override
  void dispose() {
    _composer.dispose();
    super.dispose();
  }

  Future<void> _send(RemoteAppAdvisorController advisor) async {
    final text = _composer.text.trim();
    if (text.isEmpty || _sending) return;
    final selectedChatId = _chatId;
    final selectionGeneration = _selectionGeneration;
    setState(() => _sending = true);
    _composer.clear();
    try {
      final pending = advisor.send(
        chatId: selectedChatId,
        text: text,
        model: selectedChatId == null ? _newChatModel : null,
      );
      if (selectedChatId == null) {
        _newChatMessageId = advisor.startingMessage?.messageId;
      }
      final chatId = await pending;
      if (mounted &&
          selectedChatId == null &&
          selectionGeneration == _selectionGeneration) {
        _select(chatId);
      }
    } on RemoteControlException {
      // Failed submissions stay attached to their original conversation.
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _resend(
    RemoteAppAdvisorController advisor,
    String messageId,
  ) async {
    if (_sending) return;
    final selectedChatId = _chatId;
    final selectionGeneration = _selectionGeneration;
    if (selectedChatId == null) _newChatMessageId = messageId;
    setState(() => _sending = true);
    try {
      final sentChatId = await advisor.resend(
        selectedChatId,
        messageId,
        model: selectedChatId == null ? _newChatModel : null,
      );
      if (mounted &&
          sentChatId != null &&
          selectedChatId == null &&
          selectionGeneration == _selectionGeneration) {
        _select(sentChatId);
      }
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  /// The model chip and Stop. Advisor plan, thinking, and fast mode stay
  /// desktop settings, as on the web. A null [chatId] is a new chat: its
  /// choice stays on this screen and goes with the first send.
  ComposerControlsData _composerControls(
    RemoteAppAdvisorController advisor,
    String? chatId, {
    required bool isRunning,
    required bool canAct,
  }) {
    final summary = chatId == null ? null : advisor.summaryFor(chatId);
    final catalog = advisor.catalogFor(chatId);
    final modelId =
        (chatId == null ? _newChatModel : null) ??
        advisor.modelFor(chatId) ??
        catalog.models.where((model) => model.isDefault).firstOrNull?.id;
    final selected = effectiveModelOption(
      catalog.models,
      modelId,
      executionHarness: summary?.executionHarness,
    );
    return ComposerControlsData(
      providerType: selected?.provider ?? summary?.providerType,
      executionHarness: summary?.executionHarness,
      modelLabel:
          selected?.label ??
          (modelId == summary?.model ? summary?.modelLabel : null) ??
          modelId,
      selectedModelId: modelId,
      availableModels: catalog.models,
      providerAvailability: catalog.providerAvailability,
      effort: null,
      speed: CanopyEffortSpeed.regular,
      supportsFastMode: false,
      isRunning: isRunning,
      catalogStatus: catalog.projected
          ? ModelCatalogStatus.loaded
          : ModelCatalogStatus.absent,
      emptyCatalogHint: 'Check model settings in the desktop app.',
      lockedHarness: summary?.modelHarnessLocked == false
          ? null
          : summary?.executionHarness,
      onSelectModel: !canAct || (chatId == null && advisor.isStartingChat)
          ? null
          : chatId == null
          ? (id, {executionHarness}) => setState(() => _newChatModel = id)
          : (id, {executionHarness}) => unawaited(
              advisor.setModel(chatId, id, executionHarness: executionHarness),
            ),
      onToggleFast: () {},
      onStop: () {
        if (chatId != null) unawaited(advisor.cancel(chatId));
      },
    );
  }

  void _select(String chatId) {
    if (chatId == _chatId) return;
    setState(() {
      _chatId = chatId;
      _selectionGeneration++;
      _expandedTurns.clear();
    });
  }

  @override
  Widget build(BuildContext context) {
    final viewModel = context.watch<RemoteControlViewModel>();
    final advisor = viewModel.appAdvisor;
    var selectedChatId = _chatId;
    final recoveredChatId = advisor.chatForFirstSend(_newChatMessageId);
    if (selectedChatId == null && recoveredChatId != null) {
      selectedChatId = recoveredChatId;
      _chatId = recoveredChatId;
      _selectionGeneration++;
      _expandedTurns.clear();
    }
    var selectedEntry = selectedChatId == null
        ? null
        : advisor.entryFor(selectedChatId);
    if (selectedChatId != null && selectedEntry == null && _entryKey != null) {
      selectedEntry = advisor.entries
          .where((row) => row.key == _entryKey)
          .firstOrNull;
      if (selectedEntry != null) {
        selectedChatId = selectedEntry.activeChatId;
        _chatId = selectedChatId;
        _selectionGeneration++;
        _expandedTurns.clear();
      }
    }
    final chatId = selectedChatId;
    final entry = selectedEntry;
    if (entry != null) _entryKey = entry.key;
    final tabs = entry == null
        ? const <RemoteChatSummary>[]
        : advisor.tabsFor(entry);
    final title =
        tabs.where((tab) => tab.chatId == chatId).firstOrNull?.displayTitle ??
        (chatId == null ? 'New chat' : 'Orchestrator');

    if (!advisor.isSupported) {
      return CanopyScaffold(
        appBar: CanopyAppBar(
          automaticallyImplyLeading: true,
          content: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis),
        ),
        body: const AppAdvisorUpdatePrompt(),
      );
    }

    final canAct =
        advisor.canAct &&
        (chatId == null || entry != null || _entryKey == null);
    // Load the open chat's transcript on its own instead of waiting on the
    // whole list, including after a tab switch.
    if (chatId != null && canAct && advisor.needsChatLoad(chatId)) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) unawaited(advisor.loadChat(chatId));
      });
    }
    final startingMessage = chatId == null ? advisor.startingMessage : null;
    final messages = chatId != null
        ? advisor.messagesFor(chatId)
        : [
            for (final message in advisor.messagesFor(''))
              if (message.messageId != startingMessage?.messageId) message,
            ?startingMessage,
          ];
    final isRunning = chatId != null && advisor.isRunning(chatId);
    final questionCards = [
      if (chatId != null)
        for (final request in advisor.pendingQuestionsFor(chatId))
          PendingQuestionCard(
            key: ValueKey('question-${request.requestId}'),
            request: request,
            onSubmit: canAct
                ? (answers) => unawaited(
                    advisor.answerQuestion(
                      chatId,
                      requestId: request.requestId,
                      answers: answers,
                    ),
                  )
                : null,
            onDismiss: () {
              if (canAct) {
                unawaited(
                  advisor.dismissQuestion(chatId, requestId: request.requestId),
                );
              }
            },
          ),
    ];
    final showDegraded = RemoteDegradedBanner.shows(
      status: viewModel.portalConnectionStatus,
      linkState: viewModel.linkState,
    );
    final hasFeed =
        messages.isNotEmpty || questionCards.isNotEmpty || isRunning;
    final showTabs = entry != null;

    final Widget transcript;
    if (hasFeed) {
      transcript = ChatFeed(
        chatId: chatId ?? '',
        messages: messages,
        expandedTurns: _expandedTurns,
        turnInProgress: isRunning || startingMessage != null,
        onToggleTurn: (key) => setState(() {
          if (!_expandedTurns.remove(key)) _expandedTurns.add(key);
        }),
        trailing: questionCards,
        onResend: !canAct || (chatId == null && advisor.isStartingChat)
            ? null
            : (messageId) => unawaited(_resend(advisor, messageId)),
        canResend: (message) => message.delivery == ChatDelivery.notSent,
        onDiscard: (messageId) =>
            advisor.discardFailedMessage(chatId ?? '', messageId),
        bottomActionInset: showTabs ? CanopyOverlayAction.stackOffset : 0,
      );
    } else if (chatId != null && advisor.chatLoadError(chatId) != null) {
      transcript = const SizedBox.shrink();
    } else {
      final theme = Theme.of(context);
      final loading = chatId != null && advisor.isLoadingChat(chatId);
      transcript = Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (loading) ...[
                const LoadingSpinner(size: 20),
                const SizedBox(height: 12),
              ],
              Text(
                loading
                    ? 'Loading conversation…'
                    : chatId == null
                    ? 'Send a message to start a chat.'
                    : 'No messages yet.',
                key: const ValueKey('app-advisor-transcript-status'),
                textAlign: TextAlign.center,
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
      );
    }

    return CanopyScaffold(
      appBar: CanopyAppBar(
        automaticallyImplyLeading: true,
        content: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis),
        subtitle: entry != null && entry.title != title
            ? Text(entry.title, maxLines: 1, overflow: TextOverflow.ellipsis)
            : null,
      ),
      body: Builder(
        builder: (context) => Padding(
          padding: CanopyScaffold.contentPaddingOf(context),
          child: Column(
            children: [
              if (showDegraded)
                RemoteDegradedBanner(
                  status: viewModel.portalConnectionStatus,
                  linkState: viewModel.linkState,
                  deviceLabel: viewModel.connection?.deviceLabel,
                ),
              if (advisor.actionError case final message?)
                CommandFailureBanner(
                  key: const ValueKey('app-advisor-error'),
                  message: message,
                  onDismiss: advisor.clearActionError,
                ),
              if (chatId != null && advisor.chatLoadError(chatId) != null)
                Padding(
                  padding: const EdgeInsets.all(16),
                  child: Row(
                    children: [
                      const Expanded(
                        child: Text("Couldn't load the conversation."),
                      ),
                      TextButton(
                        onPressed: canAct
                            ? () => unawaited(advisor.retryChatLoad(chatId))
                            : null,
                        child: const Text('Retry'),
                      ),
                    ],
                  ),
                ),
              Expanded(
                child: ChatBody(
                  transcript: Stack(
                    children: [
                      Positioned.fill(child: transcript),
                      if (entry != null)
                        Positioned(
                          right: CanopyOverlayAction.gutter,
                          bottom: 0,
                          child: ChatTabsFab(
                            hasUnread: false,
                            needsAnswer: entry.needsAnswer,
                            onPressed: () => unawaited(
                              showChatTabsSheet(
                                context,
                                summaries: tabs,
                                selectedChatId: chatId,
                                chatState: viewModel,
                                resolveLiveState: () {
                                  final live = advisor.entryFor(chatId!);
                                  final liveTabs = live == null
                                      ? tabs
                                      : advisor.tabsFor(live);
                                  return ChatTabsLiveState(
                                    working: {
                                      for (final tab in liveTabs)
                                        if (advisor.isRunning(tab.chatId))
                                          tab.chatId,
                                    },
                                    needsAnswer: {
                                      for (final tab in liveTabs)
                                        if (advisor
                                            .pendingQuestionsFor(tab.chatId)
                                            .isNotEmpty)
                                          tab.chatId,
                                    },
                                  );
                                },
                                onSelect: _select,
                                onNewChat: () {
                                  if (canAct) _select(advisor.createTab(entry));
                                },
                              ),
                            ),
                          ),
                        ),
                    ],
                  ),
                  composer: ChatInput(
                    controller: _composer,
                    sending: _sending,
                    enabled:
                        canAct && !(chatId == null && advisor.isStartingChat),
                    hintText: 'Message Orchestrator…',
                    controls: _composerControls(
                      advisor,
                      chatId,
                      isRunning: isRunning,
                      canAct: canAct,
                    ),
                    onSend: () => unawaited(_send(advisor)),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
