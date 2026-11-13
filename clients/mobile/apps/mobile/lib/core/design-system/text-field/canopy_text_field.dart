import 'package:flutter/material.dart';
import 'package:mobile/ui/core/design_tokens.dart';

/// Shared filled input for forms and search. The caller owns the controller;
/// this component owns field geometry, focus, and supporting text.
class CanopyTextField extends StatefulWidget {
  const CanopyTextField({
    super.key,
    required this.controller,
    this.labelText,
    this.hintText,
    this.helperText,
    this.errorText,
    this.enabled = true,
    this.autofocus = false,
    this.obscureText = false,
    this.keyboardType,
    this.textInputAction,
    this.onChanged,
    this.onSubmitted,
    this.prefixIcon,
    this.suffixIcon,
    this.focusNode,
  });

  final TextEditingController controller;
  final String? labelText;
  final String? hintText;
  final String? helperText;
  final String? errorText;
  final bool enabled;
  final bool autofocus;
  final bool obscureText;
  final TextInputType? keyboardType;
  final TextInputAction? textInputAction;
  final ValueChanged<String>? onChanged;
  final ValueChanged<String>? onSubmitted;
  final Widget? prefixIcon;
  final Widget? suffixIcon;
  final FocusNode? focusNode;

  @override
  State<CanopyTextField> createState() => _CanopyTextFieldState();
}

class _CanopyTextFieldState extends State<CanopyTextField> {
  late FocusNode _focusNode;

  @override
  void initState() {
    super.initState();
    _focusNode = widget.focusNode ?? FocusNode();
    _focusNode.addListener(_rebuild);
  }

  void _rebuild() => setState(() {});

  @override
  void didUpdateWidget(CanopyTextField oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.focusNode == oldWidget.focusNode) return;
    _focusNode.removeListener(_rebuild);
    if (oldWidget.focusNode == null) _focusNode.dispose();
    _focusNode = widget.focusNode ?? FocusNode();
    _focusNode.addListener(_rebuild);
  }

  @override
  void dispose() {
    _focusNode.removeListener(_rebuild);
    if (widget.focusNode == null) _focusNode.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final textTheme = Theme.of(context).textTheme;
    const shape = OutlineInputBorder(
      borderRadius: BorderRadius.all(Radius.circular(AppRadii.lg)),
      borderSide: BorderSide.none,
    );
    final fill = _focusNode.hasFocus && widget.enabled
        ? Color.alphaBlend(
            colors.focus.withValues(alpha: 0.16),
            colors.surfaceRaised,
          )
        : colors.surfaceRaised;
    return TextField(
      controller: widget.controller,
      focusNode: _focusNode,
      enabled: widget.enabled,
      autofocus: widget.autofocus,
      obscureText: widget.obscureText,
      autocorrect: !widget.obscureText,
      enableSuggestions: !widget.obscureText,
      enableIMEPersonalizedLearning: !widget.obscureText,
      keyboardType: widget.keyboardType,
      textInputAction: widget.textInputAction,
      onChanged: widget.onChanged,
      onSubmitted: widget.onSubmitted,
      cursorColor: colors.focus,
      style: textTheme.bodyLarge?.copyWith(
        color: widget.enabled ? colors.foreground : colors.disabledTint,
      ),
      decoration: InputDecoration(
        labelText: widget.labelText,
        hintText: widget.hintText,
        hintStyle: TextStyle(color: colors.foregroundSecondary),
        helperText: widget.helperText,
        helperMaxLines: 3,
        helperStyle: textTheme.bodySmall?.copyWith(
          color: colors.foregroundSecondary,
        ),
        errorText: widget.errorText,
        errorMaxLines: 3,
        errorStyle: textTheme.bodySmall?.copyWith(
          color: colors['fg-destructive'],
        ),
        filled: true,
        fillColor: fill,
        hoverColor: fill,
        constraints: const BoxConstraints(minHeight: 48),
        contentPadding: EdgeInsets.symmetric(
          horizontal: widget.prefixIcon == null ? 12 : 0,
          vertical: 12,
        ),
        border: shape,
        enabledBorder: shape,
        focusedBorder: shape,
        disabledBorder: shape,
        errorBorder: shape,
        focusedErrorBorder: shape,
        prefixIcon: widget.prefixIcon,
        prefixIconConstraints: const BoxConstraints(minHeight: 48),
        suffixIcon: widget.suffixIcon,
      ),
    );
  }
}
