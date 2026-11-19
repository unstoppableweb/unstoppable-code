import { useEffect, useRef, useState, type JSX } from 'react';
import { Badge, Button, ErrorBanner } from '@canopy/ui-shared/components';
import {
  SETTINGS_CARD_ROW_CLASS,
  SettingsCard,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import type { RecommendedPluginItem } from '@canopy/desktop-shared/types';
import { CAPABILITY_SETUP_REVISION_CONFLICT_CODE } from '@canopy/protocol/settings/operations-organization';
import {
  recommendationInstallsForEveryone,
  recommendationIsOpen,
  recommendationSetupRef,
  withItemAdded,
  withRecommendationDismissed,
} from '@canopy/ui-app/capability/project-setup/project-setup-model';
import {
  settingsActionErrorCopy,
  settingsErrorFacts,
  type KnownSettingsError,
} from '@canopy/ui-app/settings/errors';
import { registeredHostedSettingsClient } from '@/client/hosted-settings-client-registry';

type Decision = 'add' | 'dismiss';

const KNOWN: readonly KnownSettingsError[] = [
  {
    status: 409,
    serverCode: CAPABILITY_SETUP_REVISION_CONFLICT_CODE,
    copy: "Couldn't update this project. Someone else changed its setup at the same time. Try again.",
  },
];

/**
 * An organization project's repository recommendations (CAN-6241), for
 * someone who may administer the project: each is added for everyone in the
 * project's shared setup, or dismissed there, so nobody is asked again. Each
 * decision reads the setup first and writes at its revision with a fresh key,
 * so a recommendation someone else already decided on just leaves the list;
 * a write that conflicts is not retried, and the next press reads again.
 */
export function OrganizationRecommendationList({
  setupProjectId,
  items,
  onDecided,
  onLostAccess,
}: {
  setupProjectId: string;
  items: readonly RecommendedPluginItem[];
  /** Called with the keys no longer open, once each decision settles. */
  onDecided: (keys: readonly string[]) => void;
  /** The person can no longer change the project's setup; says why. */
  onLostAccess: (message: string) => void;
}): JSX.Element {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A decision still running when the list goes (another prompt replaced
  // it) reports nothing.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);

  const decide = async (
    item: RecommendedPluginItem,
    decision: Decision,
  ): Promise<void> => {
    const ref = recommendationSetupRef(item.ref);
    const client = registeredHostedSettingsClient();
    if (ref === null || client === null || pending !== null) return;
    setPending(item.key);
    setError(null);
    type Outcome = 'decided' | 'lost-access';
    const run = async (): Promise<Outcome> => {
      const setup = await client.read('organization.projects.setup', {
        projectId: setupProjectId,
      });
      if (!setup.canEdit) return 'lost-access';
      if (!recommendationIsOpen(setup, ref)) return 'decided';
      await client.write('organization.projects.setup.update', {
        projectId: setupProjectId,
        expectedRevision: setup.revision,
        ...(decision === 'add'
          ? withItemAdded(setup, ref)
          : withRecommendationDismissed(setup, ref)),
        idempotencyKey: crypto.randomUUID(),
      });
      return 'decided';
    };
    // The failure is shown in the list's ErrorBanner, which records it; it
    // is not reported again here.
    await run().then(
      (outcome) => {
        if (!mounted.current) return;
        if (outcome === 'lost-access')
          onLostAccess("You can't change this project's setup anymore.");
        else onDecided([item.key]);
      },
      async (failure: unknown) => {
        if (!mounted.current) return;
        setError(
          settingsActionErrorCopy(failure, {
            action: 'update this project',
            known: KNOWN,
          }),
        );
        // A save that may have landed is never sent again; reading the setup
        // shows whether it did.
        if (!settingsErrorFacts(failure).uncertain) return;
        const setup = await client
          .read('organization.projects.setup', { projectId: setupProjectId })
          .then(
            (read) => read,
            (): null => null,
          );
        if (
          mounted.current &&
          setup !== null &&
          !recommendationIsOpen(setup, ref)
        )
          onDecided([item.key]);
      },
    );
    if (mounted.current) setPending(null);
  };

  return (
    <div className="flex flex-col gap-3">
      <ErrorBanner
        errorSource="organization-recommendations"
        testId="organization-recommendations-error"
        className=""
        error={error}
      />
      <SettingsCard
        title="For everyone in this project"
        subtitle="Add a recommendation to the project's shared setup, or dismiss it. Nobody is asked about it again."
        testId="organization-recommendations"
      >
        {items.map((item) => {
          const ref = recommendationSetupRef(item.ref);
          const addable =
            ref !== null && recommendationInstallsForEveryone(ref);
          const busy = pending === item.key;
          return (
            <div
              key={item.key}
              className={SETTINGS_CARD_ROW_CLASS}
              data-testid={`organization-recommendation-row-${item.key}`}
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex min-w-0 items-center gap-2">
                  <p className="truncate text-s font-medium fg-primary">
                    {item.displayName}
                  </p>
                  <Badge>{item.kind === 'skill' ? 'Skill' : 'Plugin'}</Badge>
                </div>
                <p className="truncate text-xs fg-secondary">
                  {addable
                    ? item.displaySource
                    : "Can't be added for everyone yet. Each person can still install it."}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  size="compact"
                  disabled={pending !== null}
                  data-testid={`organization-recommendation-dismiss-${item.key}`}
                  onClick={() => void decide(item, 'dismiss')}
                >
                  Dismiss
                </Button>
                {addable && (
                  <Button
                    variant="primary"
                    size="compact"
                    disabled={pending !== null}
                    aria-busy={busy}
                    data-testid={`organization-recommendation-add-${item.key}`}
                    onClick={() => void decide(item, 'add')}
                  >
                    Add for everyone
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </SettingsCard>
    </div>
  );
}
