/**
 * Declared pipeline input helpers (CAN-3019): which inputs a run form shows,
 * their starting values, their validation and the payload a run sends.
 * Shared by the Portal's New Task `task_ready` mode, its Plans card's
 * `plan_ready` dialog and the web Workflows page's cloud Run dialog
 * (CAN-6341), so every form validates declared inputs the same way.
 */
import type { PortalPipelineInputDefinition } from '@canopy/protocol/portal';

export function visibleInputDefinitions(
  definitions: Record<string, PortalPipelineInputDefinition> | undefined,
): Record<string, PortalPipelineInputDefinition> {
  return Object.fromEntries(
    Object.entries(definitions ?? {}).filter(
      ([, definition]) =>
        definition['hint-hide-ui-option'] !== true ||
        (definition.required === true && definition.default === undefined),
    ),
  );
}

export function initializeInputValues(
  definitions: Record<string, PortalPipelineInputDefinition>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(definitions).map(([name, definition]) => [
      name,
      definition.default === undefined ? '' : String(definition.default),
    ]),
  );
}

export function validateInputValues(
  definitions: Record<string, PortalPipelineInputDefinition>,
  values: Record<string, string>,
): Record<string, string> {
  const errors: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const [name, definition] of Object.entries(definitions)) {
    const value = values[name]?.trim() ?? '';
    if (definition.required && !value) {
      errors[name] = 'This field is required';
      continue;
    }
    if (!value) continue;
    if (definition.type === 'number') {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        errors[name] = 'Must be a valid number';
      } else if (definition.min !== undefined && parsed < definition.min) {
        errors[name] = `Must be at least ${String(definition.min)}`;
      } else if (definition.max !== undefined && parsed > definition.max) {
        errors[name] = `Must be at most ${String(definition.max)}`;
      }
    }
    if (
      definition.type === 'choice' &&
      definition.options &&
      !definition.options.includes(value)
    ) {
      errors[name] = `Must be one of: ${definition.options.join(', ')}`;
    }
  }
  return errors;
}

export function buildInputPayload(
  definitions: Record<string, PortalPipelineInputDefinition>,
  values: Record<string, string>,
): Record<string, string> | undefined {
  const payload = Object.fromEntries(
    Object.keys(definitions).flatMap((name) => {
      const value = values[name]?.trim() ?? '';
      return value ? [[name, value]] : [];
    }),
  );
  return Object.keys(payload).length > 0 ? payload : undefined;
}
