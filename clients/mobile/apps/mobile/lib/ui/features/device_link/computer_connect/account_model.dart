import 'package:computer_connect_core/computer_connect_core.dart'
    show SetupRow, SwitcherRow;
import 'package:flutter/widgets.dart';
import 'package:mobile/device_link/desktop/saved_computer.dart';
import 'controller.dart';
import 'home_launcher.dart';
import 'orchestrator/model.dart';

export 'package:computer_connect_core/computer_connect_core.dart'
    show SetupRow, StatusTone, SwitcherRow;

/// One signed-in account's saved computers, connection state and actions.
abstract interface class ComputerAccountModel implements Listenable {
  /// The per-computer feature controllers and the selected computer.
  ComputerSessions get sessions;

  /// Saved settings were read; setup can show.
  bool get ready;
  bool get busy;
  bool get finding;
  bool get accessDenied;

  /// Discovery reached the relay at least once.
  bool get discovered;

  /// The selected computer has been unreachable for the offline grace.
  bool get offline;

  /// A selectable computer is selected.
  bool get hasSelectedComputer;

  /// The account's own failure.
  String? get error;

  /// What setup shows: the account's failure, else the selected computer's
  /// connection failure.
  String? get notice;
  String? get selectedName;

  /// Saved computers in saved order.
  List<SavedComputer> get computers;

  /// Saved computers the switcher offers.
  List<SavedComputer> get selectableComputers;

  /// Saved computers with a live or recovering session.
  List<SavedComputer> get connectedComputers;

  /// Setup's one list: saved computers, then unsaved online ones by name.
  List<SetupRow> get setupRows;

  /// [computer] as the switcher menu shows it.
  SwitcherRow switcherRow(SavedComputer computer);

  Future<void> restore();
  Future<void> findComputers();
  Future<void> connect(String id);
  Future<void> select(String id);
  Future<void> disconnect(String id);
  Future<void> forget(String id);

  /// Cancels the connection attempt shown on [id]'s setup row.
  Future<void> cancelConnect(String id);

  /// The app moved to [state]: sessions close after a grace in the
  /// background and recover in the foreground.
  Future<void> lifecycleChanged(AppLifecycleState state);
  void dispose();
}

/// One account's per-computer feature controllers. Selection is navigation:
/// changing it never swaps a controller under a mounted screen.
abstract interface class ComputerSessions implements Listenable {
  ComputerConnectController? get selected;
  String? get selectedId;
  Map<String, ComputerConnectController> get sessions;
  ComputerOrchestrator? get orchestrator;
  ComputerHomeLauncher get homeLauncher;
}
