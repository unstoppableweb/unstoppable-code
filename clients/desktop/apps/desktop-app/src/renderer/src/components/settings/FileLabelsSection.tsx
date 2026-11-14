import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type {
  FileLabelBucket,
  FileLabelMatcher,
} from '@canopy/desktop-shared/types';
import { isValidFileLabelPattern } from '@canopy/desktop-shared/file-labels';
import {
  ChevronRightIcon,
  DragHandleIcon,
  PlusIcon,
  TrashIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { Tooltip } from '@canopy/ui-shared';
import {
  Stack,
  Button,
  ToggleSwitch,
  FieldError,
  DisclosureButton,
} from '@canopy/ui-shared/components';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import { useEarlyAccessTitle } from '@/lib/earlyAccessTitles';
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsSubRow,
  SettingsTextField,
} from './SettingsLayout';

interface FileLabelsSectionProps {
  labels: FileLabelBucket[];
  saveStatus: 'idle' | 'saving' | 'error';
  onSave: (labels: FileLabelBucket[]) => void;
  /**
   * Monotonic counter from a caller that wants this section expanded (the
   * changed-file filter menus' Settings entry). A non-zero value expands on
   * mount; later increments expand an already-open Files tab.
   */
  expandRequest?: number;
}

// ---------------------------------------------------------------------------
// Section disclosure
// ---------------------------------------------------------------------------

/**
 * Collapsed-by-default state for the Labels list. `expandRequest` opens it
 * from outside (see `FileLabelsSectionProps`).
 */
function useSectionDisclosure(expandRequest: number): {
  expanded: boolean;
  toggle: () => void;
} {
  const [expanded, setExpanded] = useState(expandRequest > 0);
  const lastExpandRequestRef = useRef(expandRequest);
  useEffect(() => {
    if (expandRequest !== lastExpandRequestRef.current) {
      lastExpandRequestRef.current = expandRequest;
      setExpanded(true);
    }
  }, [expandRequest]);
  const toggle = useCallback((): void => setExpanded((v) => !v), []);
  return { expanded, toggle };
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Matcher row
// ---------------------------------------------------------------------------

interface MatcherRowProps {
  matcher: FileLabelMatcher;
  onDraftChange: (updated: FileLabelMatcher) => void;
  onChange: (updated: FileLabelMatcher) => void;
  onDelete: () => void;
}

function MatcherRow({
  matcher,
  onDraftChange,
  onChange,
  onDelete,
}: MatcherRowProps): JSX.Element {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: matcher.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const patternValid =
    matcher.builtin || isValidFileLabelPattern(matcher.pattern);
  const stopId = `file-label-matcher-stop-switch-${matcher.id}`;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex flex-col gap-1"
      data-testid={`file-label-matcher-${matcher.id}`}
    >
      <div className="flex min-h-10 items-center gap-2">
        <span
          className="shrink-0 cursor-grab fg-secondary hover:fg-primary active:cursor-grabbing"
          aria-label="Reorder matcher"
          {...attributes}
          {...listeners}
        >
          <DragHandleIcon size="sm" className="shrink-0" />
        </span>
        <ToggleSwitch
          checked={matcher.enabled}
          label={`Enable matcher ${matcher.pattern}`}
          dataTestId={`file-label-matcher-toggle-${matcher.id}`}
          onChange={() => onChange({ ...matcher, enabled: !matcher.enabled })}
        />
        {matcher.builtin ? (
          <code className="min-w-0 flex-1 truncate font-mono text-xs fg-primary">
            {matcher.pattern}
          </code>
        ) : (
          <div className="min-w-0 flex-1">
            <SettingsTextField
              mono
              type="text"
              width="full"
              value={matcher.pattern}
              onChange={(e) =>
                onDraftChange({ ...matcher, pattern: e.target.value })
              }
              onBlur={() => {
                if (isValidFileLabelPattern(matcher.pattern)) {
                  onChange({ ...matcher, pattern: matcher.pattern.trim() });
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
              placeholder="**/*.test.ts"
              aria-label="Matcher glob pattern"
              aria-invalid={!patternValid}
              data-testid={`file-label-matcher-pattern-${matcher.id}`}
            />
          </div>
        )}
        <Tooltip label="When this matcher matches, stop assigning further labels to the file.">
          {/* The caption is the switch's label, so clicking it flips it. */}
          <span className="shrink-0">
            <SettingsSubRow
              htmlFor={stopId}
              label="Don't keep matching"
              control={
                <ToggleSwitch
                  id={stopId}
                  checked={matcher.stopMatching}
                  label={`Don't keep matching after ${matcher.pattern}`}
                  dataTestId={`file-label-matcher-stop-${matcher.id}`}
                  onChange={(next) =>
                    onChange({ ...matcher, stopMatching: next })
                  }
                />
              }
            />
          </span>
        </Tooltip>
        {!matcher.builtin && (
          <Button
            size="compact"
            variant="secondary"
            iconOnly
            onClick={onDelete}
            aria-label={`Delete matcher ${matcher.pattern}`}
            data-testid={`file-label-matcher-delete-${matcher.id}`}
          >
            <TrashIcon size="sm" />
          </Button>
        )}
      </div>
      {!patternValid && (
        <div className="pl-16">
          <FieldError id={`file-label-matcher-error-${matcher.id}`}>
            Enter a valid glob pattern.
          </FieldError>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add-matcher input
// ---------------------------------------------------------------------------

interface AddMatcherInputProps {
  bucketId: string;
  onAdd: (pattern: string) => void;
}

function AddMatcherInput({
  bucketId,
  onAdd,
}: AddMatcherInputProps): JSX.Element {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback((): void => {
    const trimmed = value.trim();
    if (!isValidFileLabelPattern(trimmed)) {
      setError('Enter a valid glob pattern.');
      return;
    }
    onAdd(trimmed);
    setValue('');
    setError(null);
  }, [value, onAdd]);

  return (
    <Stack gap="tight">
      <div className="flex items-center gap-2">
        <SettingsTextField
          mono
          type="text"
          width="md"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Add glob matcher…"
          aria-label="New glob matcher"
          data-testid={`file-label-add-matcher-input-${bucketId}`}
        />
        <Button
          size="compact"
          variant="secondary"
          onClick={submit}
          disabled={!value.trim()}
          data-testid={`file-label-add-matcher-${bucketId}`}
        >
          Add
        </Button>
      </div>
      {error !== null && (
        <FieldError
          id={`file-label-add-matcher-error-${bucketId}`}
          data-testid={`file-label-add-matcher-error-${bucketId}`}
        >
          {error}
        </FieldError>
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Bucket row
// ---------------------------------------------------------------------------

interface BucketRowProps {
  bucket: FileLabelBucket;
  onDraftChange: (updated: FileLabelBucket) => void;
  onChange: (updated: FileLabelBucket) => void;
  onDelete: () => void;
}

function BucketRow({
  bucket,
  onDraftChange,
  onChange,
  onDelete,
}: BucketRowProps): JSX.Element {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: bucket.id });
  const [expanded, setExpanded] = useState(false);

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const matcherSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const matcherIds = useMemo(
    () => bucket.matchers.map((m) => m.id),
    [bucket.matchers],
  );

  const handleMatcherChange = useCallback(
    (updated: FileLabelMatcher): void => {
      onChange({
        ...bucket,
        matchers: bucket.matchers.map((m) =>
          m.id === updated.id ? updated : m,
        ),
      });
    },
    [bucket, onChange],
  );

  const handleMatcherDraftChange = useCallback(
    (updated: FileLabelMatcher): void => {
      onDraftChange({
        ...bucket,
        matchers: bucket.matchers.map((m) =>
          m.id === updated.id ? updated : m,
        ),
      });
    },
    [bucket, onDraftChange],
  );

  const handleMatcherDelete = useCallback(
    (id: string): void => {
      onChange({
        ...bucket,
        matchers: bucket.matchers.filter((m) => m.id !== id),
      });
    },
    [bucket, onChange],
  );

  const handleMatcherDragEnd = useCallback(
    (event: DragEndEvent): void => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = bucket.matchers.findIndex(
        (m) => m.id === String(active.id),
      );
      const newIndex = bucket.matchers.findIndex(
        (m) => m.id === String(over.id),
      );
      if (oldIndex < 0 || newIndex < 0) return;
      onChange({
        ...bucket,
        matchers: arrayMove(bucket.matchers, oldIndex, newIndex),
      });
    },
    [bucket, onChange],
  );

  const handleAddMatcher = useCallback(
    (pattern: string): void => {
      const matcher: FileLabelMatcher = {
        id: generateId('matcher'),
        pattern,
        enabled: true,
        stopMatching: false,
        builtin: false,
      };
      onChange({ ...bucket, matchers: [...bucket.matchers, matcher] });
    },
    [bucket, onChange],
  );

  const enabledMatchers = bucket.matchers.filter((m) => m.enabled).length;
  const nameValid = bucket.name.trim().length > 0;
  const stopId = `file-label-stop-switch-${bucket.id}`;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex flex-col gap-3"
      data-testid={`file-label-bucket-${bucket.id}`}
    >
      <Stack gap="tight">
        <div className="flex min-h-10 items-center gap-2">
          <span
            className="shrink-0 cursor-grab fg-secondary hover:fg-primary active:cursor-grabbing"
            aria-label={`Reorder label ${bucket.name}`}
            {...attributes}
            {...listeners}
          >
            <DragHandleIcon size="sm" className="shrink-0" />
          </span>
          <ToggleSwitch
            id={`file-label-switch-${bucket.id}`}
            checked={bucket.enabled}
            label={`Enable label ${bucket.name}`}
            dataTestId={`file-label-toggle-${bucket.id}`}
            onChange={() => onChange({ ...bucket, enabled: !bucket.enabled })}
          />
          {bucket.builtin ? (
            <div className="min-w-0 flex-1">
              <SettingsRow
                htmlFor={`file-label-switch-${bucket.id}`}
                label={bucket.name}
              />
            </div>
          ) : (
            <div className="min-w-0 flex-1">
              <SettingsTextField
                type="text"
                width="full"
                value={bucket.name}
                onChange={(e) =>
                  onDraftChange({ ...bucket, name: e.target.value })
                }
                onBlur={() => {
                  if (nameValid) {
                    onChange({ ...bucket, name: bucket.name.trim() });
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
                placeholder="Label name"
                aria-label="Label name"
                aria-invalid={!nameValid}
                data-testid={`file-label-name-${bucket.id}`}
              />
            </div>
          )}
          <Button
            size="compact"
            variant="secondary"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            data-testid={`file-label-expand-${bucket.id}`}
          >
            <ChevronRightIcon
              size="sm"
              className={`shrink-0 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
            />
            {`${enabledMatchers}/${bucket.matchers.length} matcher${bucket.matchers.length === 1 ? '' : 's'}`}
          </Button>
          {!bucket.builtin && (
            <Button
              size="compact"
              variant="secondary"
              iconOnly
              onClick={onDelete}
              aria-label={`Delete label ${bucket.name}`}
              data-testid={`file-label-delete-${bucket.id}`}
            >
              <TrashIcon />
            </Button>
          )}
        </div>
        {!nameValid && (
          <div className="pl-16">
            <FieldError id={`file-label-name-error-${bucket.id}`}>
              Enter a label name.
            </FieldError>
          </div>
        )}
      </Stack>

      {expanded && (
        <div className="flex flex-col gap-2 pl-16">
          {/* The label's second switch is a detail of the label, so it sits
              with the matchers instead of beside the label's own switch. */}
          <SettingsSubRow
            label="Stop further labels"
            description="When a file matches this label, stop assigning further labels."
            htmlFor={stopId}
            control={
              <ToggleSwitch
                id={stopId}
                checked={bucket.stopFurtherLabels}
                label={`Stop further labels after ${bucket.name}`}
                dataTestId={`file-label-stop-${bucket.id}`}
                onChange={(next) =>
                  onChange({ ...bucket, stopFurtherLabels: next })
                }
              />
            }
          />
          <DndContext
            sensors={matcherSensors}
            collisionDetection={closestCenter}
            onDragEnd={handleMatcherDragEnd}
          >
            <SortableContext
              items={matcherIds}
              strategy={verticalListSortingStrategy}
            >
              {bucket.matchers.map((matcher) => (
                <MatcherRow
                  key={matcher.id}
                  matcher={matcher}
                  onDraftChange={handleMatcherDraftChange}
                  onChange={handleMatcherChange}
                  onDelete={() => handleMatcherDelete(matcher.id)}
                />
              ))}
            </SortableContext>
          </DndContext>
          <AddMatcherInput bucketId={bucket.id} onAdd={handleAddMatcher} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main section
// ---------------------------------------------------------------------------

/**
 * The Files page's Labels section: the ordered file-label buckets, one per
 * row of the section's group, behind the section's disclosure. Follows the
 * `BranchDisplayMappings` editing model: local mirror state, valid changes
 * saved through `onSave`, text drafts committed on blur, dnd-kit vertical
 * reordering, built-in rows toggle/reorder-only, custom rows fully editable.
 */
export function FileLabelsSection({
  labels,
  saveStatus,
  onSave,
  expandRequest = 0,
}: FileLabelsSectionProps): JSX.Element {
  const { expanded, toggle } = useSectionDisclosure(expandRequest);
  const changedFilesTitle = useEarlyAccessTitle('Changed Files');
  const [localLabels, setLocalLabels] = useState<FileLabelBucket[]>(labels);
  const lastSavedLabelsRef = useRef<FileLabelBucket[]>(labels);

  useEffect(() => {
    lastSavedLabelsRef.current = labels;
  }, [labels]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const ids = useMemo(() => localLabels.map((b) => b.id), [localLabels]);

  const update = useCallback(
    (next: FileLabelBucket[]): void => {
      setLocalLabels(next);
      const savedById = new Map(
        lastSavedLabelsRef.current.map((bucket) => [bucket.id, bucket]),
      );
      const persistable = next.map((bucket) => {
        const savedBucket = savedById.get(bucket.id);
        const name =
          bucket.name.trim().length > 0
            ? bucket.name
            : (savedBucket?.name ?? bucket.name);
        const savedMatchersById = new Map(
          savedBucket?.matchers.map((matcher) => [matcher.id, matcher]) ?? [],
        );
        const matchers = bucket.matchers.map((matcher) => {
          if (matcher.builtin || isValidFileLabelPattern(matcher.pattern)) {
            return matcher;
          }
          const savedMatcher = savedMatchersById.get(matcher.id);
          return savedMatcher
            ? { ...matcher, pattern: savedMatcher.pattern }
            : matcher;
        });
        return { ...bucket, name, matchers };
      });
      const valid = persistable.every(
        (bucket) =>
          bucket.name.trim().length > 0 &&
          bucket.matchers.every(
            (matcher) =>
              matcher.builtin || isValidFileLabelPattern(matcher.pattern),
          ),
      );
      if (valid) {
        lastSavedLabelsRef.current = persistable;
        onSave(persistable);
      }
    },
    [onSave],
  );

  const handleDraftChange = useCallback((updated: FileLabelBucket): void => {
    setLocalLabels((current) =>
      current.map((bucket) => (bucket.id === updated.id ? updated : bucket)),
    );
  }, []);

  const handleChange = useCallback(
    (updated: FileLabelBucket): void => {
      update(localLabels.map((b) => (b.id === updated.id ? updated : b)));
    },
    [localLabels, update],
  );

  const handleDelete = useCallback(
    (id: string): void => {
      update(localLabels.filter((b) => b.id !== id));
    },
    [localLabels, update],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent): void => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = localLabels.findIndex((b) => b.id === String(active.id));
      const newIndex = localLabels.findIndex((b) => b.id === String(over.id));
      if (oldIndex < 0 || newIndex < 0) return;
      update(arrayMove(localLabels, oldIndex, newIndex));
    },
    [localLabels, update],
  );

  const handleAdd = useCallback((): void => {
    const bucket: FileLabelBucket = {
      id: generateId('label'),
      name: 'New label',
      enabled: true,
      stopFurtherLabels: false,
      builtin: false,
      matchers: [],
    };
    update([...localLabels, bucket]);
  }, [localLabels, update]);

  // The summary counts what is saved, so it matches the rest of the app.
  const enabledLabels = labels.filter((b) => b.enabled).length;

  return (
    <SettingsSection
      title="Changed files"
      dataTestId="settings-files-labels-section"
    >
      <DesktopErrorBanner
        errorSource="settings-files-labels-error"
        className=""
        error={
          expanded && saveStatus === 'error'
            ? 'Couldn’t save label settings.'
            : null
        }
        testId="settings-files-labels-error"
      />
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <SettingsGroup>
            <SettingsRow
              label="Labels"
              description={`Labels such as Tests and Documentation filter the ${changedFilesTitle} card and Review Changes view. They match in order, and a file can get several.`}
              control={
                <>
                  {expanded && (
                    <Button
                      size="compact"
                      variant="secondary"
                      onClick={handleAdd}
                      data-testid="file-labels-add-label"
                    >
                      <PlusIcon size="sm" />
                      Add label
                    </Button>
                  )}
                  <DisclosureButton
                    open={expanded}
                    onToggle={toggle}
                    closedLabel={`${enabledLabels}/${labels.length} labels enabled`}
                    openLabel="Hide labels"
                    dataTestId="settings-files-labels-section-toggle"
                  />
                </>
              }
            />
            {expanded &&
              localLabels.map((bucket) => (
                <BucketRow
                  key={bucket.id}
                  bucket={bucket}
                  onDraftChange={handleDraftChange}
                  onChange={handleChange}
                  onDelete={() => handleDelete(bucket.id)}
                />
              ))}
          </SettingsGroup>
        </SortableContext>
      </DndContext>
    </SettingsSection>
  );
}
