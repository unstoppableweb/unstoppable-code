/**
 * Pure tool-family icon/label dispatch used by the shared chat tool-call
 * rendering primitives. Mirrors the closed `RemoteControlChatToolFamily` union from
 * `@canopy/protocol` element-for-element so the renderer can resolve an icon
 * and a default label from a single family discriminator without parsing
 * free-form provider tool names.
 *
 * The hosts (desktop renderer + web portal) populate `toolFamily` on each
 * `tool_use` chat part deterministically (the desktop chat-transcript
 * projector + the web's `RemoteControlChatPart` projection) so this helper can stay
 * a small lookup table here in `@canopy/ui-shared`.
 */
import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import type { ComponentType, JSX, SVGProps } from 'react';
import {
  AgentIcon,
  AppAdvisorIcon,
  AppAdvisorWatcherIcon,
  ClaudeLogo,
  CommandIcon,
  DocumentIcon,
  DocumentSearchIcon,
  GlobeIcon,
  GraphIcon,
  MagnifyingGlassIcon,
  MonitorIcon,
  PipelineIcon,
  PlanModeIcon,
  QuestionMarkIcon,
  SkillIcon,
  TaskIcon,
  TerminalBorderedIcon,
  TerminalIcon,
  WrenchIcon,
} from '../../icons';
import { DocumentPencilIcon, PickIcon } from '../../icons/AppIcons';

/**
 * Closed enumeration of tool families surfaced on `tool_use` chat parts.
 * Mirrors the wire `RemoteControlChatToolFamily` union element-for-element. Kept
 * local to `@canopy/ui-shared` so this package does not have to depend on
 * `@canopy/protocol`.
 */
export type RemoteControlChatToolFamily =
  | 'read'
  | 'edit'
  | 'write'
  | 'plan'
  | 'bash'
  | 'grep'
  | 'glob'
  | 'todo'
  | 'web'
  | 'agent'
  | 'ask-user'
  | 'script-output'
  | 'skill'
  | 'monitor'
  | 'claude'
  | 'watcher'
  | 'canopy'
  | 'graph'
  | 'app-advisor'
  | 'pipeline-editor'
  | 'computer-use'
  | 'unknown';

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

interface ToolFamilyEntry {
  Icon: IconComponent;
  label: string;
}

const TOOL_FAMILY_REGISTRY: Record<
  RemoteControlChatToolFamily,
  ToolFamilyEntry
> = {
  read: { Icon: DocumentIcon, label: 'Read' },
  edit: { Icon: DocumentPencilIcon, label: 'Edit' },
  write: { Icon: DocumentPencilIcon, label: 'Write' },
  plan: { Icon: PlanModeIcon, label: 'Plan' },
  bash: { Icon: TerminalIcon, label: 'Bash' },
  grep: { Icon: DocumentSearchIcon, label: 'Grep' },
  glob: { Icon: MagnifyingGlassIcon, label: 'Glob' },
  todo: { Icon: TaskIcon, label: 'Todo' },
  web: { Icon: GlobeIcon, label: 'Web' },
  agent: { Icon: AgentIcon, label: 'Agent' },
  'ask-user': { Icon: QuestionMarkIcon, label: 'Ask user' },
  'script-output': { Icon: TerminalBorderedIcon, label: 'Script output' },
  skill: { Icon: SkillIcon, label: 'Skill' },
  monitor: { Icon: MonitorIcon, label: 'Monitor' },
  claude: { Icon: ClaudeLogo, label: 'Claude' },
  watcher: { Icon: AppAdvisorWatcherIcon, label: 'Watcher' },
  canopy: { Icon: WrenchIcon, label: 'App' },
  graph: { Icon: GraphIcon, label: 'Code Graph' },
  'app-advisor': { Icon: AppAdvisorIcon, label: ORCHESTRATOR_LABEL },
  'pipeline-editor': { Icon: PipelineIcon, label: 'Workflow editor' },
  'computer-use': { Icon: PickIcon, label: 'Computer use' },
  unknown: { Icon: WrenchIcon, label: 'Tool' },
};

/**
 * Returns the SVG icon component for a tool family. `unknown`/missing family
 * falls back to the generic wrench icon. The `CommandIcon` import keeps the
 * icon-set reachable so adding a `command`-style family later does not break
 * the closed-union mapping.
 */
export function getToolFamilyIcon(
  family: RemoteControlChatToolFamily | undefined,
): IconComponent {
  if (!family) return WrenchIcon;
  const entry = TOOL_FAMILY_REGISTRY[family];
  return entry ? entry.Icon : WrenchIcon;
}

/**
 * Returns the default human-readable label for a tool family. Hosts can
 * override this on a per-call basis (e.g. "Read foo.ts") by passing their
 * own `toolName` or richer label content through the consuming component.
 */
export function getToolFamilyLabel(
  family: RemoteControlChatToolFamily | undefined,
): string {
  if (!family) return 'Tool';
  const entry = TOOL_FAMILY_REGISTRY[family];
  return entry ? entry.label : 'Tool';
}

/**
 * Convenience helper: returns a ready-to-render JSX `<Icon />` element for a
 * tool family. Used by `CollapsedTurnSummary` to render chip icons inline
 * without each call site importing the icon set itself.
 */
export function renderToolFamilyIcon(
  family: RemoteControlChatToolFamily | undefined,
): JSX.Element {
  const Icon = getToolFamilyIcon(family);
  return <Icon />;
}

// Re-export the `CommandIcon` so consumers that want a "command"-style icon
// for free-form bash labels can pick it up from a single barrel. Not part of
// the tool-family enum (yet) but desktop code does use it for non-bash shell
// invocations.
export { CommandIcon };
