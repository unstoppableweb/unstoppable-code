import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/ui/core/widgets/inline_notice.dart';
import '../chats_view_model.dart';

/// A refused write is not a failed catalog read and never offers a read retry.
class DeviceSettingsNotice extends StatelessWidget {
  const DeviceSettingsNotice({required this.model, super.key});

  final DeviceChatsViewModel model;

  @override
  Widget build(BuildContext context) {
    final failure = model.composer.failure;
    final catalogError = model.settingsCatalogError;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (failure != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 8, 20, 0),
            child: InlineNotice(
              key: const ValueKey('device-settings-change-failure'),
              glyph: CanopyGlyph.exclamationTriangle,
              // Match the web notice: a missing reply is not a desktop refusal.
              state: failure.modelChange
                  ? failure.reported
                        ? 'Model change failed.'
                        : 'Model change not confirmed.'
                  : failure.reported
                  ? 'Settings change failed.'
                  : 'Settings change not confirmed.',
              explanation: failure.message,
            ),
          ),
        if (catalogError != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 8, 20, 0),
            child: InlineNotice(
              key: const ValueKey('device-settings-catalog-failure'),
              glyph: CanopyGlyph.exclamationTriangle,
              state: "Couldn't load models.",
              explanation: catalogError,
              actions: [
                (
                  label: 'Try again',
                  glyph: CanopyGlyph.arrowRotateClockwise,
                  onPressed: () => unawaited(model.loadSettings()),
                ),
              ],
            ),
          ),
      ],
    );
  }
}
