import { Stack } from '../primitives/Stack';
import type { JSX } from 'react';
import type { CanopyOrgEnforcedSettings } from '@canopy/protocol';
import { describeEnforcedPolicies } from '../lib/org-enforced-consent';

interface OrgEnforcedConsentListProps {
  /** Generic enforced policies for the inviting / signed-in org(s). */
  settings: CanopyOrgEnforcedSettings[] | null | undefined;
  /**
   * Optional intro line shown above the list. Surfaces vary their copy (invite
   * lander vs. dashboard card), so the caller owns the sentence.
   */
  heading?: string;
  className?: string;
}

/**
 * Pure OAuth-scope-style consent block. Renders one titled item per enforced
 * policy kind with a sub-bullet per detail. Returns `null` when nothing is
 * enforced so callers can render it unconditionally. Display-only — it derives
 * its items from {@link describeEnforcedPolicies} and never fetches.
 */
export function OrgEnforcedConsentList({
  settings,
  heading,
  className,
}: OrgEnforcedConsentListProps): JSX.Element | null {
  const items = describeEnforcedPolicies(settings);
  if (items.length === 0) {
    return null;
  }

  return (
    <div
      className={`rounded-lg border bg-secondary/40 p-4 text-left ${
        className ?? ''
      }`}
      data-testid="org-enforced-consent-list"
    >
      <Stack gap="item">
        {heading ? (
          <p className="text-s font-medium fg-primary">{heading}</p>
        ) : null}
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            // Key and test id both carry the disposition: one policy kind can now
            // yield two items (what it requires and what it blocks), so keying on
            // `policyKind` alone would collide.
            <Stack
              as="li"
              gap="tight"
              key={`${item.policyKind}-${item.disposition}`}
              data-testid={`consent-item-${item.policyKind}-${item.disposition}`}
              data-disposition={item.disposition}
            >
              <p className="text-s font-medium fg-primary">{item.title}</p>
              {item.disposition === 'blocked' ? (
                // The blast radius is genuinely surprising and has to be stated:
                // a prohibition is global, so it also silences these scopes for
                // the member's own private account and any other organization.
                <p className="text-xs fg-secondary">
                  This data stays on your machine everywhere, including your
                  personal account and any other organization.
                </p>
              ) : null}
              {item.details.length > 0 ? (
                <ul className="list-disc flex flex-col gap-0.5 pl-5 text-xs fg-secondary">
                  {item.details.map((detail) => (
                    <li key={detail}>{detail}</li>
                  ))}
                </ul>
              ) : null}
            </Stack>
          ))}
        </ul>
      </Stack>
    </div>
  );
}
