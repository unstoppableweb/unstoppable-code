import type { Dispatch, SetStateAction } from 'react';
import type { EntityEditModalFooterProps } from './EntityEditModalFooter';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface CancellableLoadOptions {
  isCancelled: () => boolean;
  setError: Dispatch<SetStateAction<string>>;
  setLoading: Dispatch<SetStateAction<boolean>>;
}

export async function runCancellableModalLoad(
  load: () => Promise<void>,
  options: CancellableLoadOptions,
): Promise<void> {
  try {
    await load();
  } catch (error) {
    if (options.isCancelled()) return;
    options.setError(getErrorMessage(error));
  } finally {
    if (!options.isCancelled()) options.setLoading(false);
  }
}

interface EntityEditOperationOptions {
  setSaving: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string>>;
  onSaved: () => Promise<void>;
  onClose: () => void;
}

export async function runEntityEditOperation(
  operation: () => Promise<void>,
  options: EntityEditOperationOptions,
): Promise<void> {
  options.setSaving(true);
  options.setError('');
  try {
    await operation();
    await options.onSaved();
    options.onClose();
  } catch (error) {
    options.setError(getErrorMessage(error));
  } finally {
    options.setSaving(false);
  }
}

export function createEntityEditModalFooterProps(
  isCreate: boolean,
  saving: boolean,
  canSave: boolean,
  confirmDelete: boolean,
  setConfirmDelete: Dispatch<SetStateAction<boolean>>,
  onDelete: () => void,
  onClose: () => void,
  onSave: () => void,
): EntityEditModalFooterProps {
  return {
    isCreate,
    saving,
    canSave,
    confirmDelete,
    onConfirmDeleteStart: () => setConfirmDelete(true),
    onConfirmDeleteCancel: () => setConfirmDelete(false),
    onDelete,
    onClose,
    onSave,
  };
}
