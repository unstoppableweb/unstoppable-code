import { TextLink } from './TextLink';
import type { JSX } from 'react';
import type { SkillPublisherProvenance as Provenance } from '@canopy/protocol';

/** Publisher terms and the exact reviewed upstream source, shared by both hosts. */
export function SkillPublisherProvenance({
  publisher,
}: {
  publisher: Provenance;
}): JSX.Element {
  return (
    <div
      className="flex flex-col gap-3 text-s fg-secondary"
      data-testid="publisher-skill-provenance"
    >
      <p>License: {publisher.license ?? 'See source for license terms'}</p>
      <TextLink
        href={publisher.sourceUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="relative pointer-coarse:before:absolute pointer-coarse:before:-inset-y-3.5 pointer-coarse:before:inset-x-0 pointer-coarse:before:content-[''] self-start"
      >
        View source
      </TextLink>
    </div>
  );
}
