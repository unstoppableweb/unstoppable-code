import { ControlButton } from '../primitives/Button';
import {
  useMemo,
  useState,
  type ComponentProps,
  type JSX,
  type ReactNode,
} from 'react';
import { FolderIcon } from '../icons';
import { CloseIcon as AppCatalogCloseIcon } from '../icons/AppIcons';
import {
  buildSkillFileTree,
  SKILL_MAIN_FILE,
  skillFileLabel,
  type SkillFileTreeDirectory,
} from '../lib/skill-files';
import { useHorizontalOverflowScroll } from '../lib/useHorizontalOverflowScroll';
import { DocumentProse } from './DocumentProse';
import { FileTreeRow } from './FileTreeRow';
import { Markdown } from './Markdown';
import { OverlayScrollArea } from '../primitives/OverlayScrollArea';
import { HoverCard } from '../primitives/HoverCard';
import { Tooltip } from '../primitives/Tooltip';

export function SkillMarkdownBody({
  markdown,
  options,
}: {
  markdown: string;
  /** Rendering overrides, such as headings demoted under a page title. */
  options?: ComponentProps<typeof Markdown>['options'];
}): JSX.Element {
  return (
    <DocumentProse variant="archive">
      <Markdown options={options}>{markdown}</Markdown>
    </DocumentProse>
  );
}

export interface FileTabProps {
  label: string;
  title: string;
  active: boolean;
  onSelect: () => void;
  onClose?: () => void;
  dataTestId: string;
  dataPath?: string;
}

export function FileTab({
  label,
  title,
  active,
  onSelect,
  onClose,
  dataTestId,
  dataPath,
}: FileTabProps): JSX.Element {
  return (
    <div
      data-testid={dataTestId}
      data-path={dataPath}
      data-active={active ? 'true' : undefined}
      className={`group inline-flex shrink-0 items-center rounded-md border text-xs transition-colors ${onClose ? 'pr-1' : ''} ${active ? 'bg-secondary fg-primary' : 'border-transparent fg-secondary hover:fg-primary hover:bg-muted'}`}
    >
      <HoverCard
        content={title}
        surfaceClassName="w-max max-w-72"
        surfacePadding="compact"
      >
        <ControlButton
          type="button"
          onClick={onSelect}
          aria-current={active ? 'true' : undefined}
          presentation="skill-file-tab"
          appearance={{ closable: !!onClose }}
        >
          {label}
        </ControlButton>
      </HoverCard>
      {onClose && (
        <ControlButton
          type="button"
          onClick={onClose}
          aria-label={`Close ${label}`}
          presentation="skill-file-close"
        >
          <AppCatalogCloseIcon size="sm" />
        </ControlButton>
      )}
    </div>
  );
}

export interface SkillFileTabDescriptor {
  key: string;
  label: string;
  title: string;
}
export interface SkillFileTabBarProps {
  tabs: SkillFileTabDescriptor[];
  activeKey: string | null;
  onSelectMain: () => void;
  onSelectTab: (key: string) => void;
  onCloseTab: (key: string) => void;
  treeToggle?: {
    open: boolean;
    onToggle: () => void;
    presentation?: 'toolbar' | 'detail';
  };
  trailing?: ReactNode;
}

export function SkillFileTabBar({
  tabs,
  activeKey,
  onSelectMain,
  onSelectTab,
  onCloseTab,
  treeToggle,
  trailing,
}: SkillFileTabBarProps): JSX.Element {
  const scroll = useHorizontalOverflowScroll<HTMLDivElement>();
  return (
    <div
      className="flex shrink-0 items-center gap-1 pb-2"
      data-testid="skill-file-tab-bar"
    >
      {treeToggle && (
        <div
          className={treeToggle.presentation !== 'detail' ? 'pr-1' : undefined}
        >
          <Tooltip label={treeToggle.open ? 'Hide files' : 'Show files'}>
            <ControlButton
              type="button"
              onClick={treeToggle.onToggle}
              aria-pressed={treeToggle.open}
              data-testid="skill-file-tree-toggle"
              presentation="skill-file-tree"
              appearance={{
                presentation: treeToggle.presentation ?? 'toolbar',
                open: treeToggle.open,
              }}
            >
              <FolderIcon size="sm" />
            </ControlButton>
          </Tooltip>
        </div>
      )}
      <FileTab
        label={SKILL_MAIN_FILE}
        title={SKILL_MAIN_FILE}
        active={activeKey === null}
        onSelect={onSelectMain}
        dataTestId="skill-file-tab-main"
      />
      <div className="canopy-panel-tab-strip-wrap min-w-0">
        <div
          className="canopy-scroll-fade canopy-scroll-fade-start"
          data-visible={scroll.showStartFade}
          aria-hidden="true"
        />
        <div
          className="canopy-scroll-fade canopy-scroll-fade-end"
          data-visible={scroll.showEndFade}
          aria-hidden="true"
        />
        <div
          ref={scroll.thumbRef}
          className="canopy-scroll-thumb"
          data-overflow={scroll.hasOverflow}
          data-revealed={scroll.isScrollbarRevealed}
          aria-hidden="true"
        />
        <div
          ref={scroll.ref}
          className="canopy-hide-scrollbar flex min-w-0 items-center gap-1 overflow-x-auto overflow-y-hidden"
          data-testid="skill-file-tab-scroll"
        >
          {tabs.map((tab) => (
            <FileTab
              key={tab.key}
              label={tab.label}
              title={tab.title}
              active={activeKey === tab.key}
              onSelect={() => onSelectTab(tab.key)}
              onClose={() => onCloseTab(tab.key)}
              dataTestId="skill-file-tab"
              dataPath={tab.title}
            />
          ))}
        </div>
      </div>
      {trailing}
    </div>
  );
}

export interface SkillFileTreeProps {
  files: string[];
  activePath: string | null;
  onSelectFile: (path: string) => void;
  collapsed?: ReadonlySet<string>;
  onToggleDirectory?: (path: string) => void;
}

export function SkillFileTree({
  files,
  activePath,
  onSelectFile,
  collapsed: controlledCollapsed,
  onToggleDirectory,
}: SkillFileTreeProps): JSX.Element {
  const tree = useMemo(() => buildSkillFileTree(files), [files]);
  const [internalCollapsed, setInternalCollapsed] = useState<
    ReadonlySet<string>
  >(new Set());
  const collapsed = controlledCollapsed ?? internalCollapsed;
  const toggleDirectory = (path: string): void => {
    if (onToggleDirectory) return onToggleDirectory(path);
    setInternalCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const renderDirectory = (
    directory: SkillFileTreeDirectory,
    depth: number,
  ): JSX.Element[] => {
    const rows: JSX.Element[] = [];
    for (const child of directory.dirs) {
      const expanded = !collapsed.has(child.path);
      rows.push(
        <FileTreeRow
          key={`dir:${child.path}`}
          label={child.name}
          depth={depth}
          isDirectory
          expanded={expanded}
          onClick={() => toggleDirectory(child.path)}
          dataTestId="skill-file-tree-dir"
          dataPath={child.path}
        />,
      );
      if (expanded) rows.push(...renderDirectory(child, depth + 1));
    }
    for (const path of directory.files) {
      const main = path === SKILL_MAIN_FILE;
      rows.push(
        <FileTreeRow
          key={`file:${path}`}
          label={skillFileLabel(path)}
          depth={depth}
          isDirectory={false}
          selected={main ? activePath === null : activePath === path}
          current={main ? activePath === null : activePath === path}
          onClick={() => onSelectFile(path)}
          dataTestId="skill-file-tree-file"
          dataPath={path}
        />,
      );
    }
    return rows;
  };
  return (
    <OverlayScrollArea
      className="min-h-0"
      contentClassName="py-1"
      viewportProps={{ 'data-testid': 'skill-file-tree' }}
    >
      {renderDirectory(tree, 0)}
    </OverlayScrollArea>
  );
}
