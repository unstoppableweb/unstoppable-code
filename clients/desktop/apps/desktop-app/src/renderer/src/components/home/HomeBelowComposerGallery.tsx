import { Surface } from '@canopy/ui-shared/components';
import { useCallback, type JSX } from 'react';
import {
  Button,
  HomeSection,
  SuggestionRow,
  SuggestionRowTrailing,
} from '@canopy/ui-shared';
import {
  CloseMediumIcon,
  DocumentIcon,
  GitBranchCompactIcon,
  HistoryIcon,
  TerminalIcon,
  WarningIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { SuggestedPromptChips } from '@/components/suggestions/SuggestedPromptChips';
import type { SuggestedPrompt } from '@/components/suggestions/mcpPromptIndex';
import { HOME_BELOW_COMPOSER_GALLERY_STORAGE_KEY } from './home-below-composer-gallery-flag';

const GALLERY_PROMPTS: readonly SuggestedPrompt[] = [
  {
    id: 'generic-home-1',
    curatedKey: null,
    text: 'Summarize the latest changes and suggest a next task',
  },
  {
    id: 'generic-home-2',
    curatedKey: null,
    text: 'Draft a plan to add tests around the riskiest paths',
  },
];

/**
 * Dev-only fixture stack for every below-composer Home section. Spacing comes
 * from `home-composer-group`'s gap — sections here must not add outer margin.
 */
export function HomeBelowComposerGallery(): JSX.Element {
  const hideGallery = useCallback((): void => {
    try {
      window.localStorage.setItem(HOME_BELOW_COMPOSER_GALLERY_STORAGE_KEY, '0');
    } catch {
      // Ignore private-mode storage failures; reload still exits preview.
    }
    window.location.reload();
  }, []);

  return (
    <>
      <Surface
        variant="gallery-banner"
        direction="row"
        gap="item"
        padding="section-default"
        data-testid="home-below-composer-gallery-banner"
        className="w-full items-center justify-between"
      >
        <span className="text-xs fg-secondary">
          Preview: all below-composer sections (dev only). Spacing uses the live
          Home stack gap.
        </span>
        <Button
          variant="ghost"
          size="compact"
          data-testid="home-below-composer-gallery-hide"
          onClick={hideGallery}
        >
          Hide preview
        </Button>
      </Surface>

      <HomeSection
        sectionId="gallery-continue"
        title="Continue"
        testId="home-resume-card"
      >
        <ul className="flex flex-col">
          <li className="group relative flex items-center">
            <SuggestionRow
              icon={<WarningIcon size={16} aria-hidden="true" />}
              trailingControl
            >
              Resume 2 interrupted chats
            </SuggestionRow>
            <SuggestionRowTrailing>
              <Button
                variant="ghost"
                size="compact"
                iconOnly
                aria-label="Dismiss"
              >
                <CloseMediumIcon size="sm" />
              </Button>
            </SuggestionRowTrailing>
          </li>
          <li data-testid="home-resume-details">
            <SuggestionRow icon={<HistoryIcon size={16} aria-hidden="true" />}>
              feature/home-section-spacing
              <span className="pl-2 fg-quaternary">Demo Workspace</span>
            </SuggestionRow>
          </li>
        </ul>
      </HomeSection>

      <SuggestedPromptChips
        prompts={GALLERY_PROMPTS}
        surface="home"
        onSelect={(): void => {
          // Fixture-only preview — no composer insertion.
        }}
      />

      <HomeSection
        sectionId="gallery-project-suggestions"
        title={
          <>
            Suggestions for <span className="fg-tertiary">Demo Workspace</span>
          </>
        }
        testId="home-workspace-readiness"
      >
        <ul className="flex flex-col">
          <li data-testid="home-workspace-readiness-row">
            <SuggestionRow icon={<TerminalIcon size={16} aria-hidden="true" />}>
              Configure setup scripts
            </SuggestionRow>
          </li>
          <li data-testid="home-workspace-readiness-row">
            <SuggestionRow
              icon={<GitBranchCompactIcon size={16} aria-hidden="true" />}
            >
              Configure git hooks
            </SuggestionRow>
          </li>
          <li data-testid="home-workspace-readiness-row">
            <SuggestionRow icon={<DocumentIcon size={16} aria-hidden="true" />}>
              Add agent instructions
            </SuggestionRow>
          </li>
        </ul>
      </HomeSection>
    </>
  );
}
