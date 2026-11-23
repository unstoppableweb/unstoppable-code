import 'package:mobile/ui/core/provider_usage_source.dart';

/// The account scope owns and disposes this usage source.
abstract interface class ComputerUsageModel implements ProviderUsageSource {
  void dispose();
}
