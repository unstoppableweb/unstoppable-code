import { lazy, Suspense, useEffect, useState, type JSX } from 'react';
import { usesNativeWindowFrame } from '@canopy/desktop-shared/platform-capabilities';
import { localPlatform } from '@/lib/local-platform';
import { isDefaultCoworkWorkspaceId } from '@canopy/desktop-shared/types';
import { useProjectsStore } from '@/stores/projectsStore';

const HomeSurface = lazy(async () => {
  const mod = await import('../home/HomeSurface');
  return { default: mod.HomeSurface };
});

const FirstRunImportPage = lazy(async () => {
  const mod = await import('../onboarding/FirstRunImportPage');
  return { default: mod.FirstRunImportPage };
});

/** New installs only: no onboarding marker and no projects of their own. */
function useShowFirstRun(): [boolean, () => void] {
  const hasOwnProjects = useProjectsStore(
    (s) =>
      !s.hasHydratedProjects ||
      s.projects.some((item) => !isDefaultCoworkWorkspaceId(item.id)),
  );
  // `shown` latches the page once it appears: its own import adds projects,
  // and only `onDone` may take it away.
  const [eligible, setEligible] = useState<boolean | 'shown' | null>(null);
  useEffect(() => {
    let cancelled = false;
    window.api
      .loadPreferences()
      .then((prefs) => {
        if (!cancelled)
          setEligible(
            !Array.isArray(prefs.onboardingCompleted) ||
              prefs.onboardingCompleted.length === 0,
          );
      })
      .catch((): void => {
        // Unreadable preferences: fall back to Home.
        if (!cancelled) setEligible(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, []);
  const show = eligible === 'shown' || (eligible === true && !hasOwnProjects);
  useEffect(() => {
    if (show && eligible === true) setEligible('shown');
  }, [show, eligible]);
  const dismiss = (): void => setEligible(false);
  return [show, dismiss];
}

export function HomePage(): JSX.Element {
  const [showFirstRun, dismissFirstRun] = useShowFirstRun();
  return (
    <div data-testid="page-home" className="relative h-full w-full">
      {!usesNativeWindowFrame(localPlatform()) && (
        <div
          aria-hidden="true"
          className="electron-drag absolute inset-x-0 top-0 h-10"
          data-testid="home-titlebar-drag-region"
        />
      )}
      <Suspense fallback={null}>
        {showFirstRun ? (
          <FirstRunImportPage onDone={dismissFirstRun} />
        ) : (
          <HomeSurface variant="page" />
        )}
      </Suspense>
    </div>
  );
}
