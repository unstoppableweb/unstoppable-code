import type { CSSProperties, ComponentType, JSX, SVGProps } from 'react';
import type { AppIconBaseProps } from './AppIconBase';
import { DEFAULT_ICON_SIZE, isIconSize, resolveIconSize } from './icon-size';
import {
  IconRedo,
  IconStar,
  IconListFilter,
  IconListStart,
  IconMessageCircleDashed,
  IconArrowUpDown,
  IconSearchX,
  IconFileDown,
  IconMonitorDown,
  IconCircleStop,
  IconCircleDashed,
  IconCirclePause,
  IconCircleX,
  IconCoins,
  IconThumbsUp,
  IconThumbsDown,
  IconSteer,
  IconMention,
  IconSingleSignOn,
  IconAddPhotoAlternate,
  IconAgent,
  IconAgents,
  IconApple,
  IconLinux,
  IconAllModels,
  IconAllModelsFilled,
  IconApps,
  IconArchive,
  IconArchive1,
  IconArrowBoxLeft,
  IconArrowBoxRight,
  IconArrowDownRight,
  IconArrowInbox,
  IconArrowLeft,
  IconArrowLoopDownLeft,
  IconArrowOutOfBox,
  IconArrowRight,
  IconArrowRotateClockwise,
  IconArrowRotateLeftRight,
  IconArrowRotateRightLeft,
  IconArrowSplitRight,
  IconArrowSplitUp,
  IconArrowUp,
  IconArrowUpRight,
  IconAutoAwesome,
  IconAutoplay,
  IconBarsThree,
  IconBarsTwo,
  IconBell,
  IconBell2,
  IconBoard,
  IconBottombarHiddenBottomWide,
  IconBrain1,
  IconBrain2,
  IconLightbulb,
  IconBranch,
  IconBranchSimple,
  IconBriefcase,
  IconBrightness,
  IconBubble2,
  IconBubblePlus,
  IconBubbleText,
  IconBubbles,
  IconBug,
  IconBuild,
  IconBuildingBlocks,
  IconBuildings,
  IconBulletList,
  IconCalendarClock,
  IconCamera1,
  IconCanvasGrid,
  IconChanges,
  IconChart4,
  IconCheckmark1,
  IconChevronDownMedium,
  IconChevronDownSmall,
  IconChevronLeftMedium,
  IconChevronRightMedium,
  IconChevronRightSmall,
  IconChevronTopMedium,
  IconChevronTopSmall,
  IconChipSimple,
  IconCircleCheck,
  IconCircleInfo,
  IconCircleQuestionmark,
  IconCircleXFilled,
  IconClipboard,
  IconClipboard2Sparkle,
  IconClock,
  IconClockSnooze,
  IconClockTimeslot,
  IconCloud,
  IconCodeBrackets,
  IconCodeMedium,
  IconCommits,
  IconConnectors2,
  IconConsole,
  IconConsoleSimple,
  IconCreditCard1,
  IconCrossLarge,
  IconCrossMedium,
  IconCrossSmall,
  IconCursorClick,
  IconDeepseek,
  IconOpenrouter,
  IconVercel,
  IconDevices,
  IconDifference,
  IconDollar,
  IconDotGrid1x3Horizontal,
  IconDotGrid1x3Vertical,
  IconDotGrid2x3,
  IconDraftSimple,
  IconEditBig,
  IconElectrocardiogram,
  IconEmail1,
  IconEmail2Check,
  IconExclamationTriangle,
  IconExpand45,
  IconBroadcast,
  IconEyeOpen,
  IconEyeSlash,
  IconEyeSparkle,
  IconFeed,
  IconFileText,
  IconFiles,
  IconFilter1,
  IconFocusSquare,
  IconFolder1,
  IconFolderAddRight,
  IconFolderData,
  IconFolderFilled,
  IconFolders,
  IconFoldersDashed,
  IconFrontHand,
  IconGit,
  IconGitFork,
  IconGitBranchLine,
  IconForkSplit,
  IconGithub,
  IconGoogle,
  IconGlobe,
  IconGlobe2,
  IconHammer2,
  IconHistory,
  IconImages1,
  IconInputForm,
  IconKanbanView,
  IconKimi,
  IconLab,
  IconLayoutDashboard,
  IconLayoutGrid2FilledSquare,
  IconLayoutWindow,
  IconLetterACircle,
  IconLineChart1,
  IconLink,
  IconLinkOff,
  IconListAdd,
  IconListBullets,
  IconLoader,
  IconLock,
  IconMacbook,
  IconMagnifyingGlass,
  IconMap,
  IconMergeConflictSimple,
  IconMerged,
  IconMergedSimple,
  IconMergeQueue,
  IconMicrophone,
  IconMinimax,
  IconMinimize45,
  IconMinusSmall,
  IconMoon,
  IconNoteText,
  IconOrbit,
  IconPackage,
  IconPageAttachment,
  IconPageSearch,
  IconPageTextAdd,
  IconPause,
  IconPencil,
  IconPeopleIdCard,
  IconPhone,
  IconPhoneDynamicIsland,
  IconPhoneDynamicIslandFilled,
  IconPhoneFilled,
  IconPin,
  IconPinFilled,
  IconPlanning,
  IconPlay,
  IconPlayCircle,
  IconPlusLarge,
  IconPlusMedium,
  IconPlusSmall,
  IconPullRequest,
  IconPullRequestClosedSimple,
  IconPullRequestSimple,
  IconPuzzle,
  IconRecord,
  IconReplay,
  IconRequestClosed,
  IconReviewFilled,
  IconRobot,
  IconRobot2,
  IconRocket,
  IconRunShortcut,
  IconServer,
  IconServer2,
  IconSettingsGear2,
  IconSettingsSliderHor,
  IconShareAndroid,
  IconShield,
  IconShieldAccess,
  IconShieldAi,
  IconShieldCheck,
  IconShieldCheck3,
  IconShimmer,
  IconShortcut,
  IconSidebar,
  IconSidebarHiddenLeftWide,
  IconSidebarHiddenRightWide,
  IconSparkle,
  IconSplit,
  IconSquareArrowTopRight,
  IconSquareBehindSquare1,
  IconSquareChecklist,
  IconSquarePlus,
  IconStackedBarChart,
  IconStop,
  IconStopFilled,
  IconStopwatch,
  IconStore1,
  IconSummary,
  IconSun,
  IconTag,
  IconTarget,
  IconTextIndentLeft,
  IconTextIndentRight,
  IconTrashCan,
  IconTrashPermanently,
  IconUnarchive,
  IconUnfoldMore,
  IconUser,
  IconUserAdd,
  IconUserGroup,
  IconVibeCoding,
  IconWarningSign,
  IconWatching,
  IconWebhooks,
  IconWorkflows,
  IconDiscord,
  IconReddit,
  IconXSocial,
  IconZai,
  IconZap,
  IconZapFilled,
} from './AppGlyphs.generated';
import { AntigravityLogo } from './AntigravityLogo';
import { ClaudeLogo } from './ClaudeLogo';
import { CodexLogo } from './CodexLogo';
import { CursorLogo } from './CursorLogo';
import { LinearLogo } from './LinearLogo';
import { LinkedInLogo } from './LinkedInLogo';
import { OllamaLogo } from './OllamaLogo';

// The shared SVG root for app-local glyphs (Canopy-authored and banner art).
export { AppIconBase, type AppIconBaseProps } from './AppIconBase';

export { DEFAULT_ICON_SIZE, ICON_SIZE_PX, type IconSize } from './icon-size';

export type AppIconProps = Omit<SVGProps<SVGSVGElement>, 'strokeWidth'> & {
  active?: boolean;
  ariaHidden?: boolean;
  /**
   * A step of the icon scale, an `IconSize` (`xs` 12, `sm` 14, `md` 16,
   * `lg` 18, `xl` 20, `2xl` 24; docs/design/icons.md#sizes). Defaults to
   * `sm`. Numbers and CSS lengths are legacy and locked by
   * `canopy-icons/no-raw-icon-size`.
   */
  size?: number | string;
  title?: string;
  /** See `AppIconBaseProps.exactSize`. */
  exactSize?: boolean;
  /** See `AppIconBaseProps.drawnStrokeWidth`. */
  drawnStrokeWidth?: number;
};

type AppGlyph = ComponentType<AppIconBaseProps>;
export type AppIcon = (props: AppIconProps) => JSX.Element;

/**
 * A step resolves to its pixels and exact-size flag. With no size, width or
 * height (`unsizedDefault` set), the icon's default decides the flag; a
 * caller's own `exactSize` always wins.
 */
function resolveRequestedSize(
  requestedSize: number | string | undefined,
  requestedExactSize: boolean | undefined,
  unsizedDefault: { exactSize: boolean } | null,
): { size: number | string | undefined; exactSize: boolean | undefined } {
  const named = isIconSize(requestedSize)
    ? resolveIconSize(requestedSize)
    : null;
  const flagSource =
    named ?? (requestedSize === undefined ? unsizedDefault : null);
  return {
    size: named ? named.px : requestedSize,
    exactSize: requestedExactSize ?? (flagSource?.exactSize || undefined),
  };
}

/**
 * Keeps the app's existing SVG sizing and accessibility contract for every
 * glyph. Width and height remain independently overridable so replacing an
 * icon never causes surrounding layout to shift.
 */
function createAppIcon(Glyph: AppGlyph): AppIcon {
  // Every icon with no size draws the default step.
  const fallback = resolveIconSize(DEFAULT_ICON_SIZE);
  const defaultSize = fallback.px;
  function AppIcon({
    width,
    height,
    size: requestedSize,
    exactSize: requestedExactSize,
    style,
    title,
    active = false,
    ariaHidden,
    'aria-hidden': ariaHiddenAttribute,
    ...props
  }: AppIconProps): JSX.Element {
    const { size, exactSize } = resolveRequestedSize(
      requestedSize,
      requestedExactSize,
      width === undefined && height === undefined ? fallback : null,
    );
    const resolvedWidth = width ?? size ?? defaultSize;
    const resolvedHeight = height ?? size ?? defaultSize;
    const resolvedStyle: CSSProperties = {
      ...(width !== undefined || size !== undefined
        ? { width: resolvedWidth }
        : {}),
      ...(height !== undefined || size !== undefined
        ? { height: resolvedHeight }
        : {}),
      ...style,
    };
    const isAriaHidden =
      ariaHidden ??
      (ariaHiddenAttribute === undefined
        ? true
        : ariaHiddenAttribute === true || ariaHiddenAttribute === 'true');

    return (
      <Glyph
        {...props}
        {...(exactSize === undefined ? {} : { exactSize })}
        data-app-icon="true"
        size={size ?? defaultSize}
        ariaHidden={isAriaHidden}
        aria-label={title ?? props['aria-label']}
        data-active={active || undefined}
        style={resolvedStyle}
      />
    );
  }

  return AppIcon;
}

type LogoComponent = ComponentType<SVGProps<SVGSVGElement>>;

/**
 * Binds an existing repository logo to the app icon contract: `size` becomes
 * its width and height, and it gains the same accessibility handling,
 * `data-app-icon`, and a `data-glyph` naming the logo.
 */
function adaptLogo(Logo: LogoComponent, glyphName: string): AppIcon {
  function AdaptedLogo({
    size = 24,
    ariaHidden = true,
    title,
    color,
    style,
    // Logos have no size tiers: mark the request like AppIconBase does
    // rather than leak the prop onto the DOM `<svg>`.
    exactSize = false,
    ...props
  }: AppIconBaseProps): JSX.Element {
    const dimension = typeof size === 'number' ? `${size}px` : size;
    return (
      <Logo
        {...props}
        aria-hidden={ariaHidden}
        role={ariaHidden ? undefined : 'img'}
        aria-label={title ?? props['aria-label']}
        width={dimension}
        height={dimension}
        style={{ color, ...style }}
        data-glyph={glyphName}
        data-icon-size={exactSize ? 'exact' : undefined}
      />
    );
  }

  return createAppIcon(AdaptedLogo);
}

// These factories only allocate a component; pure annotations let production
// bundlers omit unused icons without changing the glyph or its rendering.
// Canonical Canopy icon API. Every glyph comes from `./AppGlyphs.generated`,
// generated from `icon-manifest.json` (Lucide and vendored brand marks);
// existing repository
// logos are bound through `adaptLogo`.
export const AddChatIcon = /* @__PURE__ */ createAppIcon(IconBubblePlus);
export const AutoIcon = /* @__PURE__ */ createAppIcon(IconLetterACircle);
export const AutoplayIcon = /* @__PURE__ */ createAppIcon(IconAutoplay);
export const AgentIcon = /* @__PURE__ */ createAppIcon(IconRobot);
// Orchestrator (internally App Advisor) uses the orbit; other assistants such
// as Pipeline Advisor and the Ledger sidecar keep the bot.
export const AppAdvisorIcon = /* @__PURE__ */ createAppIcon(IconOrbit);
export const AgentAssistantIcon = /* @__PURE__ */ createAppIcon(IconRobot2);
/** The watcher: a chat that waits on something and acts when it changes. */
export const AppAdvisorWatcherIcon =
  /* @__PURE__ */ createAppIcon(IconBroadcast);
export const ApplePlatformIcon = /* @__PURE__ */ createAppIcon(IconApple);
export const ArchiveIcon = /* @__PURE__ */ createAppIcon(IconArchive);
export const ArchiveBoxIcon = /* @__PURE__ */ createAppIcon(IconArchive1);
export const ArticleShortcutIcon = /* @__PURE__ */ createAppIcon(IconShortcut);
export const AssignmentIcon = /* @__PURE__ */ createAppIcon(IconClipboard);
export const AssignmentAddIcon = /* @__PURE__ */ createAppIcon(
  IconClipboard2Sparkle,
);
export const AutomationsIcon = /* @__PURE__ */ createAppIcon(IconClock);
export const BackIcon = /* @__PURE__ */ createAppIcon(IconArrowLeft);
export const ArrowUpIcon = /* @__PURE__ */ createAppIcon(IconArrowUp);
export const BarChart4BarsIcon =
  /* @__PURE__ */ createAppIcon(IconStackedBarChart);
export const BellIcon = /* @__PURE__ */ createAppIcon(IconBell);
export const Bell2Icon = /* @__PURE__ */ createAppIcon(IconBell2);
export const BranchIcon = /* @__PURE__ */ createAppIcon(IconBranch);
export const BrightnessAutoIcon = /* @__PURE__ */ createAppIcon(IconBrightness);
export const BugReportIcon = /* @__PURE__ */ createAppIcon(IconBug);
export const BuildingIcon = /* @__PURE__ */ createAppIcon(IconBuildings);
export const BundleIcon = /* @__PURE__ */ createAppIcon(IconPackage);
export const ChatIcon = /* @__PURE__ */ createAppIcon(IconBubble2);
export const CloseIcon = /* @__PURE__ */ createAppIcon(IconCrossSmall);
/** A clear control seated over a chip's leading glyph: a disc with the cross cut out. */
export const ClearFilledIcon = /* @__PURE__ */ createAppIcon(IconCircleXFilled);
export const CloseMediumIcon = /* @__PURE__ */ createAppIcon(IconCrossMedium);
export const CloseLargeIcon = /* @__PURE__ */ createAppIcon(IconCrossLarge);
export const CheckIcon = /* @__PURE__ */ createAppIcon(IconCheckmark1);
export const ChipSimpleIcon = /* @__PURE__ */ createAppIcon(IconChipSimple);
export const ChevronDownMediumIcon = /* @__PURE__ */ createAppIcon(
  IconChevronDownMedium,
);
export const ChevronDownIcon =
  /* @__PURE__ */ createAppIcon(IconChevronDownSmall);
export const ChevronLeftMediumIcon = /* @__PURE__ */ createAppIcon(
  IconChevronLeftMedium,
);
export const ChevronTopMediumIcon =
  /* @__PURE__ */ createAppIcon(IconChevronTopMedium);
export const LineChart1Icon = /* @__PURE__ */ createAppIcon(IconLineChart1);
export const BulletListIcon = /* @__PURE__ */ createAppIcon(IconBulletList);
export const PanelLayoutIcon = /* @__PURE__ */ createAppIcon(IconCanvasGrid);
export const ChevronRightMediumIcon = /* @__PURE__ */ createAppIcon(
  IconChevronRightMedium,
);
export const ChevronRightIcon = /* @__PURE__ */ createAppIcon(
  IconChevronRightSmall,
);
export const CodeBracketsIcon = /* @__PURE__ */ createAppIcon(IconCodeBrackets);
export const CodeMediumIcon = /* @__PURE__ */ createAppIcon(IconCodeMedium);
export const ClaudeIcon = /* @__PURE__ */ adaptLogo(ClaudeLogo, 'ClaudeLogo');
export const CodexIcon = /* @__PURE__ */ adaptLogo(CodexLogo, 'CodexLogo');
export const CursorIcon = /* @__PURE__ */ adaptLogo(CursorLogo, 'CursorLogo');
// The agent setup marks (HermesLogo, MuseLogo, OpenClawLogo, OpenCodeLogo) are
// manifest glyphs but deliberately not bound here: this module ships with every
// route, and binding them added ~10.7 KB gzip of first-load JS to each one. The
// External agents page imports them directly from `@canopy/ui-shared/icons`.
export const GoogleIcon = /* @__PURE__ */ createAppIcon(IconGoogle);
export const AntigravityIcon = /* @__PURE__ */ adaptLogo(
  AntigravityLogo,
  'AntigravityLogo',
);
export const DeepSeekIcon = /* @__PURE__ */ createAppIcon(IconDeepseek);
export const OpenRouterIcon = /* @__PURE__ */ createAppIcon(IconOpenrouter);
export const VercelIcon = /* @__PURE__ */ createAppIcon(IconVercel);
export const MiniMaxIcon = /* @__PURE__ */ createAppIcon(IconMinimax);
export const MoonshotIcon = /* @__PURE__ */ createAppIcon(IconKimi);
export const ZaiIcon = /* @__PURE__ */ createAppIcon(IconZai);
export const CognitionIcon = /* @__PURE__ */ createAppIcon(IconBrain1);
export const CommandIcon = /* @__PURE__ */ createAppIcon(IconRunShortcut);
export const CopyIcon = /* @__PURE__ */ createAppIcon(IconSquareBehindSquare1);
export const ClipboardIcon = /* @__PURE__ */ createAppIcon(IconClipboard);
export const CutIcon = /* @__PURE__ */ createAppIcon(IconArrowOutOfBox);
export const CostIcon = /* @__PURE__ */ createAppIcon(IconDollar);
export const CoworkWorkspaceIcon =
  /* @__PURE__ */ createAppIcon(IconFolderFilled);
export const DataUsageIcon = /* @__PURE__ */ createAppIcon(IconChart4);
export const DocumentIcon = /* @__PURE__ */ createAppIcon(IconFileText);
export const DocumentPencilIcon = /* @__PURE__ */ createAppIcon(IconEditBig);
export const DocumentSearchIcon = /* @__PURE__ */ createAppIcon(IconPageSearch);
export const PageTextAddIcon = /* @__PURE__ */ createAppIcon(IconPageTextAdd);
export const DragHandleIcon = /* @__PURE__ */ createAppIcon(IconDotGrid2x3);
export const DotIcon = /* @__PURE__ */ createAppIcon(IconDotGrid1x3Horizontal);
export const DownloadIcon = /* @__PURE__ */ createAppIcon(IconArrowInbox);
export const EditBigIcon = /* @__PURE__ */ createAppIcon(IconEditBig);
export const EyeIcon = /* @__PURE__ */ createAppIcon(IconEyeOpen);
export const EyeOffIcon = /* @__PURE__ */ createAppIcon(IconEyeSlash);
export const MailIcon = /* @__PURE__ */ createAppIcon(IconEmail1);
export const MailCheckIcon = /* @__PURE__ */ createAppIcon(IconEmail2Check);
export const ExperimentIcon = /* @__PURE__ */ createAppIcon(IconLab);
export const FailedIcon = /* @__PURE__ */ createAppIcon(IconCrossSmall);
/** The Feed: the Agent Ledger and organization activity, on every surface. */
export const FeedIcon = /* @__PURE__ */ createAppIcon(IconFeed);
export const FileIcon = /* @__PURE__ */ createAppIcon(IconFileText);
export const FilesIcon = /* @__PURE__ */ createAppIcon(IconFiles);
export const FocusSquareIcon = /* @__PURE__ */ createAppIcon(IconFocusSquare);
/** Diagrams (the change diagram, plan diagrams): connected nodes. */
export const ChangeDiagramIcon = /* @__PURE__ */ createAppIcon(IconConnectors2);
/** Maximize a panel group: arrows pointing out. */
export const MaximizeIcon = /* @__PURE__ */ createAppIcon(IconExpand45);
/** Restore a maximized panel group: arrows pointing in. */
export const RestoreIcon = /* @__PURE__ */ createAppIcon(IconMinimize45);
export const FolderIcon = /* @__PURE__ */ createAppIcon(IconFolder1);
export const FolderPlusIcon = /* @__PURE__ */ createAppIcon(IconFolderAddRight);
export const ForwardIcon = /* @__PURE__ */ createAppIcon(IconArrowRight);
export const FormatIndentDecreaseIcon =
  /* @__PURE__ */ createAppIcon(IconTextIndentRight);
export const FormatIndentIncreaseIcon =
  /* @__PURE__ */ createAppIcon(IconTextIndentLeft);
export const GitCommitIcon = /* @__PURE__ */ createAppIcon(IconCommits);
export const GitIcon = /* @__PURE__ */ createAppIcon(IconGit);
export const GitBranchCompactIcon =
  /* @__PURE__ */ createAppIcon(IconBranchSimple);
export const GitDraftIcon = /* @__PURE__ */ createAppIcon(IconDraftSimple);
/** Split-arrow glyph — used for worktree / new-worktree affordances. */
export const WorktreeIcon = /* @__PURE__ */ createAppIcon(IconArrowSplitRight);
export const GitHubIcon = /* @__PURE__ */ createAppIcon(IconGithub);
export const GitMergeConflictIcon = /* @__PURE__ */ createAppIcon(
  IconMergeConflictSimple,
);
export const GitMergeIcon = /* @__PURE__ */ createAppIcon(IconMergedSimple);
export const GitMergeQueueIcon = /* @__PURE__ */ createAppIcon(IconMergeQueue);
export const GitPullRequestClosedIcon = /* @__PURE__ */ createAppIcon(
  IconPullRequestClosedSimple,
);
export const GitPullRequestIcon = /* @__PURE__ */ createAppIcon(
  IconPullRequestSimple,
);
export const GitPullRequestNeutralIcon = /* @__PURE__ */ createAppIcon(
  IconPullRequestSimple,
);
export const GitRequestClosedIcon =
  /* @__PURE__ */ createAppIcon(IconRequestClosed);
export const GlobeIcon = /* @__PURE__ */ createAppIcon(IconGlobe);
export const GraphIcon = /* @__PURE__ */ createAppIcon(IconAgents);
export const Hammer2Icon = /* @__PURE__ */ createAppIcon(IconHammer2);
export const HookIcon = /* @__PURE__ */ createAppIcon(IconWebhooks);
export const HistoryIcon = /* @__PURE__ */ createAppIcon(IconHistory);
export const InfoIcon = /* @__PURE__ */ createAppIcon(IconCircleInfo);
/** Success: a checkmark in the info icon's ring, for the notice family. */
export const CircleCheckIcon = /* @__PURE__ */ createAppIcon(IconCircleCheck);
export const InputIcon = /* @__PURE__ */ createAppIcon(IconInputForm);
export const LabelIcon = /* @__PURE__ */ createAppIcon(IconTag);
export const KanbanIcon = /* @__PURE__ */ createAppIcon(IconKanbanView);
export const LayoutDashboardIcon =
  /* @__PURE__ */ createAppIcon(IconLayoutDashboard);
export const WindowsPlatformIcon = /* @__PURE__ */ createAppIcon(
  IconLayoutGrid2FilledSquare,
);
export const LinuxPlatformIcon = /* @__PURE__ */ createAppIcon(IconLinux);
export const LayoutWindowIcon = /* @__PURE__ */ createAppIcon(IconLayoutWindow);
export const LinkIcon = /* @__PURE__ */ createAppIcon(IconLink);
export const BoardIcon = /* @__PURE__ */ createAppIcon(IconBoard);
export const LinearIcon = /* @__PURE__ */ adaptLogo(LinearLogo, 'LinearLogo');
// Community identity marks. Distinct from the Lucide close `X` and the
// existing profile-platform marks, which keep their own contracts.
export const XSocialIcon = /* @__PURE__ */ createAppIcon(IconXSocial);
export const LinkedInSocialIcon = /* @__PURE__ */ adaptLogo(
  LinkedInLogo,
  'LinkedInLogo',
);
export const RedditSocialIcon = /* @__PURE__ */ createAppIcon(IconReddit);
export const DiscordSocialIcon = /* @__PURE__ */ createAppIcon(IconDiscord);
export const LoginIcon = /* @__PURE__ */ createAppIcon(IconArrowBoxRight);
export const LogoutIcon = /* @__PURE__ */ createAppIcon(IconArrowBoxLeft);
export const MacbookIcon = /* @__PURE__ */ createAppIcon(IconMacbook);
export const MagnifyingGlassIcon =
  /* @__PURE__ */ createAppIcon(IconMagnifyingGlass);
export const MapIcon = /* @__PURE__ */ createAppIcon(IconMap);
export const McpIcon = /* @__PURE__ */ createAppIcon(IconServer2);
export const McpServerIcon = McpIcon;
export const MessageIcon = /* @__PURE__ */ createAppIcon(IconBubbleText);
export const MicIcon = /* @__PURE__ */ createAppIcon(IconMicrophone);
export const MinusIcon = /* @__PURE__ */ createAppIcon(IconMinusSmall);
export const MonitorIcon = /* @__PURE__ */ createAppIcon(IconDevices);
export const MoreHorizontalIcon = /* @__PURE__ */ createAppIcon(
  IconDotGrid1x3Horizontal,
);
export const MoreVerticalIcon = /* @__PURE__ */ createAppIcon(
  IconDotGrid1x3Vertical,
);
export const MultiRepoIcon = /* @__PURE__ */ createAppIcon(IconFolders);
export const PencilIcon = /* @__PURE__ */ createAppIcon(IconPencil);
export const PersonIcon = /* @__PURE__ */ createAppIcon(IconUser);
export const PipelineIcon = /* @__PURE__ */ createAppIcon(IconAgent);
export const PinIcon = /* @__PURE__ */ createAppIcon(IconPin);
export const PinFilledIcon = /* @__PURE__ */ createAppIcon(IconPinFilled);
export const PauseIcon = /* @__PURE__ */ createAppIcon(IconPause);
export const PlanModeIcon = MapIcon;
export const PlansIcon = MapIcon;
export const PlayIcon = /* @__PURE__ */ createAppIcon(IconPlay);
export const PlayCircleIcon = /* @__PURE__ */ createAppIcon(IconPlayCircle);
export const PluginsIcon = /* @__PURE__ */ createAppIcon(IconPuzzle);
export const PlusIcon = /* @__PURE__ */ createAppIcon(IconPlusSmall);
export const PlusLargeIcon = /* @__PURE__ */ createAppIcon(IconPlusLarge);
export const PlusMediumIcon = /* @__PURE__ */ createAppIcon(IconPlusMedium);
export const PortalIcon = /* @__PURE__ */ createAppIcon(IconGlobe2);
export const PrivacyIcon = /* @__PURE__ */ createAppIcon(IconShield);
export const ProcessIcon = /* @__PURE__ */ createAppIcon(IconServer);
export const RaisedHandIcon = /* @__PURE__ */ createAppIcon(IconFrontHand);
/** The Ask approval mode, at the 16px size of the other approval glyphs. */
export const ApprovalAskIcon = /* @__PURE__ */ createAppIcon(IconFrontHand);
/** The Auto approval mode: a shield that approves on your behalf. */
export const ApprovalAutoIcon = /* @__PURE__ */ createAppIcon(IconShieldCheck3);
export const RecordIcon = /* @__PURE__ */ createAppIcon(IconRecord);
export const ResourceMonitorIcon = /* @__PURE__ */ createAppIcon(
  IconElectrocardiogram,
);
export const RefreshIcon = /* @__PURE__ */ createAppIcon(
  IconArrowRotateClockwise,
);
export const QuestionMarkIcon = /* @__PURE__ */ createAppIcon(
  IconCircleQuestionmark,
);
export const RepoIcon = /* @__PURE__ */ createAppIcon(IconFolderData);
export const RerunIcon = /* @__PURE__ */ createAppIcon(IconReplay);
export const RestartIcon = /* @__PURE__ */ createAppIcon(
  IconArrowRotateRightLeft,
);
export const RetryIcon = /* @__PURE__ */ createAppIcon(
  IconArrowRotateClockwise,
);
export const RevertIcon = /* @__PURE__ */ createAppIcon(IconArrowLoopDownLeft);
export const RocketLaunchIcon = /* @__PURE__ */ createAppIcon(IconRocket);
export const OllamaIcon = /* @__PURE__ */ adaptLogo(OllamaLogo, 'OllamaLogo');
export const ScheduleIcon = /* @__PURE__ */ createAppIcon(IconCalendarClock);
export const SettingsIcon = /* @__PURE__ */ createAppIcon(IconSettingsGear2);
export const SettingsSliderHorIcon = /* @__PURE__ */ createAppIcon(
  IconSettingsSliderHor,
);
/**
 * The one share glyph: three connected nodes. Every share action,
 * share menu item, and shared-state mark draws this component, so changing
 * the glyph here changes it everywhere. Do not add another share icon.
 */
export const ShareIcon = /* @__PURE__ */ createAppIcon(IconShareAndroid);
export const ShieldIcon = /* @__PURE__ */ createAppIcon(IconShield);
export const ShieldAiIcon = /* @__PURE__ */ createAppIcon(IconShieldAi);
export const ShieldAccessIcon = /* @__PURE__ */ createAppIcon(IconShieldAccess);
export const SidebarIcon = /* @__PURE__ */ createAppIcon(IconSidebar);
export const SidebarHiddenLeftWideIcon = /* @__PURE__ */ createAppIcon(
  IconSidebarHiddenLeftWide,
);
export const SidebarHiddenRightWideIcon = /* @__PURE__ */ createAppIcon(
  IconSidebarHiddenRightWide,
);
export const BottombarHiddenBottomWideIcon = /* @__PURE__ */ createAppIcon(
  IconBottombarHiddenBottomWide,
);
export const SingleRepoWorkspaceIcon =
  /* @__PURE__ */ createAppIcon(IconFolderFilled);
export const SkillIcon = /* @__PURE__ */ createAppIcon(IconApps);
export const SnoozeIcon = /* @__PURE__ */ createAppIcon(IconClockSnooze);
export const TimeslotIcon = /* @__PURE__ */ createAppIcon(IconClockTimeslot);
export const SplitPrIcon = /* @__PURE__ */ createAppIcon(IconArrowSplitUp);
export const SplitIcon = /* @__PURE__ */ createAppIcon(IconSplit);
/** Cross-repo / fork PR badge — Lucide `git-fork`. */
export const GitForkIcon = /* @__PURE__ */ createAppIcon(IconGitFork);
/** Lucide split and git-branch, for rows of Lucide icons (the clean chat look's reply actions). */
export const ForkSplitIcon = /* @__PURE__ */ createAppIcon(IconForkSplit);
export const GitBranchLineIcon =
  /* @__PURE__ */ createAppIcon(IconGitBranchLine);
export const StopIcon = /* @__PURE__ */ createAppIcon(IconStop);
export const StopFilledIcon = /* @__PURE__ */ createAppIcon(IconStopFilled);
export const StopwatchIcon = /* @__PURE__ */ createAppIcon(IconStopwatch);
export const StorefrontIcon = /* @__PURE__ */ createAppIcon(IconStore1);
/** The Customize hub (skills, plugins, MCP servers, collections). Marketplace sources keep `StorefrontIcon`. */
export const CustomizeIcon = /* @__PURE__ */ createAppIcon(IconBriefcase);
export const SquarePlusIcon = /* @__PURE__ */ createAppIcon(IconSquarePlus);
export const ListAddIcon = /* @__PURE__ */ createAppIcon(IconListAdd);
export const NoteIcon = /* @__PURE__ */ createAppIcon(IconNoteText);
export const AttachmentIcon = /* @__PURE__ */ createAppIcon(IconPageAttachment);
export const SummaryIcon = /* @__PURE__ */ createAppIcon(IconSummary);
export const SyncIcon = /* @__PURE__ */ createAppIcon(IconArrowRotateLeftRight);
export const TaskIcon = /* @__PURE__ */ createAppIcon(IconSquareChecklist);
export const TargetIcon = /* @__PURE__ */ createAppIcon(IconTarget);
export const TasksIcon = /* @__PURE__ */ createAppIcon(IconPlanning);
export const TemporaryMultiRepoIcon =
  /* @__PURE__ */ createAppIcon(IconFoldersDashed);
export const TerminalBorderedIcon = /* @__PURE__ */ createAppIcon(IconConsole);
export const TerminalIcon = /* @__PURE__ */ createAppIcon(IconConsoleSimple);
export const ThinkingIcon = /* @__PURE__ */ createAppIcon(IconBrain2);
/** Lightbulb: the clean chat look's thinking step. */
export const LightbulbIcon = /* @__PURE__ */ createAppIcon(IconLightbulb);
export const TimeFliesIcon = /* @__PURE__ */ createAppIcon(IconClock);
export const TrashIcon = /* @__PURE__ */ createAppIcon(IconTrashCan);
/** Trash can with an ✕: delete for good (no retention, no restore). */
export const TrashPermanentlyIcon =
  /* @__PURE__ */ createAppIcon(IconTrashPermanently);
export const TriggerIcon = /* @__PURE__ */ createAppIcon(IconCursorClick);
/** A broken link: stop sharing an item, which keeps the item itself. */
export const UnshareIcon = /* @__PURE__ */ createAppIcon(IconLinkOff);
/** Composer fast-mode chip glyph: a bolt, sized by the host. */
export const FastModeIcon = /* @__PURE__ */ createAppIcon(IconZap);
/** Fast mode switched on: the same bolt, filled. */
export const FastModeOnIcon = /* @__PURE__ */ createAppIcon(IconZapFilled);
/** Auto model selection: the router picks a model for each message. */
export const AutoModelIcon = /* @__PURE__ */ createAppIcon(IconShimmer);
export const UnarchiveIcon = /* @__PURE__ */ createAppIcon(IconUnarchive);
export const WarningIcon = /* @__PURE__ */ createAppIcon(
  IconExclamationTriangle,
);
export const WatchingIcon = /* @__PURE__ */ createAppIcon(IconWatching);
export const BeingWatchedIcon = /* @__PURE__ */ createAppIcon(IconEyeSparkle);
/** What a watcher follows. The plain eye is reserved for show/hide. */
export const WatcherEyeIcon = /* @__PURE__ */ createAppIcon(IconEyeSparkle);
export const WrenchIcon = /* @__PURE__ */ createAppIcon(IconBuild);

export const CameraIcon = /* @__PURE__ */ createAppIcon(IconCamera1);
export const CautionIcon = /* @__PURE__ */ createAppIcon(IconWarningSign);
export const CodeIcon = /* @__PURE__ */ createAppIcon(IconCodeBrackets);
export const ContextIcon = /* @__PURE__ */ createAppIcon(IconFileText);
export const DetailsIcon = /* @__PURE__ */ createAppIcon(IconListBullets);
export const DiagramIcon = /* @__PURE__ */ createAppIcon(IconAgent);
export const ExplanationIcon = /* @__PURE__ */ createAppIcon(IconCircleInfo);
export const ArrowUpRightIcon = /* @__PURE__ */ createAppIcon(IconArrowUpRight);
export const ExternalIcon = /* @__PURE__ */ createAppIcon(
  IconSquareArrowTopRight,
);
export const FilterIcon = /* @__PURE__ */ createAppIcon(IconFilter1);
export const MoonIcon = /* @__PURE__ */ createAppIcon(IconMoon);
export const PickIcon = /* @__PURE__ */ createAppIcon(IconCursorClick);
export const PeopleIdCardIcon = /* @__PURE__ */ createAppIcon(IconPeopleIdCard);
export const SearchIcon = /* @__PURE__ */ createAppIcon(IconMagnifyingGlass);
export const SunIcon = /* @__PURE__ */ createAppIcon(IconSun);
export const WorkflowIcon = /* @__PURE__ */ createAppIcon(IconWorkflows);
/** The Workflows destination (pipelines, automations, watchers and hooks). */
export const WorkflowsIcon = /* @__PURE__ */ createAppIcon(IconWorkflows);

export interface RefreshSpinnerIconProps extends AppIconProps {
  spinning?: boolean;
}

const RefreshGlyph = createAppIcon(IconArrowRotateClockwise);

export function RefreshSpinnerIcon({
  spinning = false,
  className,
  ...props
}: RefreshSpinnerIconProps): JSX.Element {
  return (
    <RefreshGlyph
      {...props}
      className={`${spinning ? 'animate-spin' : ''}${className ? ` ${className}` : ''}`}
    />
  );
}

// Lucide-compatible names let existing desktop and web call sites migrate
// without losing their props or local aliases.
export type LucideIcon = AppIcon;
const lucide = (Glyph: AppGlyph): LucideIcon => createAppIcon(Glyph);

export const Activity = /* @__PURE__ */ lucide(IconElectrocardiogram);
export const AlertTriangle = /* @__PURE__ */ lucide(IconWarningSign);
export const ArrowDownRight = /* @__PURE__ */ lucide(IconArrowDownRight);
export const ArrowUp = /* @__PURE__ */ lucide(IconArrowUp);
export const ArrowUpRight = /* @__PURE__ */ lucide(IconArrowUpRight);
export const BarChart3 = /* @__PURE__ */ lucide(IconChart4);
export const Bot = /* @__PURE__ */ lucide(IconRobot);
export const Boxes = /* @__PURE__ */ lucide(IconBuildingBlocks);
export const CalendarClock = /* @__PURE__ */ lucide(IconCalendarClock);
export const Camera = /* @__PURE__ */ lucide(IconCamera1);
export const Check = /* @__PURE__ */ lucide(IconCheckmark1);
export const ChevronDown = /* @__PURE__ */ lucide(IconChevronDownSmall);
export const ChevronRight = /* @__PURE__ */ lucide(IconChevronRightSmall);
export const ChevronUp = /* @__PURE__ */ lucide(IconChevronTopSmall);
export const ChevronsUpDown = /* @__PURE__ */ lucide(IconUnfoldMore);
export const CircleDollarSign = /* @__PURE__ */ lucide(IconDollar);
export const ClipboardCheck = /* @__PURE__ */ lucide(IconSquareChecklist);
export const ClipboardList = /* @__PURE__ */ lucide(IconClipboard);
export const Cloud = /* @__PURE__ */ lucide(IconCloud);
export const Copy = /* @__PURE__ */ lucide(IconSquareBehindSquare1);
export const CreditCard = /* @__PURE__ */ lucide(IconCreditCard1);
export const Download = /* @__PURE__ */ lucide(IconArrowInbox);
export const ExternalLink = /* @__PURE__ */ lucide(IconSquareArrowTopRight);
export const Eye = /* @__PURE__ */ lucide(IconEyeOpen);
export const FileDiff = /* @__PURE__ */ lucide(IconDifference);
export const FileText = /* @__PURE__ */ lucide(IconFileText);
export const Folder = /* @__PURE__ */ lucide(IconFolder1);
export const FolderGit2 = /* @__PURE__ */ lucide(IconFolderData);
export const GitBranch = /* @__PURE__ */ lucide(IconBranch);
export const GitMerge = /* @__PURE__ */ lucide(IconMerged);
export const GitPullRequest = /* @__PURE__ */ lucide(IconPullRequest);
export const Github = /* @__PURE__ */ lucide(IconGithub);
export const Globe = /* @__PURE__ */ lucide(IconGlobe);
export const Globe2 = /* @__PURE__ */ lucide(IconGlobe2);
export const History = /* @__PURE__ */ lucide(IconHistory);
/** The Chat visuals panel, on every host. */
export const ChatVisualsIcon = /* @__PURE__ */ createAppIcon(IconImages1);
export const Image = /* @__PURE__ */ lucide(IconImages1);
export const ImagePlus = /* @__PURE__ */ lucide(IconAddPhotoAlternate);
export const Info = /* @__PURE__ */ lucide(IconCircleInfo);
export const Link = /* @__PURE__ */ lucide(IconLink);
export const Link2 = /* @__PURE__ */ lucide(IconLink);
export const ListChecks = /* @__PURE__ */ lucide(IconSquareChecklist);
export const ListTodo = /* @__PURE__ */ lucide(IconListBullets);
export const Loader2 = /* @__PURE__ */ lucide(IconLoader);
export const Lock = /* @__PURE__ */ lucide(IconLock);
export const LogOut = /* @__PURE__ */ lucide(IconArrowBoxLeft);
export const Mail = /* @__PURE__ */ lucide(IconEmail1);
// Organization Memory: the same brain glyph as the desktop Memory row.
export const Database = /* @__PURE__ */ lucide(IconBrain1);
export const MailCheck = /* @__PURE__ */ lucide(IconEmail2Check);
export const Menu = /* @__PURE__ */ lucide(IconBarsThree);
export const MenuSimpleIcon = /* @__PURE__ */ createAppIcon(IconBarsTwo);
export const MessageSquare = /* @__PURE__ */ lucide(IconBubble2);
export const MessageSquarePlus = /* @__PURE__ */ lucide(IconBubblePlus);
export const MessagesSquare = /* @__PURE__ */ lucide(IconBubbles);
export const Minus = /* @__PURE__ */ lucide(IconMinusSmall);
// Memory graph view: the same glyph as `GraphIcon`.
export const Network = /* @__PURE__ */ lucide(IconAgents);
// Digests on a member profile.
export const Newspaper = /* @__PURE__ */ lucide(IconSummary);
export const MonitorSmartphone = /* @__PURE__ */ lucide(IconDevices);
export const Moon = /* @__PURE__ */ lucide(IconMoon);
export const MoreHorizontal = /* @__PURE__ */ lucide(IconDotGrid1x3Horizontal);
export const Pause = /* @__PURE__ */ lucide(IconPause);
export const Pencil = /* @__PURE__ */ lucide(IconPencil);
export const Play = /* @__PURE__ */ lucide(IconPlay);
export const Plus = /* @__PURE__ */ lucide(IconPlusSmall);
export const Puzzle = /* @__PURE__ */ lucide(IconPuzzle);
export const RefreshCw = /* @__PURE__ */ lucide(IconArrowRotateClockwise);
export const Search = /* @__PURE__ */ lucide(IconMagnifyingGlass);
export const Settings = /* @__PURE__ */ lucide(IconSettingsGear2);
export const Settings2 = /* @__PURE__ */ lucide(IconSettingsSliderHor);
export const Shield = /* @__PURE__ */ lucide(IconShield);
export const ShieldCheck = /* @__PURE__ */ lucide(IconShieldCheck);
export const SlidersHorizontal = /* @__PURE__ */ lucide(IconSettingsSliderHor);
export const Smartphone = /* @__PURE__ */ lucide(IconPhone);
export const PhoneFilledIcon = /* @__PURE__ */ createAppIcon(IconPhoneFilled);
export const PhoneDynamicIslandFilledIcon = /* @__PURE__ */ createAppIcon(
  IconPhoneDynamicIslandFilled,
);
export const PhoneDynamicIslandIcon = /* @__PURE__ */ createAppIcon(
  IconPhoneDynamicIsland,
);
export const Sparkles = /* @__PURE__ */ lucide(IconAutoAwesome);
export const SquarePlus = /* @__PURE__ */ lucide(IconSquarePlus);
export const Sun = /* @__PURE__ */ lucide(IconSun);
export const Terminal = /* @__PURE__ */ lucide(IconConsoleSimple);
export const Trash2 = /* @__PURE__ */ lucide(IconTrashCan);
export const User = /* @__PURE__ */ lucide(IconUser);
export const UserCircle = /* @__PURE__ */ lucide(IconUser);
export const UserPlus = /* @__PURE__ */ lucide(IconUserAdd);
export const Users = /* @__PURE__ */ lucide(IconUserGroup);
export const Workflow = /* @__PURE__ */ lucide(IconWorkflows);
export const X = /* @__PURE__ */ lucide(IconCrossSmall);

export const StarSquareIcon = /* @__PURE__ */ createAppIcon(IconReviewFilled);

/** Sparkle: free daily AI Credits and AI assistance actions such as "Edit with AI". */
export const SparkleIcon = /* @__PURE__ */ createAppIcon(IconSparkle);

export const AllModelsIcon = /* @__PURE__ */ createAppIcon(IconAllModels);
export const AllModelsFilledIcon =
  /* @__PURE__ */ createAppIcon(IconAllModelsFilled);

export const ChangesIcon = /* @__PURE__ */ createAppIcon(IconChanges);

export const VibeCodingIcon = /* @__PURE__ */ createAppIcon(IconVibeCoding);

// Shared replacements for the remaining inline app controls.
export const RedoIcon = /* @__PURE__ */ createAppIcon(IconRedo);
export const StarIcon = /* @__PURE__ */ createAppIcon(IconStar);
export const ListFilterIcon = /* @__PURE__ */ createAppIcon(IconListFilter);
export const ListStartIcon = /* @__PURE__ */ createAppIcon(IconListStart);
export const MessageCircleDashedIcon = /* @__PURE__ */ createAppIcon(
  IconMessageCircleDashed,
);
/** Sort controls: the search field's nested Sort button. */
export const ArrowUpDownIcon = /* @__PURE__ */ createAppIcon(IconArrowUpDown);
/** A search with no results: the shared search empty state. */
export const SearchXIcon = /* @__PURE__ */ createAppIcon(IconSearchX);
export const FileDownIcon = /* @__PURE__ */ createAppIcon(IconFileDown);
export const MonitorDownIcon = /* @__PURE__ */ createAppIcon(IconMonitorDown);
export const CircleStopIcon = /* @__PURE__ */ createAppIcon(IconCircleStop);
export const CircleDashedIcon = /* @__PURE__ */ createAppIcon(IconCircleDashed);
/** The Paused status glyph: two bars in a circle. */
export const CirclePauseIcon = /* @__PURE__ */ createAppIcon(IconCirclePause);
/** Cancel actions (Cancel plan): an outline X in a circle. */
export const CircleXIcon = /* @__PURE__ */ createAppIcon(IconCircleX);

export const CoinsIcon = /* @__PURE__ */ createAppIcon(IconCoins);
export const ThumbsUpIcon = /* @__PURE__ */ createAppIcon(IconThumbsUp);
export const ThumbsDownIcon = /* @__PURE__ */ createAppIcon(IconThumbsDown);
export const SteerIcon = /* @__PURE__ */ createAppIcon(IconSteer);
export const MentionIcon = /* @__PURE__ */ createAppIcon(IconMention);
export const SingleSignOnIcon = /* @__PURE__ */ createAppIcon(IconSingleSignOn);
