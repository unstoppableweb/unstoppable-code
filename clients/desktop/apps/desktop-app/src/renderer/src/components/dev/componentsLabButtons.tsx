import type { JSX } from 'react';
import {
  Button,
  InlineDeleteConfirm,
  ListRow,
  ListRowLink,
  ListRowStatic,
  RowActionButton,
  type ButtonSize,
  type ButtonVariant,
} from '@canopy/ui-shared/components';
import {
  ChevronRightIcon,
  CloseIcon,
  FolderIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  RefreshIcon,
  SettingsIcon,
  TrashIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  FocusOnMount,
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const VARIANTS: readonly ButtonVariant[] = [
  'primary',
  'secondary',
  'outline',
  'ghost',
  'ghost-quiet',
  'ghost-accent',
  'ghost-destructive',
  'ghost-warning',
  'ghost-overlay',
  'tinted',
  'warning',
  'destructive',
];

// `control` is deprecated (use `compact`) and `field` is the dropdown
// trigger's rectangle, shown with the fields; neither is an action size.
const ACTION_SIZES: readonly { size: ButtonSize; label: string }[] = [
  { size: 'sm', label: 'sm' },
  { size: 'md', label: 'md (default)' },
  { size: 'lg', label: 'lg' },
  { size: 'compact', label: 'compact, 28px' },
];

export function ButtonsSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="Button variants, sizes and disabled states">
        <SpecimenGrid min={320}>
          {VARIANTS.map((variant) => (
            <SpecimenCell key={variant} label={variant}>
              {ACTION_SIZES.map(({ size }) => (
                <Button key={size} size={size} variant={variant}>
                  {size}
                </Button>
              ))}
              <Button
                variant={variant}
                iconOnly
                aria-label={`Add (${variant})`}
              >
                <PlusIcon size="md" />
              </Button>
              <Button variant={variant} disabled>
                Disabled
              </Button>
            </SpecimenCell>
          ))}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Sizes">
        <SpecimenGrid min={360}>
          {ACTION_SIZES.map(({ size, label }) => (
            <SpecimenCell key={size} label={label}>
              <Button size={size} variant="primary">
                Create
              </Button>
              <Button size={size}>
                <PlusIcon />
                New chat
              </Button>
              <Button size={size} iconOnly aria-label="Settings">
                <SettingsIcon />
              </Button>
              <Button
                size={size}
                variant="ghost"
                iconOnly
                aria-label="More actions"
              >
                <FolderIcon />
              </Button>
            </SpecimenCell>
          ))}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="States and extras">
        <SpecimenGrid min={200}>
          <SpecimenCell label="Focused (keyboard ring)">
            <FocusOnMount>
              <Button variant="secondary">Focused</Button>
            </FocusOnMount>
          </SpecimenCell>
          <SpecimenCell label="aria-disabled (busy, stays in tab order)">
            <Button variant="primary" aria-disabled>
              Connecting…
            </Button>
          </SpecimenCell>
          <SpecimenCell label="With shortcut">
            <Button shortcut="⌘P">Open file</Button>
          </SpecimenCell>
          <SpecimenCell label="ghost toggle: off, then aria-pressed">
            <Button
              variant="ghost"
              iconOnly
              aria-label="Search"
              aria-pressed={false}
            >
              <MagnifyingGlassIcon />
            </Button>
            <Button variant="ghost" iconOnly aria-label="Search" aria-pressed>
              <MagnifyingGlassIcon />
            </Button>
          </SpecimenCell>
          <SpecimenCell label="Destructive with icon">
            <Button variant="destructive" size="compact">
              <TrashIcon />
              Delete
            </Button>
          </SpecimenCell>
          <SpecimenCell label="Dialog pair: Cancel is secondary" wide>
            <Button size="compact">Cancel</Button>
            <Button size="compact" variant="primary">
              Archive
            </Button>
          </SpecimenCell>
          <SpecimenCell label="groupHover: held while the ✕ is hovered" wide>
            <span className="group/gitaction relative inline-flex items-center gap-1">
              <Button size="compact" variant="ghost-accent" groupHover>
                Creating PR…
              </Button>
              <Button
                size="compact"
                variant="ghost-quiet"
                iconOnly
                aria-label="Cancel"
              >
                <CloseIcon />
              </Button>
            </span>
          </SpecimenCell>
          <SpecimenCell label="pressedHover: toolbar toggle, on and off">
            <Button
              size="sm"
              variant="ghost-overlay"
              iconOnly
              aria-label="Bookmark on"
              aria-pressed
              pressedHover
            >
              <FolderIcon />
            </Button>
            <Button
              size="sm"
              variant="ghost-overlay"
              iconOnly
              aria-label="Bookmark off"
              aria-pressed={false}
              pressedHover
            >
              <FolderIcon />
            </Button>
          </SpecimenCell>
          <SpecimenCell label="quietWhenDisabled: running Refresh">
            <Button
              size="compact"
              variant="ghost-overlay"
              iconOnly
              aria-label="Refresh"
              disabled
              quietWhenDisabled
            >
              <RefreshIcon />
            </Button>
            <Button
              size="compact"
              variant="ghost-overlay"
              iconOnly
              aria-label="Refresh"
              disabled
            >
              <RefreshIcon />
            </Button>
          </SpecimenCell>
          <SpecimenCell label='touchArea="contained": touch hit area = own box (outlined)'>
            <span className="inline-flex gap-1 [&_button]:before:outline [&_button]:before:outline-1 [&_button]:before:outline-dashed">
              <Button
                size="sm"
                variant="ghost-quiet"
                iconOnly
                aria-label="Expanded"
              >
                <FolderIcon />
              </Button>
              <Button
                size="sm"
                variant="ghost-quiet"
                iconOnly
                aria-label="Contained"
                touchArea="contained"
              >
                <FolderIcon />
              </Button>
            </span>
          </SpecimenCell>
          <SpecimenCell label='variant="link", inside a sentence' wide>
            <p className="text-s fg-secondary">
              The token expired. <Button variant="link">Sign in again</Button>{' '}
              to keep syncing.
            </p>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}

function noop(): void {}

export function ListRowSpecimen(): JSX.Element {
  return (
    <SpecimenPanel>
      <div className="flex max-w-90 flex-col gap-0.5">
        <ListRow icon={<FolderIcon />} trailing="2m">
          Idle row with icon and trailing
        </ListRow>
        <ListRow icon={<FolderIcon />} selected aria-current="true">
          Selected row
        </ListRow>
        <ListRow
          icon={<FolderIcon />}
          description="One line of secondary text"
          trailing={<ChevronRightIcon />}
        >
          Two-line row
        </ListRow>
        <ListRow icon={<FolderIcon />} disabled trailing="Off">
          Disabled, single line
        </ListRow>
        <ListRow
          icon={<FolderIcon />}
          description="Add an API key in Settings to connect"
          disabled
          trailing="Off"
        >
          Disabled row
        </ListRow>
        <ListRow trailing="12">
          A row whose label is long enough to truncate before the trailing count
        </ListRow>
        <FocusOnMount>
          <ListRow icon={<SettingsIcon />}>Focused row</ListRow>
        </FocusOnMount>
      </div>
      <SpecimenGrid min={320}>
        <SpecimenCell label="Sizes: 28, 32, 40">
          <div className="flex w-full flex-col gap-0.5">
            <ListRow size="sm" icon={<FolderIcon />} trailing="2m">
              Small
            </ListRow>
            <ListRow icon={<FolderIcon />} trailing="2m">
              Medium
            </ListRow>
            <ListRow size="lg" icon={<FolderIcon />} trailing="2m">
              Large
            </ListRow>
            <ListRow
              size="sm"
              icon={<FolderIcon />}
              description="A description grows the row"
            >
              Small, two lines
            </ListRow>
            <ListRow
              size="lg"
              icon={<FolderIcon />}
              description="A description grows the row"
            >
              Large, two lines
            </ListRow>
          </div>
        </SpecimenCell>
        <SpecimenCell label="ListRowLink">
          <div className="flex w-full flex-col gap-0.5">
            <ListRowLink href="#row" icon={<FolderIcon />} trailing="2m">
              Link row
            </ListRowLink>
            <ListRowLink href="#row" icon={<FolderIcon />} selected>
              Selected link row
            </ListRowLink>
            <ListRowLink href="#row" icon={<FolderIcon />} disabled>
              Disabled link row
            </ListRowLink>
          </div>
        </SpecimenCell>
        <SpecimenCell label="ListRowStatic">
          <div className="flex w-full flex-col gap-0.5">
            <ListRowStatic icon={<FolderIcon />} trailing="Saved">
              No hover fill
            </ListRowStatic>
            <ListRowStatic icon={<FolderIcon />} selected>
              Selected static row
            </ListRowStatic>
            <ListRowStatic icon={<FolderIcon />} disabled>
              Disabled static row
            </ListRowStatic>
            <ListRowStatic
              size="lg"
              icon={<FolderIcon />}
              description="Its controls go in actions"
              actions={<Button size="compact">Connect</Button>}
            >
              Static row with an action
            </ListRowStatic>
          </div>
        </SpecimenCell>
        <SpecimenCell label="Actions">
          <div className="flex w-full flex-col gap-0.5">
            <ListRow
              icon={<FolderIcon />}
              trailing="2m"
              actions={
                <RowActionButton label="Open settings" onClick={noop}>
                  <SettingsIcon />
                </RowActionButton>
              }
            >
              Reveals on hover and focus
            </ListRow>
            <ListRow
              size="lg"
              icon={<FolderIcon />}
              description="The whole row presses"
              actions={<Button size="compact">Open</Button>}
            >
              Always visible at 40px
            </ListRow>
            <ListRowLink
              href="#row"
              icon={<FolderIcon />}
              actions={
                <RowActionButton label="Open settings" onClick={noop}>
                  <SettingsIcon />
                </RowActionButton>
              }
            >
              Link with an action
            </ListRowLink>
            <ListRow
              icon={<FolderIcon />}
              actionsReveal={false}
              actions={
                <InlineDeleteConfirm
                  onConfirm={noop}
                  onCancel={noop}
                  deleting={false}
                />
              }
            >
              Holding a confirmation
            </ListRow>
            <ListRow
              icon={<FolderIcon />}
              selected
              actions={
                <RowActionButton label="Open settings" onClick={noop}>
                  <SettingsIcon />
                </RowActionButton>
              }
            >
              Selected with actions
            </ListRow>
            <ListRow
              icon={<FolderIcon />}
              disabled
              actions={
                <RowActionButton label="Open settings" onClick={noop}>
                  <SettingsIcon />
                </RowActionButton>
              }
            >
              Disabled, actions still work
            </ListRow>
            <ListRow
              icon={<FolderIcon />}
              aria-disabled
              aria-describedby="list-row-reason"
              description={
                <span id="list-row-reason">
                  Stays focusable for this reason
                </span>
              }
            >
              Unavailable row
            </ListRow>
          </div>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}
