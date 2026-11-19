import type {
  PluginHarnessConnectionRow,
  PluginHarnessViaCopy,
  PluginMcpServerVia,
} from '@canopy/ui-shared/components';
import {
  customizeHarnessRows,
  type CustomizeHarnessSupport,
  type UnifiedEntryAlternative,
} from '@canopy/ui-shared/lib';

/** A Works with table row in New Customize, with where its support comes from. */
export type CustomizeHarnessTableRow = PluginHarnessConnectionRow & {
  readonly support: CustomizeHarnessSupport;
  readonly note?: string;
  readonly via?: PluginHarnessViaCopy;
  readonly alternative?: { label: string; onOpen: () => void };
};

/**
 * New Customize's Works with table (Sergii's QA): the same
 * `customizeHarnessRows` a tile's chips read, so the table and the chips
 * always agree. A harness another copy serves names that copy, linked.
 */
export function customizeHarnessTableRows(
  own: readonly (PluginHarnessConnectionRow & { readonly note?: string })[],
  alternatives: readonly UnifiedEntryAlternative[] | undefined,
  onOpenEntryId?: (entryId: string) => void,
  /**
   * Installs the copies an installed item is missing, for a harness a copy
   * would serve: the same one Add for every harness, run again.
   */
  onAddCopies?: () => void,
): {
  readonly rows: CustomizeHarnessTableRow[];
  /** Harnesses whose MCP server is another copy's. */
  readonly mcpServerVia: PluginMcpServerVia[];
  /** The copies the rows name, so Other versions doesn't repeat them. */
  readonly usedCopies: ReadonlySet<string>;
} {
  const usedCopies = new Set<string>();
  const mcpServerVia: PluginMcpServerVia[] = [];
  const rows = customizeHarnessRows(own, alternatives).map(
    (row): CustomizeHarnessTableRow => {
      const base = {
        id: row.id,
        name: row.name,
        installation: row.installation,
        support: row.support,
        ...(row.note !== undefined ? { note: row.note } : {}),
      };
      if (row.copy === undefined) return base;
      const { entryId } = row.copy;
      // Not installed yet: say what Add brings, and offer it here so the
      // item needs no second Add. Only a copy the item's Add brings along is
      // promised; any other stays under Other versions.
      if (row.installation !== 'Installed') {
        const addable = alternatives?.some(
          (copy) => copy.entryId === entryId && copy.addedWithItem === true,
        );
        if (addable !== true) return base;
        usedCopies.add(entryId);
        return {
          ...base,
          note: `Adds ${row.copy.base.name} for ${row.name}`,
          ...(onAddCopies
            ? { alternative: { label: 'Add', onOpen: onAddCopies } }
            : {}),
        };
      }
      usedCopies.add(entryId);
      const via: PluginHarnessViaCopy = {
        name: row.copy.name,
        ...(row.copy.source !== undefined ? { source: row.copy.source } : {}),
        ...(onOpenEntryId
          ? { onOpen: (): void => onOpenEntryId(entryId) }
          : {}),
      };
      if (
        alternatives?.some(
          (copy) => copy.entryId === entryId && copy.hasMcpServers === true,
        )
      )
        mcpServerVia.push({
          harness: row.id,
          via,
          installed: row.installation === 'Installed',
        });
      return { ...base, via };
    },
  );
  return { rows, mcpServerVia, usedCopies };
}
