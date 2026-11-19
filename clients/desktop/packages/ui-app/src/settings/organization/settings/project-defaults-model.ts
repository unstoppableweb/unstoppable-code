import { capabilitySetupItemName } from '../../../capability/project-setup/project-setup-model';
import {
  capabilitySetupItemKey,
  type CapabilitySetupItem,
  type CapabilitySetupItemRef,
} from '@canopy/protocol/canopy-core';

/**
 * The kinds the Project defaults page lists (CAN-6237). Agents (phase 10a)
 * and pipelines (phase 10b) are listed only while organization projects are
 * on; otherwise the page keeps any of theirs in the stored defaults
 * untouched.
 */
export type ProjectDefaultKind = 'skill' | 'plugin' | 'agent' | 'pipeline';

export interface ProjectDefaultRef {
  readonly kind: ProjectDefaultKind;
  readonly id: string;
}

/** One row of the page: an organization item and whether it is a default. */
export interface ProjectDefaultRow {
  readonly key: string;
  readonly ref: ProjectDefaultRef;
  readonly name: string;
  readonly description: string | null;
  /** False for a default whose item was deleted or is no longer shared. */
  readonly available: boolean;
  readonly isDefault: boolean;
}

/** What the page holds from a read or a save. */
export interface ProjectDefaultsState {
  readonly revision: number;
  /** The stored defaults, every kind, in their order. */
  readonly items: readonly CapabilitySetupItem[];
  /** The organization's own items an owner or admin can mark. */
  readonly candidates: readonly CapabilitySetupItem[];
  readonly canEdit: boolean;
}

function listedRef(
  ref: CapabilitySetupItemRef,
  kind: ProjectDefaultKind,
): ProjectDefaultRef | null {
  return ref.kind === kind ? { kind, id: ref.id } : null;
}

/**
 * The rows of one kind: the organization's items in the read's order, then
 * any default the candidates no longer list (deleted or no longer shared),
 * so an admin can still turn it off.
 */
export function projectDefaultRows(
  state: ProjectDefaultsState,
  kind: ProjectDefaultKind,
): ProjectDefaultRow[] {
  const defaults = new Set(
    state.items.map((item) => capabilitySetupItemKey(item.ref)),
  );
  const rows: ProjectDefaultRow[] = [];
  const listed = new Set<string>();
  const add = (item: CapabilitySetupItem, isDefault: boolean): void => {
    const ref = listedRef(item.ref, kind);
    if (ref === null) return;
    const key = capabilitySetupItemKey(item.ref);
    if (listed.has(key)) return;
    listed.add(key);
    rows.push({
      key,
      ref,
      name: capabilitySetupItemName(item),
      description: item.description,
      available: item.available,
      isDefault,
    });
  };
  for (const item of state.candidates)
    add(item, defaults.has(capabilitySetupItemKey(item.ref)));
  for (const item of state.items) add(item, true);
  return rows;
}

/**
 * Lowercases `text` for search, folding the Greek final sigma (ς) into σ:
 * lowercasing gives a word-final Σ the final form, so `Σ` would otherwise
 * miss a name such as `ΕΛΕΓΧΟΣ`.
 */
function searchFold(text: string): string {
  return text.toLocaleLowerCase().replace(/ς/gu, 'σ');
}

/**
 * The page's search rule: a case-insensitive substring of a row's name or
 * description. A blank query matches every row.
 */
export function matchesProjectDefaultSearch(
  row: ProjectDefaultRow,
  query: string,
): boolean {
  const needle = searchFold(query.trim());
  if (needle === '') return true;
  return [row.name, row.description].some(
    (text): boolean => text !== null && searchFold(text).includes(needle),
  );
}

/**
 * The defaults to save after switching `ref` on or off: every stored ref
 * that is still available kept in order (other kinds included), `ref`
 * appended or removed. A stored default whose item is gone, or no longer the
 * organization's, is left out: the service refuses to store one, so
 * resending it would block every save.
 */
export function projectDefaultsWith(
  items: readonly CapabilitySetupItem[],
  ref: ProjectDefaultRef,
  on: boolean,
): CapabilitySetupItemRef[] {
  const key = capabilitySetupItemKey(ref);
  const kept = items
    .filter((item) => item.available)
    .map((item) => item.ref)
    .filter((stored) => capabilitySetupItemKey(stored) !== key);
  return on ? [...kept, ref] : kept;
}
