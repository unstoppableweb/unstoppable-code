'use client';

import type { JSX } from 'react';
import {
  Heading,
  Skeleton,
  Stack,
  TextLink,
} from '@canopy/ui-shared/primitives';

/**
 * One full-page state of the shared artifact viewer: sign in, no access,
 * taken down, unshared or unavailable. Never names the owner.
 */
export function SharedArtifactStatePanel({
  title,
  body,
  action,
  testId,
}: {
  readonly title: string;
  readonly body: string;
  readonly action?: { readonly label: string; readonly href: string };
  readonly testId: string;
}): JSX.Element {
  return (
    <div
      className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-6 py-16"
      data-testid={testId}
      role="status"
    >
      <Stack gap="item">
        <Heading level={1} variant="section">
          {title}
        </Heading>
        <p className="text-s fg-secondary">{body}</p>
        {action !== undefined && (
          <TextLink href={action.href} data-testid={`${testId}-action`}>
            {action.label}
          </TextLink>
        )}
      </Stack>
    </div>
  );
}

/** The skeleton of the chrome while the first read is in flight. */
export function SharedArtifactLoadingPanel({
  label,
}: {
  readonly label: string;
}): JSX.Element {
  return (
    <div className="w-full px-6 py-6">
      <Skeleton loading label={label} testId="shared-artifact-loading">
        <Stack gap="item">
          <Heading level={1} variant="section">
            Shared artifact title
          </Heading>
          <p className="text-s fg-secondary">Last updated on a recent date</p>
          <div className="h-80 w-full" />
        </Stack>
      </Skeleton>
    </div>
  );
}
