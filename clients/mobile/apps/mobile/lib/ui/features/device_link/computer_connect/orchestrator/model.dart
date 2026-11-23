import 'package:computer_connect_core/computer_connect_core.dart' as core;
import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/chat_message.dart';

import '../../chats_view_model.dart';

/// A work entry as the Orchestrator lists it: the core's view, which the
/// Dart catalog builds too.
typedef OrchestratorEntry = core.OrchestratorEntryView;

/// One computer's Orchestrator as its screen reads it: the work entries,
/// the questions the desktop asks, the window visibility and the
/// Orchestrator chat. Implemented in Dart (`ComputerOrchestratorController`,
/// deprecated) and over the core's `OrchestratorService` (P9).
abstract interface class ComputerOrchestrator implements Listenable {
  /// The Orchestrator chat, on the `app-advisor` surface.
  DeviceChatsViewModel get chats;

  /// In the desktop's registry order.
  List<OrchestratorEntry> get entries;

  /// The questions the desktop asks in [chatId].
  List<AskUserQuestionState> pendingFor(String chatId);

  /// Whether the Orchestrator shows; the desktop sees it as its window.
  void setVisible(bool value);

  /// Reads the list again and claims its chats' state.
  Future<void> refresh();

  /// Opens [entry]'s active chat (a new tab when it has none), or a new
  /// chat when [entry] is null. Whether a chat is open.
  Future<bool> open(OrchestratorEntry? entry);

  /// Leaves the open chat; [refreshCatalog] reads the list again.
  Future<void> leaveChat({bool refreshCatalog = true});

  void dispose();
}
