import { Button } from '../../../../primitives/Button';
import type { JSX } from 'react';
import { type SubagentNode, type SubagentTree } from '@canopy/agent-transcript';
import { ChatIcon, ChevronRightIcon } from '../../../../icons/AppIcons';
import { SubagentIcon } from '../../../../icons/SubagentIcon';
import { SubagentStatusGlyph } from '../common/SubagentStatusGlyph';
import {
  SUBAGENT_LINEAGE_ALONGSIDE,
  subagentStatusDetail,
} from '../subagent-copy';
import { REPLAY_MASK_CLASS } from '../../../../lib/replay-privacy';
import { Heading } from '../../../../primitives/Heading';

export type SubagentLineageTarget =
  | { readonly kind: 'root'; readonly id: string; readonly title: string }
  | {
      readonly kind: SubagentNode['kind'];
      readonly id: string;
      readonly title: string;
    };

export interface SubagentLineageDetailsProps {
  readonly tree: SubagentTree;
  readonly node: SubagentNode;
  /** Ancestors ordered from the root chat toward the selected node. */
  readonly ancestors: readonly SubagentNode[];
  readonly onOpenLineage: (target: SubagentLineageTarget) => void;
}

function LineageButton({
  depth,
  node,
  onClick,
}: {
  readonly depth: number;
  readonly node: SubagentNode;
  readonly onClick: () => void;
}): JSX.Element {
  return (
    <li
      className="flex min-w-0 items-center gap-1.5 text-xs"
      style={{ paddingInlineStart: depth * 12 }}
    >
      <SubagentStatusGlyph status={node.status} size={10} />
      <Button
        variant="link"
        className="min-w-0"
        onClick={onClick}
        data-testid={`subagent-chat-lineage-${node.id}`}
      >
        <span
          className={`${REPLAY_MASK_CLASS} block truncate`}
          title={node.title}
        >
          {node.title}
        </span>
      </Button>
      <span className="shrink-0 fg-tertiary">{subagentStatusDetail(node)}</span>
    </li>
  );
}

/** Root-down lineage, this task, its children and its siblings. */
export function SubagentLineageDetails({
  tree,
  node,
  ancestors,
  onOpenLineage,
}: SubagentLineageDetailsProps): JSX.Element {
  const siblings =
    node.parentId === null
      ? tree.rootChildIds
          .filter((id) => id !== node.id)
          .map((id) => tree.nodes.get(id))
          .filter(
            (candidate): candidate is SubagentNode => candidate !== undefined,
          )
      : (tree.nodes
          .get(node.parentId)
          ?.childIds.filter((id) => id !== node.id)
          .map((id) => tree.nodes.get(id))
          .filter(
            (candidate): candidate is SubagentNode => candidate !== undefined,
          ) ?? []);
  const children = node.childIds
    .map((id) => tree.nodes.get(id))
    .filter((candidate): candidate is SubagentNode => candidate !== undefined);

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <ol className="flex min-w-0 flex-col gap-1">
        <li
          className="flex min-w-0 items-center gap-1.5 text-xs"
          style={{ paddingInlineStart: 0 }}
        >
          <ChatIcon size={12} aria-hidden />
          <Button
            variant="link"
            className="min-w-0"
            onClick={(): void =>
              onOpenLineage({
                kind: 'root',
                id: tree.root.id,
                title: tree.root.title,
              })
            }
            data-testid={`subagent-chat-lineage-${tree.root.id}`}
          >
            <span
              className={`${REPLAY_MASK_CLASS} block truncate`}
              title={tree.root.title}
            >
              {tree.root.title}
            </span>
          </Button>
        </li>
        {ancestors.map((ancestor, index) => (
          <LineageButton
            key={ancestor.id}
            depth={index + 1}
            node={ancestor}
            onClick={(): void =>
              onOpenLineage({
                kind: ancestor.kind,
                id: ancestor.id,
                title: ancestor.title,
              })
            }
          />
        ))}
        <li
          className="flex min-w-0 items-center gap-1.5 text-xs"
          style={{ paddingInlineStart: (ancestors.length + 1) * 12 }}
        >
          <SubagentIcon size={12} className="fg-accent" />
          <span
            className={`${REPLAY_MASK_CLASS} min-w-0 truncate font-medium fg-primary`}
            title={node.title}
          >
            {node.title}
          </span>
          <ChevronRightIcon
            size="sm"
            aria-hidden
            className="shrink-0 fg-quaternary"
          />
        </li>
        {children.map((child) => (
          <LineageButton
            key={child.id}
            depth={ancestors.length + 2}
            node={child}
            onClick={(): void =>
              onOpenLineage({
                kind: child.kind,
                id: child.id,
                title: child.title,
              })
            }
          />
        ))}
      </ol>
      {siblings.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-1">
          <Heading level={4} variant="label">
            {SUBAGENT_LINEAGE_ALONGSIDE}
          </Heading>
          <ul
            className="flex min-w-0 list-none flex-col gap-1 p-0"
            data-testid="subagent-chat-lineage-alongside"
          >
            {siblings.map((sibling) => (
              <LineageButton
                key={sibling.id}
                depth={0}
                node={sibling}
                onClick={(): void =>
                  onOpenLineage({
                    kind: sibling.kind,
                    id: sibling.id,
                    title: sibling.title,
                  })
                }
              />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
