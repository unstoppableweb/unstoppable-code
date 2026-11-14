'use client';
import { useEffect, useRef, useState, type JSX } from 'react';
import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import { REMOTE_CONTROL_LABEL } from '@canopy/protocol';
import {
  isPersonalCatalogProject,
  type PersonalCatalogProject,
} from '@canopy/protocol/settings/personal-catalog';
import {
  Button,
  ErrorBanner,
  Notice,
  Heading,
} from '@canopy/ui-shared/components';
import { SettingsCard } from '@canopy/ui-shared/components/settings/SettingsCard';
import {
  SettingsConfirmDialog,
  useSettingsBrand,
  useSettingsClient,
  useSettingsWorkspaceContext,
} from '../host';
import {
  settingsActionErrorCopy,
  settingsFailure,
  type SettingsFailure,
} from '../errors';

/** One state, so a removed list can never also be loading or listed. */
type CatalogState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'hidden' }
  | {
      readonly kind: 'ready';
      readonly projects: readonly PersonalCatalogProject[];
    }
  | { readonly kind: 'removed' };

async function readProjects(
  client: AccountOrganizationSettingsClient,
): Promise<readonly PersonalCatalogProject[] | null> {
  try {
    const body: unknown = await client.read(
      'account.profile.projects.read',
      {},
    );
    if (
      typeof body !== 'object' ||
      body === null ||
      !('projects' in body) ||
      !Array.isArray(body.projects) ||
      !body.projects.every(isPersonalCatalogProject)
    )
      return null;
    return body.projects;
  } catch {
    return null;
  }
}

function countLabel(count: number): string {
  return count === 1 ? '1 project' : `${count} projects`;
}

/**
 * Public profile card for the Personal project list a desktop shares with the
 * web. It shows only while that list is non-empty, and removal asks first:
 * the desktop Privacy toggle stays the primary control, and this card is the
 * way to clear what was already synced.
 */
export function PersonalCatalogCard(): JSX.Element | null {
  const { enabled } = useSettingsWorkspaceContext();
  const brand = useSettingsBrand();
  const client = useSettingsClient();
  const [state, setState] = useState<CatalogState>({ kind: 'loading' });
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<SettingsFailure | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    // The settings client takes no abort signal; a superseded read is
    // ignored instead, exactly as an aborted fetch was.
    let cancelled = false;
    void readProjects(client).then((projects) => {
      if (cancelled) return;
      setState(
        projects && projects.length > 0
          ? { kind: 'ready', projects }
          : { kind: 'hidden' },
      );
    });
    return (): void => {
      cancelled = true;
    };
  }, [client, enabled]);

  if (!enabled || state.kind === 'loading' || state.kind === 'hidden')
    return null;

  const open = (): void => {
    setError(null);
    setConfirming(true);
  };
  const cancel = (): void => {
    setError(null);
    setConfirming(false);
  };
  const remove = async (): Promise<void> => {
    setPending(true);
    setError(null);
    let failure: SettingsFailure | null = null;
    try {
      await client.write('account.profile.projects.remove', {});
    } catch (caught: unknown) {
      failure = settingsFailure(
        caught,
        settingsActionErrorCopy(caught, { action: 'remove your projects' }),
      );
    }
    if (!mountedRef.current) return;
    setPending(false);
    if (failure === null) {
      setState({ kind: 'removed' });
      setConfirming(false);
    } else {
      setError(failure);
    }
  };

  return (
    <SettingsCard
      title={
        <Heading level={2} variant="section" ref={headingRef} tabIndex={-1}>
          Projects shown on the web
        </Heading>
      }
      subtitle={`Your desktop shares these project names with ${brand.displayName} so you can open them from ${REMOTE_CONTROL_LABEL}.`}
      testId="personal-catalog-card"
    >
      {state.kind === 'removed' ? (
        <Notice data-testid="personal-catalog-removed">
          Your projects were removed from the web. Turn sharing off and back on
          in the {brand.displayName} desktop app to show them again.
        </Notice>
      ) : (
        <div className="flex flex-col items-start gap-3">
          <p
            className="text-s fg-secondary"
            data-testid="personal-catalog-count"
          >
            {countLabel(state.projects.length)}
          </p>
          <Button
            variant="secondary"
            size="compact"
            onClick={open}
            data-testid="personal-catalog-remove"
          >
            Remove from web
          </Button>
        </div>
      )}
      {confirming ? (
        <SettingsConfirmDialog
          title="Remove projects from the web?"
          message={
            <div className="flex flex-col gap-3">
              <p>
                Your project names and repository details will be removed from{' '}
                {brand.displayName}. Nothing on your computer changes. To show
                them again, turn sharing off and back on in the{' '}
                {brand.displayName} desktop app.
              </p>
              <ErrorBanner
                errorSource="personal-catalog-remove-error"
                className=""
                error={error?.copy}
                {...(error?.details === undefined
                  ? {}
                  : { details: error.details })}
                testId="personal-catalog-remove-error"
              />
            </div>
          }
          confirmLabel="Remove"
          busyLabel="Removing…"
          busy={pending}
          destructive
          onConfirm={() => void remove()}
          onCancel={cancel}
          dataTestId="personal-catalog-remove-confirm"
          restoreFocusRef={headingRef}
        />
      ) : null}
    </SettingsCard>
  );
}
