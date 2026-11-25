import { memo, useMemo, type JSX } from 'react';
import {
  DelayedLoadingPlaceholder,
  HomeSection,
  Skeleton,
  SuggestionRow,
} from '@canopy/ui-shared';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { useCuratedMcpServers } from '@/hooks/useCuratedMcpServers';
import { McpServerLogo } from '@/components/shared/McpServerLogo';
import {
  DEFAULT_GENERIC_PROMPT_ICON,
  GENERIC_PROMPT_ICONS,
} from './genericPromptIcons';
import {
  GENERIC_FALLBACK_PROMPTS,
  type SuggestedPrompt,
} from './mcpPromptIndex';
import {
  trackSuggestedPromptSelection,
  type SuggestedPromptSurface,
} from './suggestedPromptTelemetry';

export interface SuggestedPromptChipsProps {
  prompts: readonly SuggestedPrompt[];
  surface: SuggestedPromptSurface;
  /**
   * Invoked with the clicked prompt after selection telemetry fires. The
   * caller inserts the text into its composer; the component never sends.
   */
  onSelect: (prompt: SuggestedPrompt) => void;
}

/**
 * Curated MCP logo for a prompt row: the shared circular {@link McpServerLogo}
 * at chip size, keeping the generic-icon tile fallback (prompt rows carry no
 * server name to monogram).
 */
interface PromptLogoProps {
  curatedKey: string;
  logoUrl?: string;
}

function PromptLogo({ curatedKey, logoUrl }: PromptLogoProps): JSX.Element {
  return (
    <McpServerLogo
      curatedKey={curatedKey}
      logoUrl={logoUrl}
      size={20}
      imgTestId="suggested-prompt-logo"
      fallbackTestId="suggested-prompt-logo-fallback"
    />
  );
}

/**
 * Suggested prompts for empty-state surfaces (CAN-1809), rendered as a
 * left-aligned list of icon + text rows. MCP-specific prompts show the
 * curated catalog logo; generic fallbacks show a Central Icon. Renders nothing
 * while `prompts` is empty.
 */
export const SuggestedPromptChips = memo(function SuggestedPromptChips({
  prompts,
  surface,
  onSelect,
}: SuggestedPromptChipsProps): JSX.Element | null {
  const { entries } = useCuratedMcpServers();
  const logoByKey = useMemo(() => {
    const map = new Map<string, string | undefined>();
    for (const entry of entries) map.set(entry.key, entry.logoUrl);
    return map;
  }, [entries]);

  if (prompts.length === 0) return null;
  const rows = (
    <div data-testid="suggested-prompt-chips" className="flex w-full flex-col">
      {prompts.map((prompt, index) => (
        <SuggestionRow
          key={prompt.id}
          data-testid="suggested-prompt-chip"
          data-suggestion-id={prompt.id}
          onClick={(): void => {
            trackSuggestedPromptSelection(surface, prompt, index);
            onSelect(prompt);
          }}
          icon={
            prompt.curatedKey !== null ? (
              <PromptLogo
                curatedKey={prompt.curatedKey}
                logoUrl={logoByKey.get(prompt.curatedKey)}
              />
            ) : (
              <span className="flex shrink-0 items-center justify-center fg-tertiary">
                {GENERIC_PROMPT_ICONS[prompt.id] ?? DEFAULT_GENERIC_PROMPT_ICON}
              </span>
            )
          }
        >
          {/* Catalog prompts are app copy; a project starter prompt is
              written by its users, so its text is blocked. */}
          <span
            className={
              prompt.userAuthored ? POSTHOG_REPLAY_BLOCK_CLASS : undefined
            }
          >
            {prompt.text}
          </span>
        </SuggestionRow>
      ))}
    </div>
  );
  return surface === 'home' ? (
    <HomeSection sectionId="suggested-prompts" title="Suggestions">
      {rows}
    </HomeSection>
  ) : (
    rows
  );
});

export interface SuggestedPromptsPlaceholderProps {
  /** Rows the pick will hold at least; nothing is kept for 0. */
  count: number;
  surface: SuggestedPromptSurface;
}

const ignoreSampleSelect = (): void => undefined;

/**
 * Keeps the room of prompts still being picked, from the first frame, so the
 * empty state above them does not move when they arrive. Shows nothing for
 * the usual short wait, then a measured skeleton of the rows (the loading
 * sequence in `docs/design/feedback.md`). The sample rows are the surface's
 * own generic prompts, so the lines are the real lengths.
 */
export function SuggestedPromptsPlaceholder({
  count,
  surface,
}: SuggestedPromptsPlaceholderProps): JSX.Element | null {
  if (count <= 0) return null;
  const pool = GENERIC_FALLBACK_PROMPTS[surface];
  const samples = Array.from(
    { length: count },
    (_, index) => pool[index % pool.length],
  ).filter((prompt): prompt is SuggestedPrompt => prompt !== undefined);
  return (
    <DelayedLoadingPlaceholder>
      <Skeleton loading testId="suggested-prompts-loading">
        <SuggestedPromptChips
          prompts={samples}
          surface={surface}
          onSelect={ignoreSampleSelect}
        />
      </Skeleton>
    </DelayedLoadingPlaceholder>
  );
}
