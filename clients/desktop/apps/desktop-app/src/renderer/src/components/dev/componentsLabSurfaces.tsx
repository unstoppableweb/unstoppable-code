import type { JSX } from 'react';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  Button,
  Divider,
  Inline,
  Stack,
  Surface,
  type SurfaceBoundary,
  type SurfaceExtent,
  type SurfacePadding,
  type SurfaceVariant,
} from '@canopy/ui-shared/components';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const VARIANTS: readonly { variant: SurfaceVariant; use: string }[] = [
  { variant: 'outline', use: 'a hairline box, no fill' },
  { variant: 'group', use: 'grouped rows, Settings' },
  { variant: 'card', use: 'a standalone item' },
  { variant: 'raised', use: 'floats over a busy background' },
  { variant: 'inset', use: 'a well inside a group or card' },
  { variant: 'dashed', use: 'a drop zone or empty placeholder' },
];

const PADDINGS: readonly { padding: SurfacePadding; px: number }[] = [
  { padding: 'none', px: 0 },
  { padding: 'tight', px: 8 },
  { padding: 'compact', px: 12 },
  { padding: 'default', px: 16 },
  { padding: 'roomy', px: 24 },
];

const ATTACHED_PADDINGS = [
  { padding: 'section-compact', boundary: 'bottom', label: 'Compact section' },
  { padding: 'section-default', boundary: 'bottom', label: 'Default section' },
  { padding: 'dialog-footer', boundary: 'top', label: 'Dialog footer' },
] as const;

const BOUNDARIES: readonly SurfaceBoundary[] = [
  'none',
  'top',
  'bottom',
  'start',
  'left',
  'end',
  'right',
  'block',
  'frame',
];

function Sample({ title }: { readonly title: string }): JSX.Element {
  return (
    <Stack gap="tight">
      <span className="text-s font-medium fg-primary">{title}</span>
      <span className="text-xs fg-secondary">Updated 2 minutes ago</span>
    </Stack>
  );
}

function VariantGrid(): JSX.Element {
  return (
    <SpecimenGrid min={180}>
      {VARIANTS.map(({ variant, use }) => (
        <SpecimenCell key={variant} label={`${variant}: ${use}`}>
          <Surface variant={variant} padding="compact" className="w-full">
            <Sample title="Weekly digest" />
          </Surface>
        </SpecimenCell>
      ))}
    </SpecimenGrid>
  );
}

export function SurfacesSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="Variants, on the secondary background">
        <VariantGrid />
      </SpecimenPanel>
      <SpecimenPanel title="Variants, on the page background">
        <Surface variant="pane" padding="default">
          <VariantGrid />
        </Surface>
      </SpecimenPanel>
      <SpecimenPanel title="Page surface">
        <SpecimenCell label="A full-height page column">
          <div className="h-32 overflow-auto">
            <Surface variant="page" padding="default">
              Page content
            </Surface>
          </div>
        </SpecimenCell>
      </SpecimenPanel>

      <SpecimenPanel title="Selected (a picked plan, project or template)">
        <SpecimenGrid min={180}>
          {VARIANTS.map(({ variant }) => (
            <SpecimenCell key={variant} label={`${variant}, selected`}>
              <Surface
                variant={variant}
                padding="compact"
                selected
                className="w-full"
              >
                <Sample title="Team plan" />
              </Surface>
            </SpecimenCell>
          ))}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Small: 8px corners on a compact box">
        <SpecimenGrid min={180}>
          {VARIANTS.map(({ variant }) => (
            <SpecimenCell key={variant} label={variant}>
              <Surface
                variant={variant}
                size="small"
                padding="tight"
                className="w-full"
              >
                <span className="text-xs fg-primary">src/main/index.ts</span>
              </Surface>
            </SpecimenCell>
          ))}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Drawer: the composer drawer's 22px corners">
        <SpecimenGrid min={180}>
          {VARIANTS.map(({ variant }) => (
            <SpecimenCell key={variant} label={variant}>
              <Surface
                variant={variant}
                size="drawer"
                padding="compact"
                className="w-full"
              >
                <Sample title="Release checklist" />
              </Surface>
            </SpecimenCell>
          ))}
        </SpecimenGrid>
      </SpecimenPanel>

      <SpecimenPanel title="Interactive: the fill darkens on hover">
        <SpecimenGrid min={180}>
          {VARIANTS.map(({ variant }) => (
            <SpecimenCell key={variant} label={variant}>
              <Surface
                variant={variant}
                interactive
                padding="compact"
                className="w-full"
              >
                <Sample title="Open template" />
              </Surface>
            </SpecimenCell>
          ))}
        </SpecimenGrid>
      </SpecimenPanel>

      <SpecimenPanel title="Padding roles">
        <SpecimenGrid min={160}>
          {PADDINGS.map(({ padding, px }) => (
            <SpecimenCell key={padding} label={`${padding}, ${px}px`}>
              <Surface variant="card" padding={padding} className="w-full">
                <Sample title="Runs" />
              </Surface>
            </SpecimenCell>
          ))}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Attached section padding">
        <SpecimenGrid min={200}>
          {ATTACHED_PADDINGS.map(({ padding, boundary, label }) => (
            <SpecimenCell key={padding} label={label}>
              <Surface variant="section" boundary={boundary} padding={padding}>
                <Sample title={label} />
              </Surface>
            </SpecimenCell>
          ))}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Empty and long content">
        <SpecimenGrid min={260}>
          <SpecimenCell label="card, padding=default, no children">
            <Surface variant="card" padding="default" className="w-full" />
          </SpecimenCell>
          <SpecimenCell label="outline, long text wraps inside the padding">
            <Surface variant="outline" padding="compact" className="w-full">
              <p className="text-s text-pretty wrap-anywhere fg-primary">
                packages/ui-shared/src/components/settings/hosted/organization-members-section-with-a-very-long-name.tsx
                failed to load because the workspace index is still being
                rebuilt after the last pull.
              </p>
            </Surface>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Column gap and nesting">
        <SpecimenGrid min={260}>
          <SpecimenCell label="card, padding=default, gap=item">
            <Surface
              variant="card"
              padding="default"
              gap="item"
              className="w-full"
            >
              <Sample title="Pull request" />
              <Surface variant="inset" padding="tight">
                <span
                  className={`${REPLAY_BLOCK_CLASS} font-mono text-xs fg-secondary`}
                >
                  git push origin feat/surfaces
                </span>
              </Surface>
            </Surface>
          </SpecimenCell>
          <SpecimenCell label="group, rows split by a Divider">
            <Surface variant="group" className="w-full">
              <div className="px-4 py-3">
                <Sample title="Model" />
              </div>
              <Divider />
              <div className="px-4 py-3">
                <Sample title="Effort" />
              </div>
            </Surface>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Divider">
        <SpecimenGrid min={260}>
          <SpecimenCell label="horizontal (default)" wide>
            <Stack gap="item" className="w-full">
              <Sample title="Above" />
              <Divider />
              <Sample title="Below" />
            </Stack>
          </SpecimenCell>
          <SpecimenCell label="vertical, in a row">
            <Inline gap="item">
              <span className="text-s fg-primary">Branch</span>
              <Divider orientation="vertical" />
              <span className="text-s fg-primary">develop</span>
            </Inline>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Flat panes and attached boundaries">
        <SpecimenGrid min={260}>
          <SpecimenCell label="Pane: header and footer stay flush" wide>
            <Surface variant="pane" className="w-full">
              <Surface variant="section" boundary="bottom">
                <div className="px-4 py-3">
                  <Sample title="File preview" />
                </div>
              </Surface>
              <Surface variant="well" padding="default">
                <span className="text-xs fg-secondary">Preview content</span>
              </Surface>
              <Surface variant="section" boundary="top">
                <div className="px-4 py-3">
                  <Sample title="Read only" />
                </div>
              </Surface>
            </Surface>
          </SpecimenCell>
          <SpecimenCell label="Attached boundaries preserve keyboard focus">
            <Surface variant="section" boundary="bottom" className="w-full">
              <Button variant="secondary" size="compact" className="w-full">
                Focus the pane action
              </Button>
            </Surface>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>

      <SpecimenPanel title="Pane fills and extent">
        <SpecimenGrid min={180}>
          {(['pane', 'panel', 'rail', 'well'] as const).map((variant) => (
            <SpecimenCell key={variant} label={variant}>
              <div className="h-24 w-full overflow-hidden">
                <Surface variant={variant} extent="parent" padding="compact">
                  <Sample title="Full-height region" />
                </Surface>
              </div>
            </SpecimenCell>
          ))}
          {(
            ['content', 'parent', 'viewport'] satisfies readonly SurfaceExtent[]
          ).map((extent) => (
            <SpecimenCell
              key={extent}
              label={
                extent === 'viewport' ? 'viewport (clipped preview)' : extent
              }
            >
              <div className="h-24 w-full overflow-hidden">
                <Surface variant="panel" extent={extent} padding="compact">
                  <Sample title="Pane extent" />
                </Surface>
              </div>
            </SpecimenCell>
          ))}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Pane boundaries, including the selected frame">
        <SpecimenGrid min={180}>
          {BOUNDARIES.map((boundary) => (
            <SpecimenCell key={boundary} label={boundary}>
              <Surface
                variant="section"
                boundary={boundary}
                padding="compact"
                className="w-full"
              >
                <Sample title="Pane region" />
              </Surface>
            </SpecimenCell>
          ))}
          <SpecimenCell label="Selected frame">
            <Surface
              variant="section"
              boundary="frame"
              selected
              padding="compact"
              className="w-full"
            >
              <Sample title="Selected region" />
            </Surface>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}
