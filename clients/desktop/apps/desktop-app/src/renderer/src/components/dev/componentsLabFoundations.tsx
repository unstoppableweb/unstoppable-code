import {
  useContext,
  useEffect,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import {
  Badge,
  Button,
  DataTable,
  Fact,
  FactList,
  Surface,
  TextInput,
  type BadgeTone,
  type DataTableColumn,
  type SurfaceVariant,
} from '@canopy/ui-shared/components';
import type { ComponentsLabEntry } from './componentsLabCatalog';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';
import { LabColorModeContext } from './componentsLabStageContext';

/**
 * The token sheets: colors, text, radius and shadows. Every sample is drawn
 * by the shared component that owns the token (a `Surface` variant for a
 * fill or a corner, a `Badge` for a state tint, `Fact`'s swatch for a single
 * color), so the sheet never hand-sets a surface. Sizes and values that the
 * page can read are read live from the theme, so they cannot drift from it.
 */

const SRC = 'packages/ui-shared/src';

/** A theme variable's value on the root, re-read when the color mode changes. */
function useThemeValues(names: readonly string[]): ReadonlyMap<string, string> {
  const mode = useContext(LabColorModeContext);
  const [values, setValues] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    // The theme's variables land a frame after the mode class does.
    const frame = requestAnimationFrame(() => {
      const style = getComputedStyle(document.documentElement);
      setValues(
        new Map(
          names.map((name) => [name, style.getPropertyValue(name).trim()]),
        ),
      );
    });
    return (): void => cancelAnimationFrame(frame);
  }, [names, mode]);
  return values;
}

/**
 * A fill, shown by the Surface variant that draws it. The box variants carry
 * their own hairline; the rail is a full-bleed region, so it sits in a frame.
 */
function FillTile({
  variant,
}: {
  readonly variant: 'inset' | 'card' | 'group' | 'rail';
}): JSX.Element {
  if (variant === 'rail') {
    return (
      <Surface variant="outline" padding="tight" className="w-full">
        <Surface variant="rail">
          <div className="h-12" />
        </Surface>
      </Surface>
    );
  }
  return (
    <Surface variant={variant} className="w-full">
      <div className="h-16" />
    </Surface>
  );
}

const FILLS: readonly {
  readonly variant: 'inset' | 'card' | 'group' | 'rail';
  readonly label: string;
}[] = [
  { variant: 'inset', label: 'bg-base: the page surface (pane, inset)' },
  { variant: 'card', label: 'bg-card: a card or work panel (panel, card)' },
  { variant: 'group', label: 'bg-secondary: a grouped box (well, group)' },
  { variant: 'rail', label: 'bg-sidebar: a navigation region (rail)' },
];

interface InkRow {
  readonly token: string;
  readonly use: string;
  readonly sample: ReactNode;
}

const INKS: readonly InkRow[] = [
  {
    token: 'fg-primary',
    use: 'Primary content',
    sample: <span className="fg-primary">Release notes draft</span>,
  },
  {
    token: 'fg-secondary',
    use: 'Supporting text, one step down',
    sample: <span className="fg-secondary">Release notes draft</span>,
  },
  {
    token: 'fg-tertiary',
    use: 'An explanation after a state on the same line',
    sample: <span className="fg-tertiary">Release notes draft</span>,
  },
  {
    token: 'fg-quaternary',
    use: 'A count beside a label, trailing shortcut glyphs',
    sample: <span className="fg-quaternary">Release notes draft</span>,
  },
  {
    token: 'fg-disabled',
    use: 'Disabled',
    sample: <span className="fg-disabled">Release notes draft</span>,
  },
  {
    token: 'fg-accent',
    use: 'Accent ink for an accent action',
    sample: <span className="fg-accent">Release notes draft</span>,
  },
  {
    token: 'fg-emphasis',
    use: 'On a solid intent fill (bg-accent, bg-destructive)',
    sample: (
      <Button size="compact" variant="primary" tabIndex={-1}>
        Save
      </Button>
    ),
  },
];

const INK_COLUMNS: ReadonlyArray<DataTableColumn<InkRow>> = [
  { key: 'sample', header: 'Sample', render: (row) => row.sample },
  {
    key: 'token',
    header: 'Utility',
    render: (row) => <code>{row.token}</code>,
  },
  { key: 'use', header: 'Use', tone: 'tertiary', render: (row) => row.use },
];

const TINTS: readonly {
  readonly tone: BadgeTone;
  readonly label: string;
  readonly roles: string;
}[] = [
  { tone: 'neutral', label: 'Queued', roles: 'bg-muted, fg-secondary, no dot' },
  { tone: 'info', label: 'Unread', roles: 'dot: fg-info' },
  { tone: 'success', label: 'Passed', roles: 'dot: fg-success-strong' },
  { tone: 'warning', label: 'Changed', roles: 'dot: fg-warning' },
  { tone: 'danger', label: 'Failed', roles: 'dot: fg-destructive-strong' },
  { tone: 'special', label: 'Merged', roles: 'dot: fg-special-strong' },
];

const LINES: readonly { readonly token: string; readonly use: string }[] = [
  { token: 'line-base', use: 'Hairline edges and dividers' },
  { token: 'line-accent', use: 'The edge of a selected box' },
  { token: 'line-destructive', use: 'An invalid field' },
  { token: 'line-focus', use: 'Focus' },
  { token: 'line-selected', use: 'Selection' },
];

const CHART_SERIES = ['Blue', 'Orange', 'Pink', 'Cyan', 'Green', 'Purple'];

function ColorsSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel
        title="Surface fills"
        hint="Each fill is drawn by the Surface variant that owns it"
      >
        <SpecimenGrid min={220}>
          {FILLS.map(({ variant, label }) => (
            <SpecimenCell key={variant} label={label}>
              <FillTile variant={variant} />
            </SpecimenCell>
          ))}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Text and icon inks">
        <DataTable<InkRow>
          columns={INK_COLUMNS}
          rows={INKS}
          rowKey={(row): string => row.token}
          caption="Text and icon inks"
        />
      </SpecimenPanel>
      <SpecimenPanel
        title="State inks"
        hint="A status badge is a neutral capsule (bg-muted, fg-primary); only its dot takes the intent’s ink"
      >
        <SpecimenGrid min={220}>
          {TINTS.map(({ tone, label, roles }) => (
            <SpecimenCell key={tone} label={roles}>
              <Badge tone={tone}>{label}</Badge>
            </SpecimenCell>
          ))}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Lines">
        <FactList layout="inline" rowGap="1" columnGap="3" labelMono>
          {LINES.map(({ token, use }) => (
            <Fact
              key={token}
              label={token}
              swatch={`var(--${token})`}
              valueTone="secondary"
            >
              {use}
            </Fact>
          ))}
        </FactList>
      </SpecimenPanel>
      <SpecimenPanel
        title="Chart series"
        hint="The same six hues in every theme, taken in order"
      >
        <FactList layout="inline" rowGap="1" columnGap="3" labelMono>
          {CHART_SERIES.map((hue, index) => (
            <Fact
              key={hue}
              label={`chart-categorical-${index + 1}`}
              swatch={`var(--chart-categorical-${index + 1})`}
              valueTone="secondary"
            >
              {hue}
            </Fact>
          ))}
        </FactList>
      </SpecimenPanel>
    </div>
  );
}

interface TextRow {
  readonly utility: string;
  readonly metrics: string;
  readonly use: string;
  readonly sample: ReactNode;
}

const SAMPLE = 'Fix sidebar collapse at 200%';

// The scale as `docs/design/typography.md` records it.
const TEXT_SCALE: readonly TextRow[] = [
  {
    utility: 'text-m',
    metrics: '16 / 24',
    use: 'Larger body and section text',
    sample: <span className="text-m">{SAMPLE}</span>,
  },
  {
    utility: 'text-s',
    metrics: '14 / 20',
    use: 'Default body, form fields, Button labels',
    sample: <span className="text-s">{SAMPLE}</span>,
  },
  {
    utility: 'text-xs',
    metrics: '13 / 18',
    use: 'Dense rows, toolbars, settings controls',
    sample: <span className="text-xs">{SAMPLE}</span>,
  },
  {
    utility: 'text-2xs',
    metrics: '11 / 15',
    use: 'Badge labels',
    sample: <span className="text-2xs">{SAMPLE}</span>,
  },
  {
    utility: 'text-3xs',
    metrics: '10 / 14',
    use: 'Count on an icon',
    sample: <span className="text-3xs">{SAMPLE}</span>,
  },
];

const TEXT_COLUMNS: ReadonlyArray<DataTableColumn<TextRow>> = [
  { key: 'sample', header: 'Sample', render: (row) => row.sample },
  {
    key: 'utility',
    header: 'Utility',
    render: (row) => <code>{row.utility}</code>,
  },
  {
    key: 'metrics',
    header: 'Size / line',
    align: 'right',
    render: (row) => row.metrics,
  },
  { key: 'use', header: 'Use', tone: 'tertiary', render: (row) => row.use },
];

function TextSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel
        title="Scale"
        hint="Sizes are rem, so the interface scale applies"
      >
        <DataTable<TextRow>
          columns={TEXT_COLUMNS}
          rows={TEXT_SCALE}
          rowKey={(row): string => row.utility}
          caption="Text scale"
        />
      </SpecimenPanel>
      <SpecimenPanel title="Weights" hint="Use 400 and 450 only">
        <SpecimenGrid min={220}>
          <SpecimenCell label="font-normal, 400">
            <span className="text-s font-normal fg-primary">{SAMPLE}</span>
          </SpecimenCell>
          <SpecimenCell label="font-medium, 450">
            <span className="text-s font-medium fg-primary">{SAMPLE}</span>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Families">
        <SpecimenGrid min={220}>
          <SpecimenCell label="font-sans: product UI">
            <span className="font-sans text-s fg-primary">{SAMPLE}</span>
          </SpecimenCell>
          <SpecimenCell label="font-mono: code, commands, paths and identifiers">
            <span className="font-mono text-s fg-primary">
              feat/sidebar-zoom
            </span>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel
        title="Hierarchy inside a line"
        hint="Ink and weight carry it, never size"
      >
        <p className="text-xs">
          <span className="font-medium fg-primary">Paused</span>{' '}
          <span className="fg-tertiary">Waiting for approval</span>
        </p>
      </SpecimenPanel>
    </div>
  );
}

interface TokenRow {
  readonly token: string;
}

const RADIUS_TOKENS: readonly TokenRow[] = [
  '--radius-sm',
  '--radius-md',
  '--radius-row',
  '--radius-lg',
  '--radius-xl',
  '--radius-2xl',
  '--radius-3xl',
  '--radius-drawer-row',
  '--radius-drawer',
  '--radius-full',
].map((token) => ({ token }));
const RADIUS_NAMES = RADIUS_TOKENS.map((row) => row.token);

const SHADOW_TOKENS: readonly TokenRow[] = [
  '--shadow-2xs',
  '--shadow-xs',
  '--shadow-sm',
  '--shadow-md',
  '--shadow-lg',
  '--shadow-xl',
].map((token) => ({ token }));
const SHADOW_NAMES = SHADOW_TOKENS.map((row) => row.token);

function tokenColumns(
  values: ReadonlyMap<string, string>,
): ReadonlyArray<DataTableColumn<TokenRow>> {
  return [
    {
      key: 'token',
      header: 'Token',
      width: '12rem',
      render: (row) => <code>{row.token}</code>,
    },
    {
      key: 'value',
      header: 'Value in this theme',
      tone: 'tertiary',
      overflow: 'wrap',
      render: (row) => <code>{values.get(row.token) ?? ''}</code>,
    },
  ];
}

/** A corner, shown by the Surface that owns it. */
function CornerTile({
  variant,
  size,
}: {
  readonly variant: SurfaceVariant;
  readonly size?: 'small' | 'drawer';
}): JSX.Element {
  return (
    <Surface variant={variant} size={size} className="w-full">
      <div className="h-16" />
    </Surface>
  );
}

function RadiusSpecimen(): JSX.Element {
  const values = useThemeValues(RADIUS_NAMES);
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel
        title="Corners by owner"
        hint="A component owns its corner; a call site never overrides it"
      >
        <SpecimenGrid min={200}>
          <SpecimenCell label="Surface inset, or any box at size small: radius-md">
            <CornerTile variant="inset" />
          </SpecimenCell>
          <SpecimenCell label="Surface outline, group, dashed: radius-lg">
            <CornerTile variant="outline" />
          </SpecimenCell>
          <SpecimenCell label="Surface card, raised: radius-xl">
            <CornerTile variant="card" />
          </SpecimenCell>
          <SpecimenCell label="Surface at size drawer: radius-drawer">
            <CornerTile variant="outline" size="drawer" />
          </SpecimenCell>
          <SpecimenCell label="A 28px field: radius-row">
            <TextInput
              aria-label="Branch name"
              density="compact"
              defaultValue="feat/sidebar"
            />
          </SpecimenCell>
          <SpecimenCell label="A button: a full capsule">
            <Button size="compact">Create branch</Button>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Scale">
        <DataTable<TokenRow>
          columns={tokenColumns(values)}
          rows={RADIUS_TOKENS}
          rowKey={(row): string => row.token}
          caption="Radius tokens"
        />
      </SpecimenPanel>
    </div>
  );
}

function ShadowsSpecimen(): JSX.Element {
  const values = useThemeValues(SHADOW_NAMES);
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel
        title="Elevation by owner"
        hint="A box takes an edge or a shadow, never both, unless its primitive owns both"
      >
        <SpecimenGrid min={220}>
          <SpecimenCell label="Surface card: a hairline edge, no shadow">
            <CornerTile variant="card" />
          </SpecimenCell>
          <SpecimenCell label="Surface raised: shadow-sm, no edge">
            <CornerTile variant="raised" />
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel
        title="Scale"
        hint="Elevation uses this scale; never write a box-shadow"
      >
        <DataTable<TokenRow>
          columns={tokenColumns(values)}
          rows={SHADOW_TOKENS}
          rowKey={(row): string => row.token}
          caption="Shadow tokens"
          verticalAlign="top"
        />
      </SpecimenPanel>
    </div>
  );
}

export const FOUNDATION_LAB_ENTRIES: readonly ComponentsLabEntry[] = [
  {
    id: 'colors',
    name: 'Colors',
    group: 'Unified',
    note: 'Product UI uses semantic role utilities only (bg-*, fg-*, line-*), picked for the job they name, never for the hue they have today.',
    source: `${SRC}/styles/canopy-tokens-core.css`,
    prs: [],
    View: ColorsSpecimen,
  },
  {
    id: 'text',
    name: 'Text',
    group: 'Unified',
    note: 'Inter for product UI and JetBrains Mono for code and identifiers, on one five-step scale; feature code picks a step and never tunes size, weight or line height.',
    source: `${SRC}/styles/canopy-tokens-core.css`,
    prs: [],
    View: TextSpecimen,
  },
  {
    id: 'radius',
    name: 'Radius',
    group: 'Unified',
    note: 'Radii are component-owned and corners nest: a rounded control inside a rounded surface takes the surface radius minus its inset, or is a full capsule.',
    source: `${SRC}/styles/canopy-tokens-core.css`,
    prs: [],
    View: RadiusSpecimen,
  },
  {
    id: 'shadows',
    name: 'Shadows',
    group: 'Unified',
    note: 'Elevation comes from the shared shadow scale, on the primitive that owns it.',
    source: `${SRC}/styles/canopy-tokens-core.css`,
    prs: [],
    View: ShadowsSpecimen,
  },
];
