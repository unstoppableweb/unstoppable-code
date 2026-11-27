import { BaseBranchOptions } from './BaseBranchOptions';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { Picker, PickerTrigger, PickerTriggerChevron } from '@canopy/ui-shared';
import type { BranchEntry } from '@canopy/desktop-shared/types';
import {
  collapseBranchDuplicates,
  findBranchPresence,
  preserveBranchOption,
} from './branch-options';

interface BaseBranchDropdownProps {
  projectId: string;
  worktreeId: string;
  repoId?: string;
  currentValue: string | null | undefined;
  disabled?: boolean;
  onChange: (
    branchName: string,
    presence: { existsLocally: boolean; existsInRemote: boolean },
  ) => void;
}

export function BaseBranchDropdown({
  projectId,
  worktreeId,
  repoId,
  currentValue,
  disabled = false,
  onChange,
}: BaseBranchDropdownProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<BranchEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const menuId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  // Load branches when opened
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    window.api
      .listBranches({ projectId, worktreeId, repoId })
      .then((response) => {
        if (!cancelled) {
          setBranches(response.branches);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, [open, projectId, worktreeId, repoId]);

  const collapsed = useMemo(
    () =>
      preserveBranchOption(
        collapseBranchDuplicates(branches),
        currentValue ?? null,
      ),
    [branches, currentValue],
  );

  // Preserve current value even if it doesn't appear in the fetched list
  const displayValue = currentValue ?? 'none';

  const handleSelect = useCallback(
    (branchName: string) => {
      const presence = findBranchPresence(branches, branchName);
      onChange(branchName, {
        existsLocally: presence.hasLocalRef,
        existsInRemote: presence.hasRemoteRef,
      });
      setOpen(false);
      triggerRef.current?.focus();
    },
    [branches, onChange],
  );

  return (
    <>
      <PickerTrigger
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => {
          if (!disabled) setOpen(!open);
        }}
        variant="field"
        mono
        tone="secondary"
        className="w-full justify-between"
        data-testid="base-branch-dropdown-trigger"
        aria-label={`Select base branch, current branch ${displayValue}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
      >
        <span className="truncate">{displayValue}</span>
        <PickerTriggerChevron open={open} />
      </PickerTrigger>

      <Picker
        id={menuId}
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="bottom-left"
        heightLimit={240}
        initialFocusRef={searchRef}
        role="dialog"
        aria-modal="false"
        aria-label="Base branch selector"
        data-testid="base-branch-dropdown-menu"
      >
        <BaseBranchOptions
          branches={collapsed}
          currentValue={currentValue}
          inputRef={searchRef}
          loading={loading}
          onPick={handleSelect}
          onEscape={() => {
            setOpen(false);
            triggerRef.current?.focus();
          }}
        />
      </Picker>
    </>
  );
}
