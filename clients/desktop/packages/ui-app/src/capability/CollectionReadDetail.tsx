'use client';

import {
  ListRow,
  UnresolvedCollectionMember,
} from '@canopy/ui-shared/components';
import { type JSX, type ReactNode } from 'react';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import type {
  CollectionMcpRef,
  CollectionPluginRef,
  CollectionSkillRef,
} from '@canopy/protocol';
import {
  DescriptionMarkdown,
  hasMarkdownDescriptionText,
} from '@canopy/ui-shared';
import {
  CapabilityDetailLayout,
  PluginDetailSectionHeading,
  Stack,
  Button,
  DetailPageActions,
  ExecutionActionButton,
  Heading,
} from '@canopy/ui-shared/components';
import { Surface } from '@canopy/ui-shared/components';

export type CollectionReadMemberRef =
  | ({ kind: 'skill' } & CollectionSkillRef)
  | ({ kind: 'plugin' } & CollectionPluginRef)
  | ({ kind: 'mcp' } & CollectionMcpRef);

export interface CollectionReadViewModel {
  name: string;
  description: string;
  memberRefs: CollectionReadMemberRef[];
}

export interface CollectionReadResolvedMember {
  ref: CollectionReadMemberRef;
  entryKey: string;
  name: string;
  description: string;
  source: string;
}

export interface CollectionReadDetailProps {
  statusSection?: ReactNode;
  collection: CollectionReadViewModel;
  resolvedMembers: CollectionReadResolvedMember[];
  onOpenEntry?: (member: CollectionReadResolvedMember) => void;
  onEdit?: () => void;
  onImport?: () => void;
  onAdd?: () => void;
  /**
   * Per member kind: true when that host catalog list was truncated in
   * transfer, so an unmatched reference of that kind may exist beyond the
   * transferred prefix. Its unresolved state then explains it could not be
   * verified instead of claiming absence.
   */
  catalogTruncated?: { skill?: boolean; plugin?: boolean; mcp?: boolean };
  /**
   * New Customize: the shared detail layout, with the tile's logo and
   * publisher. The header then shows the name and description, so the
   * repeated Name and Description boxes go away.
   */
  layout?: {
    logo?: ReactNode;
    publisher?: ReactNode;
    /** The page's own failure, said under the facts, not in a banner. */
    notice?: ReactNode;
  };
}

export function collectionMemberRefKey(ref: CollectionReadMemberRef): string {
  if (ref.kind === 'skill') return `skill:${ref.sourceId}/${ref.skillName}`;
  if (ref.kind === 'plugin') {
    return `plugin:${ref.marketplaceId}/${ref.pluginName}`;
  }
  return `mcp:${ref.serverId}/${ref.configId}`;
}

function unresolvedLabel(ref: CollectionReadMemberRef): string {
  if (ref.kind === 'skill') return `Missing skill: ${ref.skillName}`;
  if (ref.kind === 'plugin') return `Missing plugin: ${ref.pluginName}`;
  return `Missing MCP server: ${ref.serverId}`;
}

const GROUPS = [
  { kind: 'skill' as const, label: 'Skills' },
  { kind: 'plugin' as const, label: 'Plugins' },
  { kind: 'mcp' as const, label: 'MCP servers' },
];

export function CollectionReadDetail({
  collection,
  catalogTruncated,
  resolvedMembers,
  onOpenEntry,
  onEdit,
  onImport,
  onAdd,
  statusSection,
  layout,
}: CollectionReadDetailProps): JSX.Element {
  const resolvedByRef = new Map(
    resolvedMembers.map((member) => [
      collectionMemberRefKey(member.ref),
      member,
    ]),
  );

  // Page actions join the detail's action bar at the top right:
  // [Import] [Edit] [Share] [Add].
  const actions = (
    <DetailPageActions
      secondary={
        onImport || onEdit ? (
          <>
            {onImport && (
              <Button
                type="button"
                size="compact"
                onClick={onImport}
                data-testid="collection-read-action-import"
              >
                Import
              </Button>
            )}
            {onEdit && (
              <Button
                type="button"
                size="compact"
                onClick={onEdit}
                data-testid="collection-read-action-edit"
              >
                Edit
              </Button>
            )}
          </>
        ) : undefined
      }
      primary={
        onAdd ? (
          <ExecutionActionButton
            label="Add"
            ariaLabel="Add"
            variant="primary"
            placement="detail"
            onClick={onAdd}
            dataTestId="collection-read-action-add"
            stopKeyDownPropagation={false}
          />
        ) : undefined
      }
    />
  );
  const members = (
    <>
      {GROUPS.map(({ kind, label }) => {
        const refs = collection.memberRefs.filter((ref) => ref.kind === kind);
        if (refs.length === 0) return null;
        return (
          <Stack
            as="section"
            gap="inline"
            key={kind}
            data-testid={`collection-read-group-${kind}`}
          >
            <Heading level={2} variant="label">
              {label} ({refs.length})
            </Heading>
            <Surface variant="outline" className="overflow-hidden">
              <div className="divide-y">
                {refs.map((ref) => {
                  const refKey = collectionMemberRefKey(ref);
                  const member = resolvedByRef.get(refKey);
                  if (!member) {
                    return (
                      <UnresolvedCollectionMember
                        key={refKey}
                        data-testid="collection-read-unresolved"
                      >
                        <p className="text-s font-medium fg-primary">
                          {unresolvedLabel(ref)}
                        </p>
                        <p className="text-xs fg-secondary">
                          {catalogTruncated?.[ref.kind] === true
                            ? 'Couldn\u2019t verify this member \u2014 the catalog list was truncated in transfer.'
                            : 'This collection member is not available in the current catalog.'}
                        </p>
                      </UnresolvedCollectionMember>
                    );
                  }
                  const name = (
                    <span className="font-medium fg-primary">
                      {member.name}
                    </span>
                  );
                  const description = member.description || member.source;
                  return onOpenEntry ? (
                    <ListRow
                      key={refKey}
                      size="lg"
                      description={description}
                      trailing={
                        <span className="fg-secondary">{member.source}</span>
                      }
                      data-testid="collection-read-member"
                      data-entry-key={member.entryKey}
                      onClick={() => onOpenEntry(member)}
                    >
                      {name}
                    </ListRow>
                  ) : (
                    <Surface
                      key={refKey}
                      data-testid="collection-read-member"
                      data-entry-key={member.entryKey}
                      variant="pane"
                      gap="item"
                      direction="row"
                      padding="section-compact"
                      className="items-center"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-s">{name}</span>
                        <span className="block truncate text-xs fg-secondary">
                          {description}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs fg-secondary">
                        {member.source}
                      </span>
                    </Surface>
                  );
                })}
              </div>
            </Surface>
          </Stack>
        );
      })}
    </>
  );
  if (layout) {
    return (
      <div className="flex flex-col gap-4" data-testid="collection-read-detail">
        {actions}
        <CapabilityDetailLayout
          dataTestId="collection-detail"
          logo={layout.logo}
          // A user-authored name and description: session replay masks the
          // title and keeps a placeholder for the description.
          title={<span className={REPLAY_MASK_CLASS}>{collection.name}</span>}
          titleId="plugin-detail-title"
          publisher={layout.publisher}
          description={collection.description || undefined}
          descriptionReplay="block"
          facts={{ status: statusSection }}
          factsFooter={layout.notice}
          contents={
            <section className="flex flex-col gap-4">
              <PluginDetailSectionHeading>Members</PluginDetailSectionHeading>
              {collection.memberRefs.length > 0 ? (
                members
              ) : (
                <p className="text-s fg-secondary">No members yet.</p>
              )}
            </section>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="collection-read-detail">
      {statusSection}
      {actions}

      <div className="flex flex-col gap-1.5">
        <p className="text-s fg-secondary">Name</p>
        <Surface variant="group">
          <p className="px-3 py-2 text-s fg-primary">{collection.name}</p>
        </Surface>
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="text-s fg-secondary">Description</p>
        <Surface variant="group">
          <div className="px-3 py-2 text-s fg-primary">
            {hasMarkdownDescriptionText(collection.description) ? (
              <DescriptionMarkdown
                tone="primary"
                dataTestId="share-description"
              >
                {collection.description}
              </DescriptionMarkdown>
            ) : (
              <span className="fg-secondary italic">No description.</span>
            )}
          </div>
        </Surface>
      </div>

      {members}
    </div>
  );
}
