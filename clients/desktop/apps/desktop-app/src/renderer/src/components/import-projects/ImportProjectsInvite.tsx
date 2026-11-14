import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { useEffect } from 'react';
import { brandText } from '@/lib/brand';
import { useGitHubStore } from '@/stores/githubStore';
import { openImportProjectsModal } from '@/stores/importProjectsModalStore';
import { detectedSources, importSourcesLabel } from './importProjectsCopy';

/** Delay before the invite check so startup paint and hydration finish first. */
const INVITE_CHECK_DELAY_MS = 8_000;

/**
 * One-time in-app invitation for installs that finished onboarding before
 * the bulk project import existed (CAN-2439). The main process
 * decides eligibility (provider store present, never scanned, never invited)
 * and the invite is acknowledged as soon as it is shown, so it appears at
 * most once per install regardless of what the user does with it. The check
 * is deferred off the startup path; a retired invite costs one ledger read.
 */
export function ImportProjectsInvite(): null {
  useEffect(() => {
    let cancelled = false;
    const api = window.api.externalProjects;
    if (!api) return undefined;
    const timer = window.setTimeout(() => {
      void api
        .readInvite()
        .then(async (state) => {
          if (cancelled || !state.show) return;
          await api.acknowledgeInvite();
          // The same cached probe that decided eligibility names the tools.
          const label = importSourcesLabel(
            await api
              .readProviderPresence()
              .then((presence) => detectedSources(presence.providers))
              .catch((error: unknown) => {
                reportClientAppError(error);
                return [];
              }),
          );
          if (cancelled) return;
          useGitHubStore
            .getState()
            .addToast(
              `Bring the projects and chats you already have in ${label} into ${brandText.appName}.`,
              'info',
              () => openImportProjectsModal({ source: 'invite' }),
              { title: 'Import projects', persistent: true },
            );
        })
        .catch(() => {
          // The invite is a nudge, never a blocker.
        });
    }, INVITE_CHECK_DELAY_MS);
    return (): void => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);
  return null;
}
