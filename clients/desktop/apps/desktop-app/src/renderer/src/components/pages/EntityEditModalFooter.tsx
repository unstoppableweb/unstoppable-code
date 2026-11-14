import { Button, Surface } from '@canopy/ui-shared/components';
import type { JSX, ReactNode } from 'react';
import { ErrorBanner } from '../shared/StatusBlocks';
import {
  CenteredLoadingSpinner,
  DelayedLoadingPlaceholder,
} from '@canopy/ui-shared/components';

export interface EntityEditModalFooterProps {
  isCreate: boolean;
  saving: boolean;
  canSave: boolean;
  confirmDelete: boolean;
  onConfirmDeleteStart: () => void;
  onConfirmDeleteCancel: () => void;
  onDelete: () => void;
  onClose: () => void;
  onSave: () => void;
  /** Replaces **Save**, **Saving…** and **Cancel** on a task-specific form. */
  saveLabel?: string;
  savingLabel?: string;
  cancelLabel?: string;
  /** Visible action scope, outside the scrollable form and its disclosures. */
  notice?: ReactNode;
}

interface EntityEditModalContentProps {
  loading: boolean;
  error: string;
  bodyClassName?: string;
  footerProps: EntityEditModalFooterProps;
  children: ReactNode;
}

export function EntityEditModalContent({
  loading,
  error,
  bodyClassName = 'flex flex-1 min-h-0 flex-col gap-4 px-6 pb-6',
  footerProps,
  children,
}: EntityEditModalContentProps): JSX.Element {
  return (
    <>
      <div className={bodyClassName}>
        {loading && (
          <DelayedLoadingPlaceholder className="">
            <div className="box-content flex min-h-full flex-1 py-12">
              <CenteredLoadingSpinner className="" />
            </div>
          </DelayedLoadingPlaceholder>
        )}

        {!loading && children}

        <ErrorBanner errorSource="entity-edit-modal" error={error} />
      </div>

      {!loading && <EntityEditModalFooter {...footerProps} />}
    </>
  );
}

export function EntityEditModalFooter({
  isCreate,
  saving,
  canSave,
  confirmDelete,
  onConfirmDeleteStart,
  onConfirmDeleteCancel,
  onDelete,
  onClose,
  onSave,
  saveLabel = 'Save',
  savingLabel = 'Saving\u2026',
  cancelLabel = 'Cancel',
  notice,
}: EntityEditModalFooterProps): JSX.Element {
  return (
    <Surface variant="section" boundary="top">
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-3">
        <div>
          {notice}
          {!isCreate && !confirmDelete && (
            <Button
              variant="ghost-destructive"
              size="compact"
              onClick={onConfirmDeleteStart}
              disabled={saving}
            >
              Delete
            </Button>
          )}
          {!isCreate && confirmDelete && (
            <span className="inline-flex items-center gap-2">
              <span className="text-xs fg-secondary">Are you sure?</span>
              <Button
                variant="destructive"
                size="compact"
                onClick={onDelete}
                disabled={saving}
              >
                Confirm
              </Button>
              <Button size="compact" onClick={onConfirmDeleteCancel}>
                Cancel
              </Button>
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button size="compact" onClick={onClose}>
            {cancelLabel}
          </Button>
          <Button
            variant="primary"
            size="compact"
            onClick={onSave}
            disabled={!canSave}
          >
            {saving ? savingLabel : saveLabel}
          </Button>
        </div>
      </div>
    </Surface>
  );
}
