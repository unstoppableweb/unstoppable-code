import { useState, type JSX, type ReactNode } from 'react';
import {
  Button,
  CopyButton,
  DialogModal,
  Fact,
  FactList,
  Inline,
  InlineMention,
  SettingsRowsGroup,
  SettingsRowsRow,
  SettingsRowsSection,
  Stack,
  TabBar,
  TextInput,
  Tooltip,
  ValueRow,
  ValueRows,
  type SpaceRole,
} from '@canopy/ui-shared/components';
import {
  FileIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  LinearIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

export function FactsSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="FactList, columns (a panel's facts)">
        <SpecimenGrid min={280}>
          <SpecimenCell label="Default: auto label column, xs">
            <FactList>
              <Fact label="Branch" mono>
                feat/components-lab
              </Fact>
              <Fact label="Updated">2 minutes ago</Fact>
              <Fact label="Cost" numeric>
                $1.24
              </Fact>
              <Fact label="Status" valueTone="destructive">
                Checks failed
              </Fact>
            </FactList>
          </SpecimenCell>
          <SpecimenCell label="Value fits: truncate, break-all, row">
            <FactList labelWidth="5rem" size="s">
              <Fact label="Title" fit="truncate">
                A long pull request title that truncates at the column edge
              </Fact>
              <Fact label="Path" fit="break-all" mono>
                packages/ui-shared/src/components/settings/ValueRows.tsx
              </Fact>
              <Fact label="Token" fit="row" mono>
                <span className="truncate">ghp_8f2c…a91e</span>
                <CopyButton value="ghp_8f2c…a91e" ariaLabel="Copy token" />
              </Fact>
            </FactList>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="FactList, stacked (stat tiles)">
        <FactList layout="stacked" columns={4} valueSize="large">
          <Fact label="Chats" numeric>
            128
          </Fact>
          <Fact label="Pull requests" numeric>
            42
          </Fact>
          <Fact label="Spend" numeric>
            $86.10
          </Fact>
          <Fact label="Failures" numeric valueTone="destructive">
            3
          </Fact>
        </FactList>
        <FactList layout="stacked" columns={2} divided>
          <Fact label="Model">Claude Opus</Fact>
          <Fact label="Effort">High</Fact>
        </FactList>
      </SpecimenPanel>
      <SpecimenPanel title="FactList, spread and inline">
        <SpecimenGrid min={280}>
          <SpecimenCell label="Spread, as on a tooltip: inherited ink, 2xs">
            <div className="w-56">
              <FactList
                layout="spread"
                size="2xs"
                rowGap="0.5"
                labelTone="inherit"
                valueTone="inherit"
              >
                <Fact label="Provider" fit="row">
                  Anthropic
                </Fact>
                <Fact label="Billing" fit="row">
                  Organization gateway
                </Fact>
                <Fact label="Context" fit="row">
                  A long value that wraps to a second line at the trailing edge
                </Fact>
              </FactList>
            </div>
          </SpecimenCell>
          <SpecimenCell label="Inline, a chart legend: swatch, value, quiet detail">
            <FactList
              layout="inline"
              rowGap="1"
              columnGap="3"
              labelTone="secondary"
            >
              <Fact
                label="Input"
                swatch="var(--chart-categorical-1)"
                detail="61%"
                numeric
              >
                $1.24
              </Fact>
              <Fact
                label="Output"
                swatch="var(--chart-categorical-2)"
                detail="21%"
                numeric
              >
                $0.42
              </Fact>
              <Fact
                label="Cache reads"
                swatch="var(--chart-categorical-3)"
                numeric
              >
                $0.36
              </Fact>
            </FactList>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="ValueRows (figures in panels, sheets and popovers)">
        <div className="max-w-110">
          <ValueRows>
            <ValueRow label="Input tokens" value="1.2M" share="61%" />
            <ValueRow label="Output tokens" value="410K" share="21%" />
            <ValueRow
              label="Cache reads"
              note="Billed at a tenth"
              value="352K"
              share="18%"
            />
          </ValueRows>
        </div>
      </SpecimenPanel>
      <SpecimenPanel title="Settings rows (a detail page's facts)">
        <div className="max-w-160">
          <SettingsRowsSection title="Repository">
            <SettingsRowsGroup>
              <SettingsRowsRow label="Default branch" fact>
                develop
              </SettingsRowsRow>
              <SettingsRowsRow
                label="Auto-archive"
                description="Archive chats a week after their pull request merges."
                control={<Button size="compact">Change</Button>}
              />
            </SettingsRowsGroup>
          </SettingsRowsSection>
        </div>
      </SpecimenPanel>
    </div>
  );
}

/**
 * Holds dialogs on the page: a transformed box is the containing block for
 * the dialog's fixed overlay, so the real `DialogModal` draws inside it.
 */
function DialogFrame({
  height,
  children,
}: {
  readonly height: number;
  readonly children: (container: HTMLElement) => ReactNode;
}): JSX.Element {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  return (
    <div
      ref={setContainer}
      className="relative w-full overflow-hidden rounded-lg"
      style={{ height, transform: 'translateZ(0)' }}
    >
      {container ? children(container) : null}
    </div>
  );
}

const noop = (): void => undefined;

export function DialogSpecimen(): JSX.Element {
  const [tab, setTab] = useState<'general' | 'members'>('general');
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="DialogModal, 24px section inset with a footer">
        <DialogFrame height={340}>
          {(container): ReactNode => (
            <DialogModal
              title="Rename project"
              subtitle="Shown in the sidebar and on the web."
              onClose={noop}
              portalContainer={container}
              trapFocus={false}
              closeOnEscape={false}
              noEnterAnimation
              maxWidth="md"
              footer={
                <>
                  <Button size="compact">Cancel</Button>
                  <Button size="compact" variant="primary">
                    Save
                  </Button>
                </>
              }
            >
              <TextInput aria-label="Project name" defaultValue="Mobile app" />
            </DialogModal>
          )}
        </DialogFrame>
      </SpecimenPanel>
      <SpecimenPanel title='variant="confirm"'>
        <DialogFrame height={260}>
          {(container): ReactNode => (
            <DialogModal
              variant="confirm"
              title="Archive chat?"
              onClose={noop}
              portalContainer={container}
              trapFocus={false}
              closeOnEscape={false}
              noEnterAnimation
              footer={
                <>
                  <Button size="compact">Cancel</Button>
                  <Button size="compact" variant="primary">
                    Archive
                  </Button>
                </>
              }
            >
              <p className="text-s fg-secondary">
                You can find it again under Archived.
              </p>
            </DialogModal>
          )}
        </DialogFrame>
      </SpecimenPanel>
      <SpecimenPanel title="Tabs in a dialog header (TabBar compact, dialog inset)">
        <DialogFrame height={320}>
          {(container): ReactNode => (
            <DialogModal
              title="Organization"
              onClose={noop}
              portalContainer={container}
              trapFocus={false}
              closeOnEscape={false}
              noEnterAnimation
              maxWidth="lg"
              inset="flush"
            >
              <TabBar
                label="Organization sections"
                items={[
                  { id: 'general', label: 'General' },
                  { id: 'members', label: 'Members', count: 8 },
                ]}
                value={tab}
                onChange={setTab}
                density="compact"
                inset="dialog"
              />
              <div className="px-6 py-4 text-s fg-secondary">
                {tab === 'general'
                  ? 'Name, logo and default model.'
                  : 'Eight people can open this workspace.'}
              </div>
            </DialogModal>
          )}
        </DialogFrame>
      </SpecimenPanel>
    </div>
  );
}

const SPACE_ROLES: readonly { role: SpaceRole; px: number }[] = [
  { role: 'tight', px: 4 },
  { role: 'inline', px: 8 },
  { role: 'item', px: 12 },
  { role: 'group', px: 16 },
  { role: 'block', px: 20 },
  { role: 'section', px: 24 },
  { role: 'page', px: 32 },
  { role: 'hero', px: 40 },
];

function Swatch(): JSX.Element {
  return <span className="block h-4 w-8 rounded-sm bg-accent-subtle" />;
}

export function SpacingSpecimen(): JSX.Element {
  return (
    <SpecimenPanel>
      <SpecimenGrid min={180}>
        {SPACE_ROLES.map(({ role, px }) => (
          <SpecimenCell key={role} label={`${role}, ${px}px`}>
            <Inline gap={role}>
              <Swatch />
              <Swatch />
              <Swatch />
            </Inline>
          </SpecimenCell>
        ))}
      </SpecimenGrid>
      <SpecimenCell label="Stack gap=group around Inline gap=inline" wide>
        <Stack gap="group">
          <Inline>
            <Swatch />
            <Swatch />
          </Inline>
          <Inline>
            <Swatch />
            <Swatch />
          </Inline>
        </Stack>
      </SpecimenCell>
    </SpecimenPanel>
  );
}

export function ReferenceChipsSpecimen(): JSX.Element {
  return (
    <SpecimenPanel>
      <SpecimenCell label="Clickable references: accent chip, ID only" wide>
        <p className="text-s fg-primary">
          Fixed in{' '}
          <InlineMention icon={GitPullRequestIcon} onClick={noop}>
            #7116
          </InlineMention>{' '}
          for{' '}
          <InlineMention icon={LinearIcon} onClick={noop}>
            CAN-2405
          </InlineMention>
          , landed as{' '}
          <InlineMention icon={GitCommitIcon} onClick={noop}>
            9806bd5
          </InlineMention>
          .
        </p>
      </SpecimenCell>
      <SpecimenCell label="Static reference: grey, for code and paths" wide>
        <p className="text-s fg-primary">
          See <InlineMention icon={FileIcon}>Button.tsx:295</InlineMention> for
          the press class.
        </p>
      </SpecimenCell>
      <SpecimenCell label="Scales with the copy around it" wide>
        <p className="text-lg fg-primary">
          Larger copy keeps the chip in step:{' '}
          <InlineMention icon={GitPullRequestIcon} onClick={noop}>
            #7258
          </InlineMention>
        </p>
      </SpecimenCell>
    </SpecimenPanel>
  );
}

export function TooltipSpecimen(): JSX.Element {
  return (
    <SpecimenPanel>
      <SpecimenGrid min={200}>
        <SpecimenCell label="Tooltip (point at it)">
          <Tooltip label="Open settings">
            <Button size="compact">Hover me</Button>
          </Tooltip>
        </SpecimenCell>
        <SpecimenCell label="Tooltip with a shortcut">
          <Tooltip label="New chat" shortcut="⌘N">
            <Button size="compact">Shortcut</Button>
          </Tooltip>
        </SpecimenCell>
        <SpecimenCell label='tone="inverse"'>
          <Tooltip label="Inverse tooltip" tone="inverse">
            <Button size="compact">Inverse</Button>
          </Tooltip>
        </SpecimenCell>
        <SpecimenCell label="CopyButton, icon only">
          <CopyButton value="feat/components-lab" ariaLabel="Copy branch" />
        </SpecimenCell>
        <SpecimenCell label="CopyButton with a label">
          <CopyButton
            value="feat/components-lab"
            label="Copy branch"
            variant="secondary"
            size="compact"
          />
        </SpecimenCell>
        <SpecimenCell label="CopyButton, longer copied label">
          <CopyButton
            value="feat/components-lab"
            label="Copy"
            copiedLabel="Copied"
            variant="secondary"
            size="compact"
          />
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}
