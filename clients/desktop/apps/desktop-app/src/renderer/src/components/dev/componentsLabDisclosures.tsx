import { useState, type JSX, type ReactNode } from 'react';
import {
  Disclosure,
  DisclosureButton,
  DisclosureChevron,
  DisclosureToggle,
  SidebarSectionToggle,
  SidebarToggleRow,
  type DisclosureChevronDirection,
  type DisclosureToggleVariant,
} from '@canopy/ui-shared/components';
import { ArchiveIcon, ChatIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  FocusOnMount,
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const noop = (): void => undefined;

const CHEVRON_DIRECTIONS: readonly DisclosureChevronDirection[] = [
  'right',
  'down',
  'up',
];

function DisclosureSection(): JSX.Element {
  return (
    <SpecimenPanel title="Disclosure">
      <SpecimenGrid min={260}>
        <SpecimenCell label="inline, closed">
          <Disclosure label="Setup logs">Installed in 4s.</Disclosure>
        </SpecimenCell>
        <SpecimenCell label="inline, open">
          <Disclosure label="Setup logs" defaultOpen>
            Installed in 4s.
          </Disclosure>
        </SpecimenCell>
        <SpecimenCell label="inline, closed with a hint">
          <Disclosure label="Advanced" hint="Private memory on">
            Private memory
          </Disclosure>
        </SpecimenCell>
        <SpecimenCell label="box, closed with meta">
          <div className="flex w-64 flex-col">
            <Disclosure variant="box" label="Sources" meta="3 sources">
              Three sources
            </Disclosure>
          </div>
        </SpecimenCell>
        <SpecimenCell label="box, open">
          <div className="flex w-64 flex-col">
            <Disclosure variant="box" label="Sources" defaultOpen>
              Three sources
            </Disclosure>
          </div>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

function DisclosureChevronSection(): JSX.Element {
  return (
    <SpecimenPanel title="DisclosureChevron">
      <SpecimenGrid>
        {CHEVRON_DIRECTIONS.map((direction) => (
          <SpecimenCell key={direction} label={`${direction}, 16 and 12px`}>
            <span className="inline-flex items-center gap-2 fg-secondary">
              <DisclosureChevron direction={direction} />
              <DisclosureChevron direction={direction} size="xs" />
            </span>
          </SpecimenCell>
        ))}
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

function DisclosureButtonSection(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <SpecimenPanel title="DisclosureButton">
      <SpecimenGrid min={200}>
        <SpecimenCell label="closed">
          <DisclosureButton
            open={false}
            onToggle={noop}
            closedLabel="3 globs enabled"
            openLabel="Hide globs"
          />
        </SpecimenCell>
        <SpecimenCell label="open">
          <DisclosureButton
            open
            onToggle={noop}
            closedLabel="3 globs enabled"
            openLabel="Hide globs"
          />
        </SpecimenCell>
        <SpecimenCell label="live">
          <DisclosureButton
            open={open}
            onToggle={(): void => setOpen((value) => !value)}
            closedLabel="4/6 labels enabled"
            openLabel="Hide labels"
          />
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

function ToggleCell({
  label,
  variant,
  open,
  frameClassName,
  children,
}: {
  readonly label: string;
  readonly variant: DisclosureToggleVariant;
  readonly open: boolean;
  /** The row or card the variant expects around it. */
  readonly frameClassName: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <SpecimenCell label={label}>
      <div className={frameClassName}>
        <DisclosureToggle
          variant={variant}
          open={open}
          aria-label={label}
          onClick={noop}
        >
          {children}
        </DisclosureToggle>
      </div>
    </SpecimenCell>
  );
}

function DisclosureToggleSection(): JSX.Element {
  return (
    <SpecimenPanel title="DisclosureToggle, for a body that lives apart">
      <SpecimenCell label="Unavailable: disabled and focusable aria-disabled">
        <div className="flex flex-col gap-2">
          <DisclosureToggle variant="row" open={false} disabled onClick={noop}>
            <span>A disabled row</span>
            <DisclosureChevron direction="down" />
          </DisclosureToggle>
          <DisclosureToggle
            variant="row"
            open={false}
            aria-disabled="true"
            onClick={noop}
          >
            <span>A focusable unavailable row with a long label</span>
            <DisclosureChevron direction="down" />
          </DisclosureToggle>
        </div>
      </SpecimenCell>

      <SpecimenGrid min={260}>
        {[false, true].map((open) => (
          <ToggleCell
            key={`tree-${String(open)}`}
            label={`tree, ${open ? 'open' : 'closed'}`}
            variant="tree"
            open={open}
            frameClassName="flex w-64 items-center gap-1.5 text-xs fg-primary"
          >
            <DisclosureChevron direction={open ? 'down' : 'right'} animated />
          </ToggleCell>
        ))}
        {[false, true].map((open) => (
          <ToggleCell
            key={`tree-icon-${String(open)}`}
            label={`tree-icon, ${open ? 'open' : 'closed'}`}
            variant="tree-icon"
            open={open}
            frameClassName="flex w-64 items-center gap-1.5"
          >
            <DisclosureChevron
              direction={open ? 'down' : 'right'}
              size="xs"
              animated
            />
          </ToggleCell>
        ))}
        {[false, true].map((open) => (
          <ToggleCell
            key={`row-${String(open)}`}
            label={`row, ${open ? 'open' : 'closed'}`}
            variant="row"
            open={open}
            frameClassName="flex w-64 flex-col"
          >
            <span className="fg-primary">Context</span>
            <span className="flex items-center gap-1 fg-secondary">
              24%
              <DisclosureChevron direction={open ? 'up' : 'down'} animated />
            </span>
          </ToggleCell>
        ))}
        {[false, true].map((open) => (
          <ToggleCell
            key={`usage-section-${String(open)}`}
            label={`usage-section, ${open ? 'open' : 'closed'}`}
            variant="usage-section"
            open={open}
            frameClassName="relative flex w-64 items-center text-xs"
          >
            <span className="whitespace-nowrap fg-primary">Usage limits</span>
          </ToggleCell>
        ))}
        {(['summary', 'summary-wrapping'] as const).map((variant) => (
          <ToggleCell
            key={variant}
            label={variant}
            variant={variant}
            open={false}
            frameClassName="@container/turn-files relative flex w-64"
          >
            <span className="min-w-0 flex-1 truncate fg-primary">
              3 files changed
            </span>
            <DisclosureChevron direction="right" />
          </ToggleCell>
        ))}
        <ToggleCell
          label="sidebar-group, open"
          variant="sidebar-group"
          open
          frameClassName="group/sidebar-item flex w-64"
        >
          <span className="flex size-5 shrink-0 items-center justify-center">
            <DisclosureChevron direction="down" />
          </span>
          <span className="truncate">Client work</span>
        </ToggleCell>
        <ToggleCell
          label="sidebar-group, closed"
          variant="sidebar-group"
          open={false}
          frameClassName="group/sidebar-item flex w-64"
        >
          <span className="flex size-5 shrink-0 items-center justify-center">
            <DisclosureChevron direction="right" />
          </span>
          <span className="truncate">Client work</span>
        </ToggleCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

function SidebarSectionToggleSection(): JSX.Element {
  const [open, setOpen] = useState(true);
  return (
    <SpecimenPanel title="SidebarSectionToggle">
      <SpecimenGrid min={220}>
        <SpecimenCell label="chats, open (chevron on hover or focus)">
          <div className="group/chats flex w-52">
            <SidebarSectionToggle
              section="chats"
              label="Chats"
              open
              onClick={noop}
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="chats, collapsed">
          <div className="group/chats flex w-52">
            <SidebarSectionToggle
              section="chats"
              label="Chats"
              open={false}
              onClick={noop}
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="chats, stuck over its rows">
          <div className="group/chats flex w-52">
            <SidebarSectionToggle
              section="chats"
              label="Chats"
              open
              stuck
              ariaLabel="Back to Chats"
              onClick={noop}
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="chats, long name truncates">
          <div className="group/chats flex w-32">
            <SidebarSectionToggle
              section="chats"
              label="A very long chats workspace name"
              open={false}
              onClick={noop}
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="workspaces, live">
          <div className="group/workspaces flex w-52">
            <SidebarSectionToggle
              section="workspaces"
              label="Projects"
              open={open}
              onClick={(): void => setOpen((value) => !value)}
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="workspaces, collapsed, touch target">
          <div className="group/workspaces flex w-52">
            <SidebarSectionToggle
              section="workspaces"
              label="Projects"
              open={false}
              touchTarget
              onClick={noop}
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="focused">
          <FocusOnMount>
            <div className="group/chats flex w-52">
              <SidebarSectionToggle
                section="chats"
                label="Chats"
                open
                onClick={noop}
              />
            </div>
          </FocusOnMount>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

function SidebarToggleRowSection(): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  return (
    <SpecimenPanel title="SidebarToggleRow">
      <SpecimenGrid min={240}>
        <SpecimenCell label="show all, closed">
          <div className="flex w-56">
            <SidebarToggleRow
              label="Show all"
              expanded={false}
              onToggle={noop}
              ariaLabel="Show all 12 chats"
              count={12}
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="show all, open">
          <div className="flex w-56">
            <SidebarToggleRow
              label="Show fewer"
              expanded
              onToggle={noop}
              ariaLabel="Show fewer chats"
              count={12}
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="with a leading mark, closed">
          <div className="flex w-56">
            <SidebarToggleRow
              label="Archived (4)"
              expanded={false}
              onToggle={noop}
              leading={<ArchiveIcon size="md" />}
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="with a leading mark, live">
          <div className="flex w-56">
            <SidebarToggleRow
              label="Archived (4)"
              expanded={expanded}
              onToggle={(): void => setExpanded((value) => !value)}
              leading={<ChatIcon size="md" />}
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="long label truncates">
          <div className="flex w-36">
            <SidebarToggleRow
              label="Archived worktrees and their chats (128)"
              expanded={false}
              onToggle={noop}
              count={128}
            />
          </div>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

/** Every disclosure part, in every state it has. */
export function DisclosuresSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <DisclosureSection />
      <SidebarSectionToggleSection />
      <SidebarToggleRowSection />
      <DisclosureToggleSection />
      <DisclosureButtonSection />
      <DisclosureChevronSection />
    </div>
  );
}
