// The wire kind is still "agent" for saved model definitions.
export const MODEL_PRESET_LABEL = 'Model preset';
export const MODEL_PRESET_LABEL_PLURAL = 'Model presets';

// Keep searches for the former Customize category name working.
export function modelPresetSearchAlias(kind: string): string | undefined {
  return kind === 'agent' ? 'agent' : undefined;
}
