import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:flutter/material.dart';
import 'package:mobile/ui/features/developer_options/views/design_system_screen.dart';

/// Entry point for tools and references that ship only in non-production
/// builds.
class DeveloperOptionsScreen extends StatelessWidget {
  const DeveloperOptionsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return CanopyScaffold(
      appBar: CanopyAppBar(
        automaticallyImplyLeading: true,
        content: const Text('Developer options'),
      ),
      body: Builder(
        builder: (context) => ListView(
          padding:
              CanopyScaffold.contentPaddingOf(context) +
              const EdgeInsets.symmetric(vertical: 8),
          children: [
            ListTile(
              key: const ValueKey('design-system-button'),
              leading: const Icon(Icons.design_services_outlined),
              title: const Text('Design system'),
              subtitle: const Text('Components and visual references'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => const DesignSystemScreen(),
                ),
              ),
            ),
            const SizedBox(height: 16),
          ],
        ),
      ),
    );
  }
}
