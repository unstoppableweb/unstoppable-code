import { ControlButton } from '@canopy/ui-shared/components';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { replayBlockClassFor } from '@canopy/desktop-instrumentation/posthog-replay-surfaces';
import {
  CenteredLoadingSpinner,
  DelayedLoadingPlaceholder,
  ChoiceList,
  ChoiceField,
  SettingsBackButton,
  SettingsRowsGroup,
  SettingsRowsRow,
  SettingsRowsSection,
  SettingsRowsSubRow,
  Skeleton,
  TextArea,
  ToggleSwitch,
  TextInput,
  SegmentedControl,
  type SegmentedControlProps,
  type SettingsRowsGroupProps,
} from '@canopy/ui-shared/components';
import { PageHeader } from '@canopy/ui-shared/primitives/PageHeader';
import { SettingsPageColumn } from '@canopy/ui-shared/components/settings/SettingsPageColumn';
import {
  forwardRef,
  useContext,
  type InputHTMLAttributes,
  type JSX,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import {
  LOADING_PLACEHOLDER_DELAY_MS,
  useDelayedFlag,
} from '@canopy/ui-shared/lib';
import { SettingsReplayPrivacyContext } from './settings-replay-privacy';

/**
 * The settings page kit. Every page in Settings composes these instead of
 * writing its own wrapper, heading, divider, row, or field classes.
 *
 * DESIGN.md: "A settings or creation flow groups related fields with
 * persistent labels, useful explanations, and clear separators between
 * notices, controls, and the work surface."
 *
 * The layout follows Linear's settings: a section is a heading over one
 * `SettingsGroup`, a rounded box whose rows are split by inset hairlines.
 * Each row is a label and a one-line hint on the leading side and one
 * control on the trailing side. Whitespace separates sections. The page
 * title and the section headings share the boxes' outer left edge.
 *
 * The page column and header, and the section, group and row kit, are the
 * shared ones the account and organization pages and the web render
 * (`SettingsPageColumn`, `PageHeader`, `SettingsRows*` in `@canopy/ui-shared`),
 * so local and hosted pages in Settings stand alike.
 */

interface SettingsPageProps {
  readonly title: string;
  /** One line that says what the page controls. */
  readonly description?: ReactNode;
  /** A page-level control aligned with the title, such as a primary action. */
  readonly headerTrailing?: ReactNode;
  /**
   * Drill-in: a page showing one item of a list returns to the list with a
   * small back control above the title, named for the list.
   */
  readonly back?: {
    readonly label: string;
    readonly onClick: () => void;
  };
  readonly dataTestId?: string;
  /**
   * Fill the height of the scroller the page sits in, so a `fill` section can
   * take the space under the header and keep its footer at the bottom of the
   * column, above the column's bottom inset. Off by default. The scroller
   * needs a definite height; content whose minimum is taller still scrolls
   * the page.
   */
  readonly fill?: boolean;
  readonly children?: ReactNode;
}

export function SettingsPage({
  title,
  description,
  headerTrailing,
  back,
  dataTestId,
  fill = false,
  children,
}: SettingsPageProps): JSX.Element {
  // Session replay: the displayed section's classification, applied on the
  // page's content because it mounts with the section's content. The page
  // header stays recorded. Without a provider the content is blocked.
  const replayBlockClass = replayBlockClassFor(
    useContext(SettingsReplayPrivacyContext),
  );

  // The shared settings column gives every `Notice` in the page the settings
  // shape (a banner between sections is a card among cards); a section's box
  // resets it for notices inside a row.
  // The column is at least the scroller's height (`min-h-full`). A `fill`
  // body grows into that height from a zero basis, so a scrolling list inside
  // it never counts its full length toward the column's; when the content's
  // minimum is taller, the column grows and the page scrolls, inset intact.
  const contentClass = fill
    ? 'flex grow basis-0 flex-col gap-10'
    : 'flex flex-col gap-10';
  return (
    <SettingsPageColumn>
      {/* The column's own rhythm (24px under the header), on one element
          that carries the page's test id. */}
      <div data-testid={dataTestId} className="flex flex-1 flex-col gap-6">
        {/* The title and the section headings share the group boxes' outer
            left edge; only the rows' text is inset inside a box. The column
            already insets the top, so the header adds none. */}
        <div className="flex flex-col gap-2">
          {back ? (
            <SettingsBackButton
              label={back.label}
              onClick={back.onClick}
              dataTestId="settings-page-back"
            />
          ) : null}
          <PageHeader
            inset="none"
            headingLevel="h1"
            reserveActions
            title={title}
            description={description}
            actions={headerTrailing ? headerTrailing : undefined}
          />
        </div>
        <div
          className={
            replayBlockClass
              ? `${replayBlockClass} ${contentClass}`
              : contentClass
          }
        >
          {children}
        </div>
      </div>
    </SettingsPageColumn>
  );
}

const noop = (): void => undefined;

const DEFAULT_LOADING_ROWS = 3;

const SAMPLE_SETTING_ROWS = [
  { label: 'Email updates', description: 'Send a summary once a week' },
  { label: 'Sound', description: 'Play a sound when a task ends' },
  { label: 'Show previews', description: 'Show message text in alerts' },
] as const;

/**
 * Setting rows with switches, as plain samples for the measured skeleton:
 * skullet draws bars over them, unseen, so the loaded rows replace them in
 * place.
 */
function SampleSettingRows({ rows }: { readonly rows: number }): JSX.Element {
  const count = Math.max(1, Math.floor(rows));
  return (
    <SettingsRowsGroup>
      {Array.from({ length: count }, (_, index) => {
        const sample =
          SAMPLE_SETTING_ROWS[index % SAMPLE_SETTING_ROWS.length] ??
          SAMPLE_SETTING_ROWS[0];
        return (
          <SettingsRowsRow
            key={index}
            label={sample.label}
            description={sample.description}
            control={
              <ToggleSwitch
                checked={false}
                label={sample.label}
                onChange={noop}
              />
            }
          />
        );
      })}
    </SettingsRowsGroup>
  );
}

/** A plain sample of one description line, measured into one bar. */
const SAMPLE_DESCRIPTION = 'A short sample description';

interface SettingsLoadingProps {
  /**
   * `form` stands in for setting rows. `spinner` is for a page whose shape
   * depends on what the load returns, such as a sign-in notice or a list.
   */
  readonly variant?: 'form' | 'spinner';
  /** Placeholder rows for `form`; match the rows the content usually has. */
  readonly rows?: number;
  readonly dataTestId?: string;
}

/**
 * The body of a settings page, section, or group whose data has not arrived
 * yet. Its space is held from the first render and it shows only after the
 * shared delay, so a fast load never flashes it. It has no visible text; the
 * placeholder announces "Loading" to assistive technology. Use it for the
 * first load only: a refetch keeps the content already on screen.
 */
export function SettingsLoading({
  variant = 'form',
  rows = DEFAULT_LOADING_ROWS,
  // Every loading body is findable while it holds its space, before the
  // delayed placeholder shows; page-specific ids also end in `-loading`.
  dataTestId = 'settings-loading',
}: SettingsLoadingProps): JSX.Element {
  if (variant === 'spinner') {
    return (
      // The page body has no height of its own, so the spinner gets a region
      // to center in instead of sitting on the first line under the title.
      <div className="flex min-h-40 flex-col" data-testid={dataTestId}>
        <DelayedLoadingPlaceholder>
          <CenteredLoadingSpinner />
        </DelayedLoadingPlaceholder>
      </div>
    );
  }
  return (
    <div data-testid={dataTestId}>
      <DelayedLoadingPlaceholder>
        <Skeleton
          loading
          label="Loading settings"
          testId="settings-skeleton-form"
          className="w-full"
        >
          <SampleSettingRows rows={rows} />
        </Skeleton>
      </DelayedLoadingPlaceholder>
    </div>
  );
}

/**
 * A row's description or status line that has not arrived: a sample line
 * measured into one bar on the text's own line, so the row keeps its height
 * when the text lands. It shows after the shared delay and announces
 * "Loading" to assistive technology only.
 */
export function SettingsDescriptionLoading({
  dataTestId,
}: {
  readonly dataTestId?: string;
}): JSX.Element {
  const visible = useDelayedFlag(true, LOADING_PLACEHOLDER_DELAY_MS);
  return (
    <span className={visible ? undefined : 'invisible'}>
      <Skeleton loading label="Loading" testId={dataTestId}>
        <span>{SAMPLE_DESCRIPTION}</span>
      </Skeleton>
    </span>
  );
}

/**
 * An unavailable or error body that keeps the page's title in place. A page
 * that is still loading renders `SettingsLoading` instead.
 */
export function SettingsPageMessage({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return <p className="text-s fg-secondary">{children}</p>;
}

/**
 * One group of related settings: the heading sits over the section's box,
 * on the box's outer left edge, and whitespace alone separates sections.
 * The heading holds only text. Every action lives in a row inside the box,
 * so no control floats outside it.
 */
export const SettingsSection = SettingsRowsSection;

interface SettingsGroupProps extends Pick<
  SettingsRowsGroupProps,
  'children' | 'dataTestId' | 'ariaLabel' | 'disabled' | 'fill' | 'surface'
> {
  /**
   * Block the box's rows from session replay, for rows that render user
   * content such as instruction text. The section heading above the box
   * stays recorded. Set it from mount; the recorder ignores a block class
   * added to an element it has already recorded.
   */
  readonly blockFromReplay?: boolean;
}

/**
 * The box a section's rows live in: the shared settings group (the secondary
 * surface with a hairline edge), so desktop pages and the shared account and
 * organization pages draw one box. Every direct child is one row.
 */
export function SettingsGroup({
  blockFromReplay = false,
  ...props
}: SettingsGroupProps): JSX.Element {
  return (
    <SettingsRowsGroup
      {...props}
      replayPrivacy={
        blockFromReplay
          ? { blockClassName: POSTHOG_REPLAY_BLOCK_CLASS }
          : undefined
      }
    />
  );
}

/**
 * One setting: its label and explanation on the leading side, its control on
 * the trailing side. A click on the row's text flips the row's switch when it
 * holds exactly one.
 */
export const SettingsRow = SettingsRowsRow;

/**
 * A setting that depends on the row it sits in, such as the maximum behind a
 * "Limit…" switch. It goes in the parent `SettingsRow`'s children.
 */
export const SettingsSubRow = SettingsRowsSubRow;

type SettingsFieldWidth = 'xs' | 'sm' | 'md' | 'full';

const FIELD_WIDTH_CLASS_NAMES: Record<SettingsFieldWidth, string> = {
  xs: 'w-20',
  sm: 'w-52',
  md: 'w-52',
  full: 'w-full',
};

export interface SettingsTextFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'className' | 'size'
> {
  /** Sized to the value it holds: a number, a name, a path. */
  readonly width?: SettingsFieldWidth;
  /** Monospace, for code the user types: a glob, a command, a pattern. */
  readonly mono?: boolean;
}

/** A one-line text, number, or secret field at the settings control height. */
export const SettingsTextField = forwardRef<
  HTMLInputElement,
  SettingsTextFieldProps
>(function SettingsTextField(
  { width = 'sm', mono = false, ...props },
  ref,
): JSX.Element {
  return (
    <span className={`inline-flex shrink-0 ${FIELD_WIDTH_CLASS_NAMES[width]}`}>
      <TextInput ref={ref} {...props} density="settings" mono={mono} />
    </span>
  );
});

export interface SettingsTextAreaProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'className'
> {
  /** Monospace, for code the user types. */
  readonly mono?: boolean;
}

/**
 * Multi-line writing, such as instructions, at reading size: the shared text
 * area, with its vertical resize grip.
 */
export const SettingsTextArea = forwardRef<
  HTMLTextAreaElement,
  SettingsTextAreaProps
>(function SettingsTextArea({ mono = false, ...props }, ref): JSX.Element {
  return <TextArea ref={ref} {...props} mono={mono} className="block" />;
});

export interface SettingsRadioOption<T extends string> {
  readonly value: T;
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly disabled?: boolean;
  readonly dataTestId?: string;
}

interface SettingsRadioGroupProps<T extends string> {
  readonly name: string;
  readonly value: T | null;
  readonly options: readonly SettingsRadioOption<T>[];
  readonly onChange: (next: T) => void;
  /** Accessible name for the group. */
  readonly label: string;
  readonly disabled?: boolean;
  readonly dataTestId?: string;
}

/**
 * A choice between options that each need a sentence of explanation: the
 * shared radio (a neutral fill when chosen, never the accent); the label takes
 * the primary ink and the explanation the secondary ink under it.
 */
export function SettingsRadioGroup<T extends string>({
  name,
  value,
  options,
  onChange,
  label,
  disabled,
  dataTestId,
}: SettingsRadioGroupProps<T>): JSX.Element {
  return (
    <ChoiceList kind="radio" aria-label={label} data-testid={dataTestId}>
      {options.map((option) => (
        <ChoiceField
          key={option.value}
          layout="row"
          kind="radio"
          name={name}
          value={option.value}
          checked={value === option.value}
          disabled={disabled || option.disabled}
          onChange={() => onChange(option.value)}
          data-testid={option.dataTestId}
          label={
            <>
              <span className="block font-medium">{option.label}</span>
              {option.description ? (
                <span className="block text-xs text-pretty fg-secondary">
                  {option.description}
                </span>
              ) : null}
            </>
          }
        />
      ))}
    </ChoiceList>
  );
}

interface SettingsOptionCardProps {
  readonly selected: boolean;
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  /** Stretch across every column of the option grid. */
  readonly fullWidth?: boolean;
  /** A picture of the option, drawn above its label. */
  readonly preview?: ReactNode;
  readonly dataTestId?: string;
}

/**
 * One choice in a small set of mutually exclusive options that each need a
 * sentence of explanation or a preview. Selection is the accent outline on
 * the accent-subtle surface, the same for every option grid in Settings.
 */
export function SettingsOptionCard({
  selected,
  label,
  description,
  onSelect,
  disabled,
  fullWidth,
  preview,
  dataTestId,
}: SettingsOptionCardProps): JSX.Element {
  return (
    <ControlButton
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onSelect}
      data-testid={dataTestId}
      presentation="settings-option-card"
      appearance={{
        preview: Boolean(preview),
        fullWidth: fullWidth === true,
        selected,
      }}
    >
      {preview}
      <span className="flex flex-col gap-1">
        <span className="block text-s font-medium fg-primary">{label}</span>
        {description ? (
          <span className="block text-xs text-pretty fg-secondary">
            {description}
          </span>
        ) : null}
      </span>
    </ControlButton>
  );
}

/**
 * Two or three short, mutually exclusive choices that switch a mode in place
 * (Append / Replace, CLI / token): the shared segmented picker at the width
 * of the settings control column. Each segment is a toggle button
 * (`aria-pressed`) inside a labelled group; with `semantics="tabs"` (a
 * Key-Value / Bulk editor switch) the segments are tabs that name the view
 * below them.
 */
export function SettingsSegmentedControl<T extends string>(
  props: Omit<SegmentedControlProps<T>, 'width'>,
): JSX.Element {
  return <SegmentedControl {...props} width="control" />;
}
