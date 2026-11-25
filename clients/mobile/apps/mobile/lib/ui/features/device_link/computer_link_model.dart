import 'package:computer_connect_core/computer_connect_core.dart'
    show LinkPhase;
import 'package:flutter/foundation.dart';

typedef DesktopLinkPhase = LinkPhase;

/// The connection state and reconnect action for one computer.
abstract interface class ComputerLinkModel implements Listenable {
  DesktopLinkPhase get phase;
  int? get connectedSession;

  /// The computer's name from its hello, while one is known.
  String? get hostName;
  bool get reconnecting;
  Future<void> reconnect();

  /// Whether a reconnect has lasted long enough to show, for one screen.
  ReconnectNotice reconnectNotice({required bool foreground});
  void dispose();
}

/// Keeps brief foreground reconnects quiet on one screen.
abstract interface class ReconnectNotice implements Listenable {
  bool get visible;
  void setForeground(bool value);
  void dispose();
}
