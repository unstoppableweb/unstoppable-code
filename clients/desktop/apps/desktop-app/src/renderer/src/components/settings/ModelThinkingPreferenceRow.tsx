import type { JSX, ReactNode } from 'react';
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  OLLAMA_MODELS,
  getModelDisplayName,
  getProviderForModel,
  getThinkingUiValueForProvider,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import {
  ThinkingLevelControl,
  ThinkingLevelProviderHint,
} from '@canopy/ui-shared';
import {
  SettingsSelect,
  type SettingsSelectItem,
} from '@canopy/ui-shared/components';
import { useCursorChatAvailable } from '@/hooks/useCursorChatAvailable';
import { useCursorModels } from '@/hooks/useCursorModels';
import {
  getModelPreferenceThinkingLevels,
  isNativeModelPreferenceOption,
  thinkingLevelForChosenModel,
} from '@canopy/desktop-shared/lib/model-thinking-preference';
import { SettingsRow } from './SettingsLayout';

interface ModelThinkingPreferenceRowProps {
  /** Heading rendered on the left side of the row. */
  title: string;
  /** Supporting copy under the heading. */
  description: ReactNode;
  /** Currently selected model id. */
  model: string;
  /** Currently persisted thinking level. May be `undefined` for transitional
   * states; `defaultThinkingLevel` is used as the fallback. */
  thinkingLevel: ThinkingLevel | undefined;
  /** Fallback used when computing the displayed thinking-select value and the
   * value to clamp into when the model provider changes. */
  defaultThinkingLevel: ThinkingLevel;
  /** Saves both model and clamped thinking level in one preference update. */
  onModelChange: (model: string, thinkingLevel: ThinkingLevel) => void;
  /** Saves the selected thinking level. */
  onThinkingChange: (thinkingLevel: ThinkingLevel) => void;
  /** When true the row's selects are disabled. Used for "Worktree Summary"
   * which is gated behind a toggle. */
  disabled?: boolean;
  /** When false the Ollama optgroup is suppressed entirely, matching the
   * Summary model row behavior. Defaults to `true`. */
  includeOllama?: boolean;
  /** When true and the managed Cursor runtime is connected, a Cursor optgroup
   * lists the discovered Cursor models. Only surfaces whose execution path
   * runs Cursor (App Advisor) opt in; helper rows must not. */
  includeCursor?: boolean;
  /** Optional prefix for stable automation hooks on the model/thinking selects. */
  testIdPrefix?: string;
}

/**
 * Repeated "title + description on the left, model select + thinking select on
 * the right" row used across `ChatTab` (Summary, Worktree Summary) and
 * `GitTab` (Branch naming, PR generation, Commit generation).
 *
 * Behaviour preserved verbatim from the inline copies:
 * - Model select renders Claude / Codex / Ollama optgroups, hiding Ollama when
 *   `OLLAMA_MODELS` is empty.
 * - When the model changes, `thinkingLevel` is re-clamped via
 *   `normalizeThinkingForProvider` so providers without certain levels can't
 *   be left in an invalid state.
 * - The shared thinking select shows the levels the selected model supports,
 *   with unsupported persisted values displayed as the nearest supported
 *   tier.
 * - `disabled` propagates to both selects (e.g. when "Worktree Summary" is
 *   disabled).
 */
export function ModelThinkingPreferenceRow({
  title,
  description,
  model,
  thinkingLevel,
  defaultThinkingLevel,
  onModelChange,
  onThinkingChange,
  disabled = false,
  includeOllama = true,
  includeCursor = false,
  testIdPrefix,
}: ModelThinkingPreferenceRowProps): JSX.Element {
  // Neither hook touches the runtime while the caller has not opted in.
  const cursorAvailable = useCursorChatAvailable(includeCursor);
  const { models: cursorModels } = useCursorModels(
    cursorAvailable,
    includeCursor,
  );
  // Preferences can retain a removed model id. Keep the settings page
  // renderable and use Claude only as this row's explicit display fallback.
  const provider = getProviderForModel(model) ?? 'claude';
  const modelAvailable =
    isNativeModelPreferenceOption(model, includeOllama) ||
    (cursorAvailable && cursorModels.some((entry) => entry.id === model));
  const savedThinkingLevel = thinkingLevel ?? defaultThinkingLevel;
  const supportedThinkingLevels = modelAvailable
    ? getModelPreferenceThinkingLevels(model)
    : [savedThinkingLevel];
  // Cursor has no host-side thinking level (the pinned CLI fixes reasoning
  // per model), so the control is hidden rather than silently ignored. That
  // holds for a saved Cursor model whose runtime is gone too: the id still
  // names Cursor, so the unavailable fallback must not resurrect the select.
  const thinkingSupported =
    provider !== 'cursor' && supportedThinkingLevels.length > 0;

  const modelOptions: SettingsSelectItem[] = [];
  if (!modelAvailable) {
    modelOptions.push({
      value: model,
      label: `${model} (unavailable)`,
      disabled: true,
    });
  }
  // Custom Agent models (`agent_model_*`) are intentionally EXCLUDED here.
  // These per-feature model preferences (chat description, cron generation,
  // branch/PR/commit naming, plan parsing, worktree summaries, rebase
  // resolution, …) run on utility execution paths that pass the selected
  // model straight to a provider SDK and do NOT perform Agent resolution
  // (instruction append + plugin merge). Only the real Claude/Codex/Ollama
  // base models are offered; Agent models surface exclusively in the chat
  // ModelPicker.
  modelOptions.push(
    {
      label: 'Claude',
      options: CLAUDE_MODELS.map((m) => ({
        value: m,
        label: getModelDisplayName(m),
      })),
    },
    {
      label: 'Codex',
      options: CODEX_MODELS.map((m) => ({
        value: m,
        label: getModelDisplayName(m),
      })),
    },
  );
  if (includeOllama && OLLAMA_MODELS.length > 0) {
    modelOptions.push({
      label: 'Ollama',
      options: OLLAMA_MODELS.map((m) => ({
        value: m,
        label: getModelDisplayName(m),
      })),
    });
  }
  if (cursorAvailable && cursorModels.length > 0) {
    modelOptions.push({
      label: 'Cursor',
      options: cursorModels.map((entry) => ({
        value: entry.id,
        label: entry.label,
      })),
    });
  }

  return (
    <SettingsRow
      label={title}
      description={description}
      control={
        <>
          {/* Fixed columns so model and thinking dropdowns line up down a
              page of model rows. */}
          <span className="inline-flex w-36">
            <SettingsSelect
              width="fill"
              data-testid={testIdPrefix ? `${testIdPrefix}-model` : undefined}
              options={modelOptions}
              value={model}
              disabled={disabled}
              onValueChange={(newModel): void => {
                // Every option is populated from a current provider registry.
                onModelChange(
                  newModel,
                  thinkingLevelForChosenModel(
                    newModel,
                    thinkingLevel ?? defaultThinkingLevel,
                  ),
                );
              }}
            />
          </span>
          {thinkingSupported && (
            <div className="w-36">
              <ThinkingLevelProviderHint providerHint={provider}>
                <ThinkingLevelControl
                  value={
                    modelAvailable
                      ? getThinkingUiValueForProvider(
                          thinkingLevel,
                          defaultThinkingLevel,
                          provider,
                          model,
                        )
                      : savedThinkingLevel
                  }
                  supportedLevels={supportedThinkingLevels}
                  includeLow={!modelAvailable}
                  onChange={(next): void => {
                    if (next !== undefined) {
                      onThinkingChange(next);
                    }
                  }}
                  variant="select"
                  selectFill
                  disabled={disabled || !modelAvailable}
                  testId={testIdPrefix ? `${testIdPrefix}-thinking` : undefined}
                />
              </ThinkingLevelProviderHint>
            </div>
          )}
        </>
      }
    />
  );
}
