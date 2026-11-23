import 'dart:async';

import 'package:computer_connect_core/computer_connect_core.dart';
import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/device_link/chats/repository.dart';

import '../../chats_view_model.dart';
import '../account_model.dart';
import '../controller.dart';
import '../home_launcher.dart';
import '../orchestrator/model.dart';
import 'rust_home.dart';
import 'rust_link.dart';
import 'rust_activity.dart';
import 'rust_chats.dart';
import 'rust_composer.dart';
import 'rust_orchestrator.dart';
import 'rust_overview.dart';
import 'rust_pipelines.dart';
import 'rust_sends.dart';
import 'rust_writes.dart';

/// Composes the Flutter controllers for each computer in the account view.
final class RustComputerSessions extends ChangeNotifier
    implements ComputerSessions {
  RustComputerSessions({required this.apply});

  final void Function(AccountView view) apply;

  final _homes = <String, RustHome>{};

  RustHome _home(String id) {
    final existing = _homes[id];
    if (existing != null) return existing;
    return _homes[id] = RustHome(_service!.home(computerId: id));
  }

  AccountService? _service;
  final _sessions = <String, ComputerConnectController>{};
  final _links = <ComputerConnectController, RustComputerLink>{};
  final _homeLaunchers = <String, ComputerHomeLauncher>{};
  final _orchestrators = <String, ComputerOrchestrator>{};
  String? _selectedId;
  bool _disposed = false;

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  /// [binding] is the account binding of the view that first listed [id];
  /// the connection's intents carry it.
  ComputerConnectController _create(
    AccountService service,
    String id,
    int binding,
  ) {
    final connection = RustComputerLink(
      service: service.connection(computerId: id, binding: binding),
      apply: apply,
    );
    late final RustComputerOverview overview;
    final reader = RustChatReader(service.chats(computerId: id));
    final chats = DeviceChatsViewModel(
      connection: connection,
      chats: DeviceChatsRepository(
        reader,
        readCatalog: () => overview.readCatalog(),
        sender: RustChatSender(reader),
      ),
      feed: reader.feed,
      drafts: RustChatDrafts(reader),
      createActivity: () => RustComputerActivity(
        reader.service.activity(),
        pipelines: RustComputerPipelines(reader.service.pipelines()),
      ),
      createFiles: () =>
          RustComputerFiles(service.files(computerId: id), reader),
      composer: RustComputerChatComposer(reader),
    );
    final home = _home(id);
    home.service.bindChats(chats: reader.service);
    final controller = ComputerConnectController(
      chats,
      writes: rustComputerWrites(service, id, home),
      overview: overview = RustComputerOverview(
        service: service.overview(
          computerId: id,
          locale: PlatformDispatcher.instance.locale.toLanguageTag(),
        ),
        chats: chats,
      ),
    );
    _links[controller] = connection;
    return controller
      ..setActive(false)
      ..addListener(_changed);
  }

  /// Follows the core's remembered computers and selection.
  void sync(AccountService service, AccountView view) {
    if (_disposed) return;
    _service = service;
    for (final connection in view.connections) {
      final id = connection.computerId;
      final controller = _sessions[id] ??= _create(service, id, view.binding);
      _links[controller]?.update(connection);
    }
    final next = view.selected;
    final previous = selected;
    _selectedId = next != null && _sessions.containsKey(next) ? next : null;
    if (!identical(previous, selected)) {
      previous?.setActive(false);
      selected?.setActive(true);
      _changed();
    }
  }

  @override
  ComputerConnectController? get selected => _sessions[_selectedId];
  @override
  String? get selectedId => _selectedId;
  @override
  Map<String, ComputerConnectController> get sessions =>
      Map.unmodifiable(_sessions);

  @override
  ComputerOrchestrator? get orchestrator {
    final id = _selectedId;
    if (id == null) return null;
    return _orchestrators.putIfAbsent(
      id,
      () => RustComputerOrchestrator(
        connection: selected!.chats.connection,
        service: _service!.orchestrator(computerId: id),
      ),
    );
  }

  @override
  ComputerHomeLauncher get homeLauncher {
    final id = _selectedId;
    if (id == null) throw StateError('Choose a computer first.');
    return _homeLaunchers.putIfAbsent(id, () {
      final home = _home(id);
      // Home's drafts are the core's; text typed before they are read is
      // kept and joined to the stored draft (the binding adopts it).
      final launcher = RustComputerHomeLauncher(
        home,
        selected!,
        id,
        InMemoryChatDraftStore(),
      );
      unawaited(
        RustHomeDrafts.open(home.service).then(
          (drafts) {
            if (!_disposed) launcher.bindDraftStore(drafts);
          },
          onError: (Object error) =>
              debugPrint('Home drafts were not read: $error'),
        ),
      );
      return launcher;
    });
  }

  @override
  void dispose() {
    _disposed = true;
    for (final launcher in _homeLaunchers.values) {
      launcher.dispose();
    }
    _homeLaunchers.clear();
    for (final controller in _orchestrators.values) {
      controller.dispose();
    }
    _orchestrators.clear();
    for (final controller in _sessions.values) {
      controller.removeListener(_changed);
      controller.setActive(false);
      controller.dispose();
      controller.chats.dispose();
    }
    _sessions.clear();
    _links.clear();
    for (final home in _homes.values) {
      home.service.send(intent: const HomeIntent.close());
      home.dispose();
    }
    _homes.clear();
    super.dispose();
  }
}
