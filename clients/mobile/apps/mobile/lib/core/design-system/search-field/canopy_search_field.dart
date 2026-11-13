import 'package:flutter/material.dart';
import 'package:mobile/ui/core/design_tokens.dart';

import '../icon-button/canopy_icon_button.dart';
import '../icon/canopy_glyph.dart';
import '../icon/canopy_icon.dart';
import '../text-field/canopy_text_field.dart';

/// Shared search input: a filled, rounded field with a leading magnifier and
/// a trailing Clear action while it holds text.
///
/// It replaces per-screen search fields that each picked their own border,
/// icon and tint. The field has no underline or outline in any state; focus
/// tints the fill with the focus color instead. The caller owns [controller]
/// and decides what a change or submit means — the field only edits text.
class CanopySearchField extends StatelessWidget {
  const CanopySearchField({
    super.key,
    required this.controller,
    required this.hintText,
    this.onChanged,
    this.onSubmitted,
    this.textInputAction = TextInputAction.search,
    this.autofocus = false,
    this.focusNode,
  });

  /// Magnifier size: reads alongside the 16px body text without outgrowing it.
  static const double glyphSize = 20;

  final TextEditingController controller;
  final String hintText;

  /// Called on each edit, and with an empty string when Clear is tapped.
  final ValueChanged<String>? onChanged;

  /// Called when the keyboard action key is pressed.
  final ValueChanged<String>? onSubmitted;
  final TextInputAction textInputAction;
  final bool autofocus;
  final FocusNode? focusNode;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return ValueListenableBuilder<TextEditingValue>(
      valueListenable: controller,
      builder: (context, value, _) => CanopyTextField(
        controller: controller,
        focusNode: focusNode,
        autofocus: autofocus,
        textInputAction: textInputAction,
        onChanged: onChanged,
        onSubmitted: onSubmitted,
        hintText: hintText,
        // Center the glyph so the 48px slot cannot stretch it.
        prefixIcon: Center(
          widthFactor: 1,
          heightFactor: 1,
          child: Padding(
            padding: const EdgeInsetsDirectional.only(start: 12, end: 8),
            child: CanopyIcon(
              glyph: CanopyGlyph.magnifyingGlass,
              size: CanopySearchField.glyphSize,
              tint: colors.foregroundSecondary,
            ),
          ),
        ),
        suffixIcon: value.text.isEmpty
            ? null
            : CanopyIconButton(
                glyph: CanopyGlyph.crossSmall,
                tooltip: 'Clear',
                size: CanopyIconButtonSize.small,
                onPressed: () {
                  controller.clear();
                  onChanged?.call('');
                },
              ),
      ),
    );
  }
}
