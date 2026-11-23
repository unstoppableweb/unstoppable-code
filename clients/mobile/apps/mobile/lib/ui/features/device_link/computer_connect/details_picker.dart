import 'dart:async';
import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'account_model.dart';
import 'computer_switcher.dart';
import 'connection_view.dart';

/// Keeps a detail page's title and selected computer together in its app bar.
class ComputerDetailsPicker extends StatelessWidget {
  const ComputerDetailsPicker({
    super.key,
    required this.account,
    required this.title,
  });
  final ComputerAccountModel account;
  final String title;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: account,
    builder: (context, _) => ComputerSwitcher(
      account: account,
      title: title,
      label:
          account.sessions.selected?.chats.connection.hostName ??
          account.selectedName ??
          'Choose a computer',
      onManage: () => unawaited(showComputerConnections(context, account)),
    ),
  );
}

/// Home and detail pickers open the same management page on their navigator.
Future<void> showComputerConnections(
  BuildContext context,
  ComputerAccountModel account,
) => Navigator.of(context).push<void>(
  MaterialPageRoute(
    builder: (_) => CanopyScaffold(
      appBar: const CanopyAppBar(
        content: Text('Computers'),
        automaticallyImplyLeading: true,
      ),
      body: ComputerConnectionView(account: account),
    ),
  ),
);
