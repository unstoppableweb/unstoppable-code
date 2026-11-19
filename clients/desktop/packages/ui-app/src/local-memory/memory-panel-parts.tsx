'use client';

import { ControlButton } from '@canopy/ui-shared/components';
import { LinkedMemoryRow } from '@canopy/ui-shared/components';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '@canopy/ui-shared/lib/replay-privacy';
import {
  forwardRef,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  ActionMenuItems,
  ActionMenuRowStyle,
  Button,
  FloatingMenu,
  FloatingPickerMenu,
  PageDropdownTrigger,
  PageSearchField,
  PickerMenuOption,
  PickerMenuOptionCheck,
  PickerMenuOptionContent,
  PickerMenuOptionLabel,
  PickerMenuSection,
  PickerMenuSectionLabel,
  type ActionMenuItem,
} from '@canopy/ui-shared/components';
import {
  ChatIcon,
  CopyIcon,
  DocumentIcon,
  MoreHorizontalIcon,
  PencilIcon,
  TrashIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  memoryRowId,
  type MemoryEntry,
  type MemoryFilters,
  type MemoryKind,
} from './memory-model';

const MEMORY_KIND_LABELS: Readonly<Record<MemoryKind, string>> = {
  index: 'Index',
  topic: 'Topics',
  inbox: 'Recent notes',
};

const MEMORY_KINDS: readonly MemoryKind[] = ['index', 'topic', 'inbox'];

/**
 * The kind dropdown's text: `Any kind` with nothing hidden, the one kind
 * left when only kinds are narrowed, otherwise how many choices are off.
 */
export function memoryFilterLabel(
  filters: MemoryFilters,
  hiddenFilters: number,
): string {
  if (hiddenFilters === 0) return 'Any kind';
  const onlyKinds = hiddenFilters === MEMORY_KINDS.length - filters.kinds.size;
  const [kind] = filters.kinds;
  if (onlyKinds && filters.kinds.size === 1 && kind !== undefined) {
    return MEMORY_KIND_LABELS[kind];
  }
  return hiddenFilters === 1 ? '1 filter' : `${String(hiddenFilters)} filters`;
}

/**
 * The panel's search row: the page search field, then the kind dropdown
 * after it (not nested in it), whose menu also narrows by scope.
 */
export function MemorySearchField({
  query,
  onQueryChange,
  filters,
  hiddenFilters,
  filterMenu,
}: {
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly filters: MemoryFilters;
  readonly hiddenFilters: number;
  readonly filterMenu: (
    anchor: RefObject<HTMLButtonElement | null>,
    open: boolean,
    setOpen: (open: boolean) => void,
  ) => ReactNode;
}): JSX.Element {
  const filterRef = useRef<HTMLButtonElement>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const label = memoryFilterLabel(filters, hiddenFilters);
  return (
    <>
      <PageSearchField
        value={query}
        onValueChange={onQueryChange}
        placeholder="Search memories"
        aria-label="Search memories"
        data-testid="memory-search"
        fieldTestId="memory-search-field"
        clearTestId="memory-search-clear"
      />
      <PageDropdownTrigger
        ref={filterRef}
        label={
          hiddenFilters > 0 ? (
            <span data-testid="memory-filter-count">{label}</span>
          ) : (
            label
          )
        }
        open={filterOpen}
        active={hiddenFilters > 0}
        aria-label={`Filter memories: ${label}`}
        data-testid="memory-filter-trigger"
        onClick={() => setFilterOpen((open) => !open)}
      />
      {filterMenu(filterRef, filterOpen, setFilterOpen)}
    </>
  );
}

export function MemoryFilterMenu({
  anchorRef,
  open,
  onOpenChange,
  filters,
  onChange,
  scopeLabels,
}: {
  readonly anchorRef: RefObject<HTMLButtonElement | null>;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly filters: MemoryFilters;
  readonly onChange: (filters: MemoryFilters) => void;
  /** Filter labels for each scope; the section shows with two or more. */
  readonly scopeLabels: readonly string[];
}): JSX.Element {
  const firstOptionRef = useRef<HTMLButtonElement>(null);
  const toggled = <T,>(set: ReadonlySet<T>, value: T): Set<T> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };
  const kinds = MEMORY_KINDS.map((kind) => ({
    kind,
    label: MEMORY_KIND_LABELS[kind],
  }));
  return (
    <FloatingPickerMenu
      open={open}
      onOpenChange={onOpenChange}
      anchorRef={anchorRef}
      placement="bottom-right"
      heightLimit={360}
      interaction="menu"
      closeOnSelect={false}
      initialFocusRef={firstOptionRef}
      data-testid="memory-filter-menu"
    >
      <PickerMenuSectionLabel>Kind</PickerMenuSectionLabel>
      {kinds.map(({ kind, label }, index) => {
        const checked = filters.kinds.has(kind);
        return (
          <PickerMenuOption
            key={kind}
            ref={index === 0 ? firstOptionRef : undefined}
            role="menuitemcheckbox"
            aria-checked={checked}
            selected={checked}
            data-testid={`memory-filter-kind-${kind}`}
            onClick={() =>
              onChange({ ...filters, kinds: toggled(filters.kinds, kind) })
            }
          >
            <PickerMenuOptionCheck selected={checked} reserveSpace />
            <PickerMenuOptionContent>
              <PickerMenuOptionLabel>{label}</PickerMenuOptionLabel>
            </PickerMenuOptionContent>
          </PickerMenuOption>
        );
      })}
      {scopeLabels.length > 1 && (
        <PickerMenuSection>
          <PickerMenuSectionLabel>Saved for</PickerMenuSectionLabel>
          {scopeLabels.map((label, index) => {
            const checked = filters.scopes.has(index);
            return (
              <PickerMenuOption
                key={label}
                role="menuitemcheckbox"
                aria-checked={checked}
                selected={checked}
                data-testid={`memory-filter-scope-${index}`}
                onClick={() =>
                  onChange({
                    ...filters,
                    scopes: toggled(filters.scopes, index),
                  })
                }
              >
                <PickerMenuOptionCheck selected={checked} reserveSpace />
                <PickerMenuOptionContent>
                  <PickerMenuOptionLabel>
                    <span className={REPLAY_MASK_CLASS}>{label}</span>
                  </PickerMenuOptionLabel>
                </PickerMenuOptionContent>
              </PickerMenuOption>
            );
          })}
        </PickerMenuSection>
      )}
    </FloatingPickerMenu>
  );
}

/** A trigger and its quiet action menu, as other "…" menus use it. */
export function MemoryMoreMenu({
  label,
  items,
  testId,
  size = 'compact',
}: {
  readonly label: string;
  readonly items: readonly ActionMenuItem[];
  readonly testId: string;
  readonly size?: 'compact' | 'row';
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      {size === 'row' ? (
        <Button
          ref={anchorRef}
          type="button"
          variant="ghost"
          size="compact"
          iconOnly
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          className="-mt-0.5"
          data-testid={testId}
          onClick={(event) => {
            event.stopPropagation();
            setOpen((value) => !value);
          }}
        >
          <MoreHorizontalIcon size="sm" aria-hidden="true" />
        </Button>
      ) : (
        <Button
          ref={anchorRef}
          variant="ghost"
          size="compact"
          iconOnly
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          data-testid={testId}
          onClick={() => setOpen((value) => !value)}
        >
          <MoreHorizontalIcon size="sm" aria-hidden="true" />
        </Button>
      )}
      <FloatingMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        placement="bottom-right"
        interaction="menu"
        data-testid={`${testId}-menu`}
      >
        <ActionMenuRowStyle>
          <ActionMenuItems
            items={items}
            onSelect={(item) => {
              setOpen(false);
              anchorRef.current?.focus({ preventScroll: true });
              item.onSelect?.();
            }}
          />
        </ActionMenuRowStyle>
      </FloatingMenu>
    </>
  );
}

export function rowMenuItems(handlers: {
  readonly onEdit: () => void;
  readonly onCopy: () => void;
  /** Absent for a memory that can't be deleted: a scope's index. */
  readonly onDelete?: () => void;
}): ActionMenuItem[] {
  const { onDelete } = handlers;
  return [
    {
      key: 'edit',
      label: 'Edit',
      icon: <PencilIcon size="sm" />,
      onSelect: handlers.onEdit,
    },
    {
      key: 'copy',
      label: 'Copy text',
      icon: <CopyIcon size="sm" />,
      onSelect: handlers.onCopy,
    },
    ...(onDelete
      ? [
          {
            key: 'delete',
            label: 'Delete',
            icon: <TrashIcon size="sm" />,
            tone: 'destructive' as const,
            separatorBefore: true,
            onSelect: onDelete,
          },
        ]
      : []),
  ];
}

export interface MemoryRowProps {
  readonly entry: MemoryEntry;
  /** Which scope the memory is saved in, for hosts and tests to tell apart. */
  readonly scope: 'user' | 'workspace';
  readonly meta: string;
  readonly time: string;
  readonly onOpen: () => void;
  readonly menu: ReactNode;
}

/** A Feed-style row: title, one line of the memory, then where it's from. */
export const MemoryRow = forwardRef<HTMLButtonElement, MemoryRowProps>(
  function MemoryRow({ entry, scope, meta, time, onOpen, menu }, ref) {
    const Icon = entry.file.source ? ChatIcon : DocumentIcon;
    return (
      <LinkedMemoryRow
        data-testid="memory-row"
        data-memory-id={memoryRowId(entry.file.fileKey)}
        data-kind={entry.file.kind}
        data-scope={scope}
      >
        <ControlButton
          ref={ref}
          onClick={onOpen}
          presentation="memory-entry-open"
          data-testid="memory-row-open"
        >
          <Icon
            size="sm"
            aria-hidden="true"
            className="mt-0.5 shrink-0 fg-tertiary"
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span
              className={`truncate text-xs font-medium fg-primary ${REPLAY_MASK_CLASS}`}
              data-testid="memory-row-title"
            >
              {entry.title}
            </span>
            {entry.file.excerpt && (
              <span
                className={`truncate text-xs fg-secondary ${REPLAY_BLOCK_CLASS}`}
                data-testid="memory-row-excerpt"
              >
                {entry.file.excerpt}
              </span>
            )}
            <span
              className={`truncate text-2xs fg-tertiary ${REPLAY_MASK_CLASS}`}
              data-testid="memory-row-meta"
            >
              {meta}
            </span>
          </span>
          <span className="mt-0.5 shrink-0 whitespace-nowrap text-2xs tabular-nums fg-tertiary">
            {time}
          </span>
        </ControlButton>
        <span className="pt-2">{menu}</span>
      </LinkedMemoryRow>
    );
  },
);

/** Escape and the platform's save chord inside the editor fields. */
export function editorKeyDown(
  event: KeyboardEvent<HTMLElement>,
  onSave: () => void,
  onCancel: () => void,
): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    onSave();
  }
}
