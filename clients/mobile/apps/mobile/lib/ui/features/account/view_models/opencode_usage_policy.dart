import 'package:mobile/data/protocol/generated/provider_usage.dart';

String openCodeUsageDescription(OpenCodeAccountUsage? usage) =>
    switch (usage?.status) {
      'ready' => usage?.plan ?? 'Usage',
      'not-selected' => 'Select this account in OpenCode to view usage',
      'sign-in-required' => 'Sign in again on desktop to view usage',
      'unavailable' => 'Usage is unavailable. Refresh on your desktop.',
      _ => 'This provider does not report plan or usage limits here',
    };

/// Use the same window display and expired-reset policy as other providers.
List<RemoteControlProviderUsageWindow> openCodeUsageWindows(
  OpenCodeAccountUsage? usage,
) => usage?.status != 'ready'
    ? const []
    : [
        for (final window in usage?.windows ?? <OpenCodeUsageWindow>[])
          RemoteControlProviderUsageWindow(
            id: window.id,
            label: switch (window.id) {
              'rolling' => 'Rolling usage',
              'weekly' => 'Weekly usage',
              'monthly' => 'Monthly usage',
              _ => 'Usage',
            },
            usedPercent: window.percent,
            resetsAt: window.resetsAt,
          ),
      ];
