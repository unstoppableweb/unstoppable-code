import 'package:computer_connect_core/computer_connect_core.dart';
import 'package:flutter/foundation.dart';

import '../../computer_link_model.dart';

/// One computer's connection as the core's [ConnectionService] reports it.
/// The core owns the phase, pairing, recovery and errors; this model maps
/// the latest [ConnectionView] to [ComputerLinkModel] and forwards intents.
final class RustComputerLink extends ChangeNotifier
    implements ComputerLinkModel {
  RustComputerLink({required this.service, required this.apply});

  final ConnectionService service;

  /// Applies the view an intent resolved with.
  final void Function(AccountView view) apply;
  ConnectionView? _view;
  bool _disposed = false;

  /// Set while listeners hear that the session they read ended, before
  /// the view that already shows the next one.
  bool _replaced = false;

  void update(ConnectionView? view) {
    if (_disposed || view == _view) return;
    final previous = _view;
    _view = view;
    // Views coalesce: a session can replace another with no other phase
    // seen between them. The account's state is what tells a computer's
    // features that their session ended, so they hear it here.
    if (previous?.phase == LinkPhase.connected &&
        view?.phase == LinkPhase.connected &&
        previous?.session != view?.session) {
      _replaced = true;
      notifyListeners();
      _replaced = false;
      if (_disposed) return;
    }
    notifyListeners();
  }

  Future<void> _intent(
    Future<AccountView> Function(ConnectionService service) intent,
  ) async {
    if (_disposed) return;
    try {
      apply(await intent(service));
    } on CoreFailure catch (error) {
      debugPrint('Computer connection intent failed: ${error.code}');
    }
  }

  @override
  DesktopLinkPhase get phase => _replaced
      ? LinkPhase.reconnecting
      : _view?.phase ?? LinkPhase.disconnected;
  @override
  String? get hostName => _view?.hostName;
  @override
  bool get reconnecting => phase == DesktopLinkPhase.reconnecting;
  bool get reconnectNoticeVisible => _view?.reconnectNoticeVisible == true;

  @override
  Future<void> reconnect() => _intent((service) => service.reconnect());

  @override
  ReconnectNotice reconnectNotice({required bool foreground}) =>
      RustReconnectNotice(this);

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}

/// The core decides when a reconnect is worth mentioning: after its delay,
/// while the app is in the foreground (it gets the app lifecycle from the
/// account service), so [setForeground] has nothing to do.
final class RustReconnectNotice extends ChangeNotifier
    implements ReconnectNotice {
  RustReconnectNotice(this.link) {
    link.addListener(notifyListeners);
  }
  final RustComputerLink link;
  @override
  bool get visible => link.reconnectNoticeVisible;
  @override
  void setForeground(bool value) {}
  @override
  void dispose() {
    link.removeListener(notifyListeners);
    super.dispose();
  }
}
