import 'dart:async';

import 'package:computer_connect_core/computer_connect_core.dart';
import 'package:flutter/widgets.dart';
import 'package:mobile/device_link/desktop/saved_computer.dart';
import 'package:mobile/device_link/rust_core/account_link.dart';
import 'package:mobile/device_link/rust_core/failures.dart';

import '../account_model.dart';
import 'rust_sessions.dart';

/// One signed-in account's computers over the Rust core's [AccountService].
/// The core owns saved computers, selection, discovery and its backoff,
/// recovery, access denial, the background grace and every status and
/// notice; this model maps the latest [AccountView] to
/// [ComputerAccountModel] and forwards intents.
///
/// The app keeps its own sign-in: before work that may need the relay, the
/// app's session is adopted through [link] (the same session the Dart
/// transport's token route uses).
final class RustComputerAccount extends ChangeNotifier
    implements ComputerAccountModel {
  RustComputerAccount({
    required this.open,
    required this.link,
    required this.accountId,
    this.prepare,
  }) {
    sessions = RustComputerSessions(apply: _apply)
      ..addListener(_sessionsChanged);
    _open().ignore();
  }

  final RustDesktopAccountLink link;
  final String accountId;

  /// Runs before the first restore until it succeeds, for example a
  /// one-time import. `current` turns false once this account scope is
  /// disposed.
  final Future<void> Function(bool Function() current)? prepare;

  /// Opens the core's account service; a call after a failed open opens
  /// the core again.
  final Future<AccountService> Function() open;
  StreamSubscription<AccountView>? _views;
  AccountService? _service;
  @override
  late final RustComputerSessions sessions;
  AccountView? _view;
  int? _binding;
  bool _disposed = false;
  Future<void>? _prepared;

  // The last lifecycle state sent, or waiting to be; see [_lifecycle].
  Future<void> _lifecycleSends = Future.value();

  // Set while the core did not open or the account did not restore; setup
  // shows it and offers a retry.
  String? _failure;

  void _setFailure(String? failure) {
    if (_disposed || _failure == failure) return;
    _failure = failure;
    notifyListeners();
  }

  Future<AccountService> _open() async {
    if (_service case final service?) return service;
    _setFailure(null);
    final AccountService opened;
    try {
      opened = await open();
    } catch (error) {
      debugPrint('Computer connection core did not open: $error');
      _setFailure(unknownFailureMessage);
      rethrow;
    }
    if (_service == null && !_disposed) {
      _service = opened;
    }
    return opened;
  }

  void _sessionsChanged() {
    if (!_disposed) notifyListeners();
  }

  void _apply(AccountView view) {
    if (_disposed || view.binding != _binding) return;
    final current = _view;
    if (current != null && view.revision <= current.revision) return;
    _view = view;
    sessions.sync(_service!, view);
    notifyListeners();
  }

  /// Runs [intent] on the service and applies the view it resolved with, if
  /// any.
  /// With [adopt], the app's session is handed over first.
  Future<void> _intent(
    Future<AccountView?> Function(AccountService service) intent, {
    bool adopt = false,
  }) async {
    if (_disposed) return;
    try {
      final service = await _open();
      if (_disposed) return;
      if (adopt) await _adopt();
      if (_disposed) return;
      if (await intent(service) case final view?) _apply(view);
    } catch (error) {
      debugPrint('Computer connection account intent failed: $error');
    }
  }

  /// Hands the app's session to the core. A failure is not thrown: the core
  /// then reports the missing sign-in as access denied.
  Future<void> _adopt() async {
    if (_disposed) return;
    try {
      await link.client.adoptSession();
    } catch (error) {
      debugPrint('Computer connection sign-in not adopted: $error');
    }
  }

  /// [_intent] for the binding this account restored. The core refuses it
  /// once another account restored; before a restore nothing is sent.
  Future<void> _bound(
    Future<AccountView> Function(AccountService service, int binding) intent, {
    bool adopt = false,
  }) => _intent((service) async {
    final binding = _binding;
    return binding == null ? null : intent(service, binding);
  }, adopt: adopt);

  // Before the first view, the account is restoring: setup stays blank.
  @override
  bool get ready => _view?.ready ?? false;
  @override
  bool get busy => _view?.busy ?? _failure == null;
  @override
  bool get finding => _view?.finding ?? false;
  @override
  bool get accessDenied => _view?.accessDenied ?? false;
  @override
  bool get discovered => _view?.discovered ?? false;
  @override
  bool get offline => _view?.offline ?? false;
  @override
  bool get hasSelectedComputer => _view?.hasSelectedComputer ?? false;
  @override
  String? get error => _view?.error?.message ?? _failure;
  @override
  String? get notice => _view?.setupNotice ?? _failure;
  @override
  String? get selectedName => _view?.selectedName;

  SavedComputer _saved(SavedComputerView c) =>
      SavedComputer(c.computerId, c.name, reconnect: c.reconnect);

  @override
  List<SavedComputer> get computers => [
    for (final c in _view?.saved ?? const <SavedComputerView>[]) _saved(c),
  ];

  List<SavedComputer> _subset(List<String>? ids) {
    final wanted = {...?ids};
    return [
      for (final c in _view?.saved ?? const <SavedComputerView>[])
        if (wanted.contains(c.computerId)) _saved(c),
    ];
  }

  @override
  List<SavedComputer> get selectableComputers => _subset(_view?.selectable);
  @override
  List<SavedComputer> get connectedComputers => _subset(_view?.connected);

  @override
  List<SetupRow> get setupRows => _view?.setupRows ?? const [];

  @override
  SwitcherRow switcherRow(SavedComputer computer) {
    for (final row in _view?.switcher ?? const <SwitcherRow>[]) {
      if (row.computerId == computer.id) return row;
    }
    // Not yet in a view: the core reports a saved computer as offline
    // until it has a session.
    return SwitcherRow(
      computerId: computer.id,
      name: computer.name,
      status: 'Offline',
    );
  }

  @override
  Future<void> restore() async {
    _setFailure(null);
    await _intent((service) async {
      try {
        if (prepare case final prepare?) {
          final prepared = _prepared ??= prepare(() => !_disposed);
          try {
            await prepared;
          } catch (_) {
            if (identical(_prepared, prepared)) _prepared = null;
            rethrow;
          }
          // The core binds whichever account restores last.
          if (_disposed) return null;
        }
        final restored = await service.restore(accountId: accountId);
        _binding = restored.binding;
        if (_disposed) {
          await service.close(binding: restored.binding);
          return null;
        }
        _apply(restored);
        _views ??= service.watch().listen(_apply);
        return null;
      } catch (_) {
        _setFailure(unknownFailureMessage);
        rethrow;
      }
    }, adopt: true);
  }

  @override
  Future<void> findComputers() => _failure != null
      ? restore()
      : _bound(
          (service, binding) => service.findComputers(binding: binding),
          adopt: true,
        );
  @override
  Future<void> connect(String id) => _bound(
    (service, binding) => service.connect(computerId: id, binding: binding),
    adopt: true,
  );
  @override
  Future<void> select(String id) => _bound(
    (service, binding) => service.select(computerId: id, binding: binding),
  );
  @override
  Future<void> disconnect(String id) => _bound(
    (service, binding) => service.disconnect(computerId: id, binding: binding),
  );
  @override
  Future<void> forget(String id) => _bound(
    (service, binding) => service.forget(computerId: id, binding: binding),
  );
  @override
  Future<void> cancelConnect(String id) => _bound(
    (service, binding) =>
        service.cancelConnect(computerId: id, binding: binding),
  );

  @override
  Future<void> lifecycleChanged(AppLifecycleState state) => switch (state) {
    // A core that did not open opens again only on an explicit retry.
    _ when _failure != null => Future.value(),
    AppLifecycleState.resumed => _lifecycle(AppLifecycle.resumed),
    AppLifecycleState.hidden ||
    AppLifecycleState.paused => _leaving(AppLifecycle.hidden),
    AppLifecycleState.inactive ||
    AppLifecycleState.detached => _leaving(AppLifecycle.inactive),
  };

  /// Sends [state] after every state reported before it. A resume first
  /// adopts the app's session; a state reported meanwhile waits for it
  /// instead of reaching the core first, where the late resume would undo
  /// it (cancel a hide's background grace, for one). The core so ends on
  /// the app's latest state.
  Future<void> _lifecycle(AppLifecycle state) =>
      _lifecycleSends = _lifecycleSends.then((_) async {
        if (state == AppLifecycle.resumed) await _adopt();
        await _intent((service) => service.appLifecycle(state: state));
      });

  /// The app leaves the foreground: the core also stores the drafts its
  /// services hold now instead of after their debounce, as the Dart draft
  /// store does. Storing them needs no session, so it does not wait behind
  /// an earlier resume.
  Future<void> _leaving(AppLifecycle state) => Future.wait([
    _lifecycle(state),
    _intent((service) async {
      await service.flushDrafts();
      return null;
    }),
  ]);

  @override
  void dispose() {
    _disposed = true;
    unawaited(_views?.cancel());
    final binding = _binding;
    final service = _service;
    sessions
      ..removeListener(_sessionsChanged)
      ..dispose();
    unawaited(() async {
      // A newer binding (the next account scope) keeps its sessions.
      if (service != null && binding != null) {
        try {
          await service.close(binding: binding);
        } catch (error) {
          debugPrint('Computer connection close failed: $error');
        }
      }
      await link.dispose();
    }());
    super.dispose();
  }
}
