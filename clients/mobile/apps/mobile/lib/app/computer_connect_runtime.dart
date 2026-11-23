import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:provider/provider.dart';

import 'computer_connect_transport.dart';
import 'rust_computer_connect.dart';

/// Holds the Computer Connect core for the app's lifetime.
class ComputerConnectRuntimeScope extends StatelessWidget {
  const ComputerConnectRuntimeScope({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) => Provider<ComputerConnectTransport>(
    create: (_) => RustComputerConnectTransport(),
    dispose: (_, transport) => unawaited(transport.close()),
    child: child,
  );
}
