import type { JSX, ReactNode } from 'react';
import { ToggleSwitch } from '../../primitives/ToggleSwitch';
import { Heading } from '../../primitives/Heading';

/**
 * One section of an account or organization settings page, drawn the way
 * desktop Settings draws its own pages (Linear's settings): a text-only
 * heading with an optional one-line explanation, over one grouped box whose
 * rows are split by hairlines. Whitespace alone separates sections.
 *
 * Hosted account and organization settings render on web and inside the
 * desktop Settings overlay, so this section lives with the shared display
 * components. Desktop's local pages compose `SettingsSection` and
 * `SettingsGroup` from its `SettingsLayout`; the two draw the same heading
 * and box, and should converge on this module.
 */
export const SETTINGS_CARD_CLASS = 'flex flex-col gap-3';
/**
 * The settings box: the secondary surface with a hairline edge and the side
 * inset its rows and dividers share. Every grouped box in Settings, desktop
 * pages and the shared account and organization pages, draws this one.
 */
export const SETTINGS_GROUP_SURFACE_CLASS =
  'rounded-lg bg-secondary px-4 ring-[length:var(--border-hairline)] ring-line-base';
/**
 * A box whose direct children are its rows: each row gets the 12px vertical
 * inset, and an inset hairline splits it from the next. Desktop's
 * `SettingsGroup` draws this, and so does any list of rows on an account or
 * organization page (members, teams, API keys, projects).
 */
export const SETTINGS_GROUP_CLASS = `flex flex-col divide-y ${SETTINGS_GROUP_SURFACE_CLASS} *:py-3`;
/**
 * {@link SETTINGS_GROUP_CLASS} laid out as one grid, for a list whose rows end
 * in controls (a role dropdown, a Remove or Leave action). The caller sets
 * the columns (`grid-cols-[minmax(0,1fr)_auto_auto]`) and each row takes
 * {@link SETTINGS_GROUP_GRID_ROW_CLASS}, a subgrid of the box, so every
 * trailing column is as wide as its widest entry across all rows: the
 * controls line up down the list and a row's action fills its column.
 */
export const SETTINGS_GROUP_GRID_CLASS = `grid divide-y ${SETTINGS_GROUP_SURFACE_CLASS} *:py-3`;
/** One row of a {@link SETTINGS_GROUP_GRID_CLASS} list. */
export const SETTINGS_GROUP_GRID_ROW_CLASS =
  'col-span-full grid grid-cols-subgrid items-center gap-y-3';
/**
 * The grouped box under a section heading. A box that holds rows
 * ({@link SETTINGS_CARD_ROW_CLASS}, or a host's own rows under a
 * `data-settings-card-rows` element) lets the rows set its vertical rhythm;
 * any other content gets the box's own 16px inset.
 */
export const SETTINGS_CARD_GROUP_CLASS = `${SETTINGS_GROUP_SURFACE_CLASS} py-4 has-[.settings-card-row,[data-settings-card-rows]]:py-0 [&>*:first-child]:mt-0`;
/**
 * The section heading style. Exported so a section whose heading row carries
 * extra inline chrome (a plan pill) can hand-roll the row and still share one
 * literal with the component.
 */
export const SETTINGS_CARD_TITLE_CLASS =
  'text-m font-medium text-pretty fg-primary';
/** The section explanation style, exported for the same reason. */
export const SETTINGS_CARD_SUBTITLE_CLASS = 'text-xs text-pretty fg-secondary';

export interface SettingsCardProps {
  /**
   * A string renders the canonical `<h2>`. Pass a node only when the heading
   * row carries extra inline chrome (pills, badges) and still owns its own
   * `<h2>`.
   */
  title: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
  testId?: string;
}

export function SettingsCard({
  title,
  subtitle,
  children,
  testId,
}: SettingsCardProps): JSX.Element {
  return (
    <section className={SETTINGS_CARD_CLASS} data-testid={testId}>
      <div className="flex min-w-0 flex-col gap-1">
        {typeof title === 'string' ? (
          <Heading level={2} variant="section">
            {title}
          </Heading>
        ) : (
          title
        )}
        {subtitle ? (
          <p className={SETTINGS_CARD_SUBTITLE_CLASS}>{subtitle}</p>
        ) : null}
      </div>
      {children ? (
        <div className={SETTINGS_CARD_GROUP_CLASS}>{children}</div>
      ) : null}
    </section>
  );
}

/**
 * One row in a section's grouped box: the label and explanation on the
 * leading side, one control on the trailing side. Consecutive rows are split
 * by a hairline; the box supplies the side inset.
 *
 * The row keeps desktop's rhythm: at least 40px of content inside a 12px
 * vertical inset (64px), with the hairline outside that height, so a row
 * here and a desktop `SettingsRow` stand exactly as tall.
 *
 * `settings-card-row` is a structural marker, not styling: the box reads it
 * (`has-[.settings-card-row]`) to hand its vertical inset to the rows.
 */
export const SETTINGS_CARD_ROW_CLASS =
  'settings-card-row box-content flex min-h-10 items-center justify-between gap-4 py-3 [&+&]:border-t [ul+&]:border-t';

export interface SettingsCardSwitchProps {
  readonly id?: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  /**
   * Set while the value has not been read yet. `aria-checked` stays boolean
   * because WAI-ARIA does not allow `mixed` on `switch`.
   */
  readonly busy?: boolean;
  /** Accessible name. Required: the track renders no text of its own. */
  readonly label: string;
  readonly onChange: (next: boolean) => void;
  readonly dataTestId?: string;
}

/**
 * The on/off switch in a settings row: the app's shared 32x18 switch. Pure
 * display: it reports the requested next value, so the caller owns the async
 * work and the `disabled` window around it.
 */
export function SettingsCardSwitch({
  id,
  checked,
  disabled,
  busy,
  label,
  onChange,
  dataTestId,
}: SettingsCardSwitchProps): JSX.Element {
  return (
    <ToggleSwitch
      id={id}
      checked={checked}
      disabled={disabled}
      busy={busy}
      label={label}
      onChange={onChange}
      dataTestId={dataTestId}
    />
  );
}
