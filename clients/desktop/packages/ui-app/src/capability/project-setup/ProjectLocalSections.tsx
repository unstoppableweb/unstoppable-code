'use client';

import { useCallback, useEffect, useState, type JSX } from 'react';
import {
  Badge,
  Button,
  DelayedLoadingPlaceholder,
  EmptyStateRow,
  ErrorBanner,
  Notice,
  Skeleton,
} from '@canopy/ui-shared/components';
import {
  SETTINGS_CARD_ROW_CLASS,
  SettingsCard,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import type { SettingsReplayPrivacy } from '@canopy/app-core/settings';
import {
  PROJECT_LOCAL_SECTION_KINDS,
  type ProjectLocalRepository,
  type ProjectLocalRow,
  type ProjectLocalSectionKind,
  type ProjectLocalSetup,
  type ProjectLocalSetupPort,
} from './project-local-setup';

const SECTION_COPY: Record<
  ProjectLocalSectionKind,
  { readonly title: string; readonly empty: string }
> = {
  script: { title: 'Scripts', empty: 'No scripts in this project yet' },
  hook: { title: 'Hooks', empty: 'No hooks in this project yet' },
};

/**
 * The quiet provenance line under each row's name. Each says where the
 * script or hook is changed: the repository's config file (named as this
 * computer reads it, which depends on the brand), or this computer.
 */
function sourceLabel(row: ProjectLocalRow): string {
  const file = row.configFile;
  switch (row.source) {
    case 'repository':
      return file === null
        ? 'From the repository'
        : `From the repository’s ${file}`;
    case 'conductor':
      return 'From the repository’s conductor.json';
    case 'project':
      return file === null
        ? 'From this project'
        : `From this project’s ${file}`;
    case 'this-computer':
      return 'Overridden on this computer';
  }
}

type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'ready'; readonly setup: ProjectLocalSetup };

/**
 * A project's scripts and hooks on the Shared setup panel (CAN-6239), read
 * only: what this computer runs for the project and where each comes from,
 * with "Edit in repo" for each repository's config file. They live in the
 * project's checkout, so without a host that has one (`port` absent) the
 * sections say to open the desktop app.
 */
export function ProjectLocalSections({
  port,
  privacy,
}: {
  port: ProjectLocalSetupPort | undefined;
  /**
   * Session-replay privacy: commands are blocked and repository and project
   * names (user-authored) are masked; inert where replay is off.
   */
  privacy?: SettingsReplayPrivacy;
}): JSX.Element {
  const blockClassName = privacy?.blockClassName ?? '';
  const maskClassName = privacy?.maskClassName ?? '';
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  /** The config file that failed to open, to name it. */
  const [openFailed, setOpenFailed] = useState<string | null>(null);

  useEffect(() => {
    if (port === undefined) return undefined;
    let active = true;
    setLoad({ kind: 'loading' });
    port.read().then(
      (setup) => {
        if (active)
          setLoad(
            setup === null ? { kind: 'absent' } : { kind: 'ready', setup },
          );
      },
      () => {
        if (active) setLoad({ kind: 'failed' });
      },
    );
    return (): void => {
      active = false;
    };
  }, [port, attempt]);

  const edit = useCallback(
    (repository: ProjectLocalRepository): void => {
      if (port === undefined) return;
      setOpenFailed(null);
      port
        .editInRepository(repository)
        .catch(() => setOpenFailed(repository.configFile));
    },
    [port],
  );

  if (port === undefined)
    return (
      <Notice data-testid="project-setup-local-desktop-only">
        Open the desktop app to see this project’s scripts and hooks.
      </Notice>
    );
  if (load.kind === 'loading')
    return (
      <DelayedLoadingPlaceholder>
        <Skeleton
          loading
          label="Loading this project’s scripts and hooks"
          testId="project-setup-local-loading"
          className="w-full"
        >
          <LocalSection
            kind="script"
            setup={SAMPLE}
            blockClassName=""
            maskClassName=""
            onEdit={noop}
          />
        </Skeleton>
      </DelayedLoadingPlaceholder>
    );
  if (load.kind === 'failed')
    return (
      <ErrorBanner
        errorSource="project-setup-local-load"
        testId="project-setup-local-load-error"
        className=""
        error="Couldn’t load this project’s scripts and hooks."
        onRetry={() => setAttempt((current) => current + 1)}
      />
    );
  if (load.kind === 'absent')
    return (
      <Notice data-testid="project-setup-local-not-here">
        Set up this project on this computer to see its scripts and hooks.
      </Notice>
    );
  return (
    <>
      <ErrorBanner
        errorSource="project-setup-local-edit"
        testId="project-setup-local-edit-error"
        className=""
        error={openFailed === null ? null : `Couldn’t open ${openFailed}.`}
      />
      {PROJECT_LOCAL_SECTION_KINDS.map((kind) => (
        <LocalSection
          key={kind}
          kind={kind}
          setup={load.setup}
          blockClassName={blockClassName}
          maskClassName={maskClassName}
          onEdit={edit}
        />
      ))}
    </>
  );
}

const noop = (): void => undefined;

function LocalSection({
  kind,
  setup,
  blockClassName,
  maskClassName,
  onEdit,
}: {
  kind: ProjectLocalSectionKind;
  setup: ProjectLocalSetup;
  blockClassName: string;
  maskClassName: string;
  onEdit: (repository: ProjectLocalRepository) => void;
}): JSX.Element {
  const copy = SECTION_COPY[kind];
  const rows = kind === 'script' ? setup.scripts : setup.hooks;
  const multiple = setup.repositories.length > 1;
  const repositoryName = (key: string | null): string | null =>
    key === null
      ? null
      : (setup.repositories.find((repository) => repository.key === key)
          ?.name ?? null);
  return (
    <SettingsCard title={copy.title} testId={`project-setup-section-${kind}s`}>
      {rows.length === 0 ? (
        <EmptyStateRow
          title={copy.empty}
          testId={`project-setup-section-${kind}s-empty`}
        />
      ) : (
        rows.map((row) => (
          <LocalRow
            key={row.key}
            row={row}
            repositoryName={multiple ? repositoryName(row.repositoryKey) : null}
            blockClassName={blockClassName}
            maskClassName={maskClassName}
          />
        ))
      )}
      {setup.repositories.map((repository) =>
        repository.edit === null ? null : (
          <div
            key={repository.key}
            className={SETTINGS_CARD_ROW_CLASS}
            data-testid={`project-setup-edit-row-${kind}-${repository.key}`}
          >
            <p className="min-w-0 text-xs text-pretty fg-secondary">
              {multiple ? (
                <>
                  Change{' '}
                  <span className={maskClassName || undefined}>
                    {repository.name}
                  </span>
                  ’s {kind === 'script' ? 'scripts' : 'hooks'} in its{' '}
                  {repository.configFile}.
                </>
              ) : (
                `Change these ${kind === 'script' ? 'scripts' : 'hooks'} in the repository’s ${repository.configFile}.`
              )}
            </p>
            <Button
              variant="secondary"
              size="compact"
              // The row's text names the repository; the button's own
              // label stays free of the user-authored name for replay.
              data-testid={`project-setup-edit-in-repo-${kind}-${repository.key}`}
              onClick={() => onEdit(repository)}
            >
              Edit in repo
            </Button>
          </div>
        ),
      )}
    </SettingsCard>
  );
}

function LocalRow({
  row,
  repositoryName,
  blockClassName,
  maskClassName,
}: {
  row: ProjectLocalRow;
  repositoryName: string | null;
  blockClassName: string;
  maskClassName: string;
}): JSX.Element {
  return (
    <div
      className={SETTINGS_CARD_ROW_CLASS}
      data-testid={`project-setup-row-${row.testKey}`}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-s font-medium fg-primary">{row.name}</p>
          {!row.on && (
            <Badge data-testid={`project-setup-off-${row.testKey}`}>Off</Badge>
          )}
        </div>
        <p
          className="text-xs text-pretty fg-secondary"
          data-testid={`project-setup-source-${row.testKey}`}
        >
          {repositoryName === null ? (
            sourceLabel(row)
          ) : (
            <>
              <span className={maskClassName || undefined}>
                {repositoryName}
              </span>
              {` · ${sourceLabel(row)}`}
            </>
          )}
        </p>
        {row.detail !== null && (
          <p
            className={`truncate font-mono text-xs fg-tertiary ${blockClassName}`.trim()}
          >
            {row.detail}
          </p>
        )}
      </div>
    </div>
  );
}

const SAMPLE: ProjectLocalSetup = {
  repositories: [],
  hooks: [],
  scripts: [
    {
      key: 'sample-1',
      testKey: 'sample-1',
      name: 'Setup',
      repositoryKey: null,
      source: 'repository',
      on: true,
      detail: 'pnpm install',
      configFile: null,
    },
    {
      key: 'sample-2',
      testKey: 'sample-2',
      name: 'Launch',
      repositoryKey: null,
      source: 'this-computer',
      on: true,
      detail: 'pnpm dev',
      configFile: null,
    },
  ],
};
