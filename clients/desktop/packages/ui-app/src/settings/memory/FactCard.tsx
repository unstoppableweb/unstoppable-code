import { ControlButton } from '@canopy/ui-shared/components';
import { MemoryEvidenceQuote } from '@canopy/ui-shared/components';
import { memo, type JSX } from 'react';
import type {
  ExplorerFact,
  ExplorerRankedFact,
} from '@canopy/protocol/settings/organization-memory';
import { withPrivacyClass } from '../account/privacy-class';
import { useSettingsPrivacy } from '../host';
import { Stack, Surface } from '@canopy/ui-shared/components';
import { Badge } from '@canopy/ui-shared/primitives/Badge';

interface FactCardProps {
  fact: ExplorerFact | ExplorerRankedFact;
  onSelect?: (factId: string) => void;
}

function isRanked(
  fact: ExplorerFact | ExplorerRankedFact,
): fact is ExplorerRankedFact {
  return 'score' in fact;
}

// Memoized: list views append pages by replacing the array while keeping the
// same fact object references, so unchanged cards skip re-rendering as long as
// callers pass a stable onSelect (see the useCallback in fact-corpus-view).
function FactCardComponent({ fact, onSelect }: FactCardProps): JSX.Element {
  const { blockClassName } = useSettingsPrivacy();
  const content = (
    <Stack gap="item">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge tone={fact.liveness === 'live' ? 'success' : 'warning'}>
          {fact.liveness === 'live' ? 'LIVE' : 'SUPERSEDED'}
        </Badge>
        <Badge>{fact.evidenceType}</Badge>
        {isRanked(fact) && (
          <span className="ml-auto tabular-nums fg-secondary">
            score {fact.score.toFixed(3)}
          </span>
        )}
      </div>
      <Stack gap="inline">
        <p
          className={withPrivacyClass(
            'line-clamp-4 text-s leading-6 fg-primary',
            blockClassName,
          )}
        >
          {fact.factText}
        </p>
        {fact.evidenceQuote !== null && (
          <MemoryEvidenceQuote compact blockReplay={blockClassName !== ''}>
            “{fact.evidenceQuote}”
          </MemoryEvidenceQuote>
        )}
      </Stack>
      {fact.entities.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {fact.entities.map((entity) => (
            <span
              key={entity.id}
              className={blockClassName === '' ? undefined : blockClassName}
            >
              <Badge>{entity.canonicalName}</Badge>
            </span>
          ))}
        </div>
      )}
      <time dateTime={fact.createdAt} className="block text-xs fg-tertiary">
        {new Date(fact.createdAt).toLocaleString()}
      </time>
    </Stack>
  );

  return (
    <Surface
      as="article"
      variant="card"
      interactive={onSelect !== undefined}
      padding="default"
      data-testid={`memory-fact-${fact.id}`}
    >
      {onSelect === undefined ? (
        <div className="w-full text-left">{content}</div>
      ) : (
        // Keep the original line-box inset below the button. Its content
        // stack has a different baseline from the original block children.
        <div className="pb-0.5">
          <ControlButton
            data-settings-control="row"
            presentation="memory-fact-open"
            onClick={() => onSelect(fact.id)}
          >
            {content}
          </ControlButton>
        </div>
      )}
    </Surface>
  );
}

export const FactCard = memo(FactCardComponent);
