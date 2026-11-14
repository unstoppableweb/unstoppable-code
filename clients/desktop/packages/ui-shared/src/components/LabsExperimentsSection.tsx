import type { ComponentType, JSX, ReactNode } from 'react';
import { EARLY_ACCESS_EXPERIMENT_ID } from '@canopy/protocol/experiments';

import { ErrorBanner } from './StatusBlocks';
import { ToggleSwitch } from './ToggleSwitch';

/** One listed experiment, as its host resolved it for display. */
export interface LabsExperimentRowView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** The switch position: effective state, or a pending save's request. */
  readonly checked: boolean;
  /** True while the state is loading or a save for this row is pending. */
  readonly disabled: boolean;
  /**
   * Which section lists the row. `pages` lists experiments that bring back a
   * page hidden by default. Absent means `early-access`.
   */
  readonly group?: 'early-access' | 'pages';
}

/**
 * The host's settings layout kit. The section is pure presentation, so each
 * host supplies the section, the box, and the row it uses for every other
 * setting.
 */
export interface LabsExperimentsSectionLayout {
  readonly Section: ComponentType<{
    readonly title?: ReactNode;
    readonly description?: ReactNode;
    readonly headingId?: string;
    readonly dataTestId?: string;
    readonly children?: ReactNode;
  }>;
  readonly Group: ComponentType<{ readonly children?: ReactNode }>;
  readonly Row: ComponentType<{
    readonly label: ReactNode;
    readonly description?: ReactNode;
    readonly control?: ReactNode;
    readonly htmlFor?: string;
    readonly dataTestId?: string;
  }>;
}

export interface LabsExperimentsSectionProps {
  /** Listed experiments; Early access first, then registry order. */
  readonly rows: readonly LabsExperimentRowView[];
  /** The save error to show above the rows, if any. */
  readonly error?: string | null;
  /** The save error's raw reason: copied by `Copy details`, never shown. */
  readonly errorDetails?: string;
  readonly onToggle: (experimentId: string, enabled: boolean) => void;
  readonly layout: LabsExperimentsSectionLayout;
}

function toggleIdFor(id: string): string {
  return id === EARLY_ACCESS_EXPERIMENT_ID
    ? 'settings-experimental-features-toggle'
    : `settings-labs-experiment-toggle-${id}`;
}

function toggleTestIdFor(id: string): string {
  return id === EARLY_ACCESS_EXPERIMENT_ID
    ? 'experimental-features-toggle'
    : `labs-experiment-toggle-${id}`;
}

/**
 * Settings → Labs: one switch per listed Labs experiment, in two
 * sections. "Try new features early" holds Early access and the experiments
 * it gates; "Experiments" holds the page experiments. A section renders only when
 * it has rows, and the save error shows above the first one.
 */
export function LabsExperimentsSection({
  rows,
  error,
  errorDetails,
  onToggle,
  layout,
}: LabsExperimentsSectionProps): JSX.Element | null {
  if (rows.length === 0) return null;
  const earlyAccessRows = rows.filter((row) => row.group !== 'pages');
  const pageRows = rows.filter((row) => row.group === 'pages');
  return (
    <>
      {earlyAccessRows.length > 0 && (
        <layout.Section
          title="Try new features early"
          headingId="settings-experimental-features-heading"
          dataTestId="settings-experimental-features"
        >
          <ErrorBanner
            errorSource="labs-experiments-section"
            className=""
            error={error}
            details={errorDetails}
          />
          <LabsExperimentRows
            rows={earlyAccessRows}
            onToggle={onToggle}
            layout={layout}
          />
        </layout.Section>
      )}
      {pageRows.length > 0 && (
        <layout.Section
          title="Experiments"
          description="Turn on the ones you want to try."
          headingId="settings-labs-pages-heading"
          dataTestId="settings-labs-pages"
        >
          {earlyAccessRows.length === 0 && (
            <ErrorBanner
              errorSource="labs-experiments-section"
              className=""
              error={error}
              details={errorDetails}
            />
          )}
          <LabsExperimentRows
            rows={pageRows}
            onToggle={onToggle}
            layout={layout}
          />
        </layout.Section>
      )}
    </>
  );
}

function LabsExperimentRows({
  rows,
  onToggle,
  layout: { Group, Row },
}: Pick<
  LabsExperimentsSectionProps,
  'rows' | 'onToggle' | 'layout'
>): JSX.Element {
  return (
    <Group>
      {rows.map((row) => (
        <Row
          key={row.id}
          label={row.name}
          htmlFor={toggleIdFor(row.id)}
          description={row.description}
          dataTestId={`labs-experiment-row-${row.id}`}
          control={
            <ToggleSwitch
              id={toggleIdFor(row.id)}
              checked={row.checked}
              disabled={row.disabled}
              label={row.name}
              onChange={(next) => onToggle(row.id, next)}
              dataTestId={toggleTestIdFor(row.id)}
            />
          }
        />
      ))}
    </Group>
  );
}
