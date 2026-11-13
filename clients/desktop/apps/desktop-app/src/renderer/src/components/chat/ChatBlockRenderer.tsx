import {
  DelegationTranscriptSourceContext,
  transcriptReadSource,
  useDelegatedAgentTranscript,
  useDelegationStreamHint,
} from './delegated-agent-transcript';
import {
  renderDelegationChildRows,
  renderDelegationChildBlock,
} from './delegation-child-row-renderer';
import { isClaudeAiCreditsFallbackErrorCode } from '@canopy/protocol/llm-gateway';
import { ClaudeAiCreditsFallbackError } from './ClaudeAiCreditsFallbackError';
import { codexAgentState } from './agent-block-state';
import {
  Children,
  createContext,
  Fragment,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
  type JSX,
  type ReactNode,
} from 'react';
import {
  AccountProxySwitchLine,
  type AnsweredQuestionDisplay,
  AnsweredQuestionsBlock,
  ApprovalSafetyDeniedNotice,
  askUserQuestionCount,
  type AskUserQuestionResultEvidence,
  askUserQuestionRowLabel,
  ChatAppNote,
  compactionHeadline,
  CompactionInfoBlock,
  copyTextToClipboard,
  DEFAULT_MARKDOWN_OVERRIDES,
  extractExitPlanModePlan,
  Markdown,
  ErrorBanner,
  MarkdownCodeBlock,
  MarkdownImage,
  MarkdownImageUnavailable,
  markdownOptions,
  type MarkdownOverrides,
  markdownTableCellProps,
  Notice,
  resolveAskUserQuestionPresentation,
  Surface,
  TRANSCRIPT_PROSE_CLASS,
  useCleanChatLook,
  useSmoothStreaming,
  withSoftLineBreaks,
} from '@canopy/ui-shared/components';
import type { PendingQuestion } from '@/stores/chatStore';
import { ThinkingSpinner } from '../shared/loading/spinners/ThinkingSpinner';
import { parseAnsweredQuestions } from './answered-questions';
import { AgentBlock } from './AgentBlock';
import { WorkflowBlock } from './WorkflowBlock';
import { CollapsibleBlock } from './CollapsibleBlock';
import { ToolCallBlock } from './ToolCallBlock';
import {
  ChatVisualBlock,
  ClaudeModsSkippedNoticeView,
  GitHubReferencePreview,
  LinearReferencePreview,
  ManagedDelegationCard,
  type ChatVisualOwner,
} from '@canopy/ui-app';
import type {
  ClaudeModPluginDetailsTarget,
  ClaudeModsChatContext,
} from '@canopy/protocol/claude-mods';
import { useChatTabRenderState } from '@/stores/chatStore';
import { openClaudeModPluginDetails } from './open-claude-mod-plugin-details';
import type { ToolResult } from './types';
import { TurnTimer } from './TurnTimer';
import type { DisplayBlock } from './types';
import { HookInfoBanner } from './HookInfoBanner';
import { useExpandedRunInterest } from '@/lib/chat-interest';
import { isAskUserQuestionToolName } from '@/lib/canopy-tool-aliases';
import { findAskUserQuestionRecordState } from './ask-user-pending-match';
import { SkillIcon } from '@canopy/ui-shared/icons';
import {
  TimeFliesIcon as AppCatalogTimeFliesIcon,
  InfoIcon as AppCatalogInfoIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { RevertIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  stripOpaqueAgentCitationMarkers,
  stripProposedPlanEnvelope,
} from '@canopy/ui-shared/lib';
import { getDisplayBlockKey } from './display-block-keys';
import { InvocableMention } from './InvocableMention';
import { InvocableDetailsButton } from './InvocableDetailsModal';
import {
  findInvocableMentionTarget,
  splitTextByInvocableMentions,
  type InvocableMentionIndex,
} from '@/lib/invocableMentionIndex';
import {
  splitTextByFilePathMentions,
  type FilePathMentionIndex,
} from '@/lib/filePathMentionIndex';
import { FilePathMention } from './FilePathMention';
import {
  splitTextByPluginMentions,
  type PluginMentionIndex,
} from '@/lib/pluginMentionIndex';
import { PluginMention } from './PluginMention';
import { ChatMarkdownFileTargetContext } from './chat-markdown-file-target';
import { ChatMarkdownLink } from './ChatMarkdownLink';
import {
  gitHubReferenceFromHref,
  gitHubReferenceLabel,
} from '@canopy/desktop-shared/lib/github-reference-occurrences';
import {
  decorateReferences,
  isGeneratedGitHubLinkLabel,
  isGeneratedLinearLabel,
  linearReferenceFromHref,
  scanGitHubCandidates,
  scanLinearCandidates,
  useGitHubDecoration,
  useLinearDecoration,
  type GitHubCandidates,
  type GitHubDecoration,
  type LinearCandidates,
  type LinearDecoration,
} from './referencePreviewDecoration';
import { isSafeCodexInlineImage } from '@canopy/agent-transcript/lib/codex-tool-images';
import { AuthRecoveryCard } from './AuthRecoveryCard';
import { CanopyProxyErrorNotice } from './CanopyProxyErrorNotice';
import { AiCreditsStopLine } from '@canopy/ui-shared/components';
import { CodexAccountModelNoticeAction } from './CodexAccountModelNoticeAction';
import { AccountProxyFailureNoticeAction } from './AccountProxyFailureNoticeAction';
import { isAccountProxySettingsFailure } from '@canopy/protocol/auth-recovery';
import { APPROVAL_MODE_PROSE_LABELS } from './approval-mode-labels';
import {
  getHarnessConnectionProvider,
  legacyProviderAuthFailure,
  parseCanopyProxyError,
} from './chatConnectionErrors';
import { readAuthDependencyFailures } from '@canopy/protocol/auth-recovery';
import type { DelegationWorkspaceChanges } from '@canopy/protocol/delegation';
import {
  ManagedDelegationStopContext,
  requestManagedDelegationChanges,
  requestManagedDelegationStop,
} from './managed-delegation-stop';
import { useSubagentOpenChatCallback } from '@/components/subagents/subagent-entry-actions';

/**
 * Conservative fast path for the common one-line prose blocks that Markdown
 * renders as a single paragraph. Anything with block syntax, inline emphasis,
 * links/autolinks, math dollars, escapes, HTML, entities, or line breaks stays
 * on the full parser. Mention and file-path decoration is applied separately
 * below.
 */
function canRenderAsPlainParagraph(text: string): boolean {
  if (
    text.trim().length === 0 ||
    /[\r\n\\&*_`[\]<>#~|]/.test(text) ||
    text.includes('$') ||
    /^(?: {4,}| {0,3}\t)/.test(text)
  ) {
    return false;
  }
  if (
    /^\s*(?:[-+>]|\d+[.)])(?:\s|$)/.test(text) ||
    /^ {0,3}(?:-\s*){3,}$/.test(text) ||
    /!\[/.test(text) ||
    /(?:https?:\/\/|mailto:|www\.)/i.test(text) ||
    /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/.test(text)
  ) {
    return false;
  }
  return true;
}

const MARKDOWN_COMPONENTS: MarkdownOverrides = {
  ...DEFAULT_MARKDOWN_OVERRIDES,
  a: ChatMarkdownLink,
  img: ({
    src,
    alt,
    node,
    ...props
  }: ComponentPropsWithoutRef<'img'> & { node?: unknown }): JSX.Element => {
    void node;
    return <ChatMarkdownImage src={src} alt={alt} {...props} />;
  },
};

function isAbsoluteLocalImageSource(source: string): boolean {
  return /^\/(?!\/)/.test(source) || /^[a-zA-Z]:[\\/]/.test(source);
}

// `//host/...` and `\\host\...` resolve against the renderer's `file:` or
// custom-scheme origin, never the web, and on Windows reach SMB. No source of
// that shape is a loadable chat image, so it never becomes a request.
function isNetworkPathImageSource(source: string): boolean {
  return /^[\\/]{2}/.test(source.trimStart());
}

const ChatMarkdownImage = memo(function ChatMarkdownImage({
  src,
  alt,
  ...props
}: ComponentPropsWithoutRef<'img'>): JSX.Element {
  const rawSrc = typeof src === 'string' ? src : '';
  const target = useContext(ChatMarkdownFileTargetContext);
  const [resolvedSrc, setResolvedSrc] = useState<string | null | undefined>();
  const shouldResolve = target !== null && isAbsoluteLocalImageSource(rawSrc);

  useEffect(() => {
    if (!shouldResolve || !target) return;
    let cancelled = false;
    setResolvedSrc(undefined);
    void (async (): Promise<void> => {
      try {
        const resolved = await window.api.resolveFileReference({
          projectId: target.projectId,
          worktreeId: target.worktreeId,
          baseFilePath: rawSrc,
          href: rawSrc,
        });
        if (!resolved) {
          if (!cancelled) setResolvedSrc(null);
          return;
        }
        const content = await window.api.readFileContent({
          absolutePath: resolved.absolutePath,
        });
        if (!cancelled) {
          setResolvedSrc(content.kind === 'image' ? content.content : null);
        }
      } catch {
        if (!cancelled) setResolvedSrc(null);
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [rawSrc, shouldResolve, target]);

  if (isNetworkPathImageSource(rawSrc)) {
    return <MarkdownImageUnavailable alt={alt} />;
  }
  if (!shouldResolve) {
    return <MarkdownImage {...props} src={src} alt={alt} />;
  }

  if (resolvedSrc === undefined) {
    return <span className="text-xs fg-secondary">Loading image…</span>;
  }
  if (resolvedSrc === null) {
    return <MarkdownImageUnavailable alt={alt} />;
  }
  return <MarkdownImage {...props} src={resolvedSrc} alt={alt} />;
});

interface ChatImageBlockProps {
  path: string;
  dataUrl?: string;
  alt: string;
}

const ChatImageBlock = memo(function ChatImageBlock({
  path,
  dataUrl,
  alt,
}: ChatImageBlockProps): JSX.Element {
  const [src, setSrc] = useState<string | null | undefined>();

  useEffect(() => {
    let cancelled = false;
    setSrc(undefined);
    if (dataUrl !== undefined) {
      setSrc(isSafeCodexInlineImage(dataUrl) ? dataUrl : null);
      return;
    }
    const windowsPath = path.replace(/\//g, '\\');
    if (
      windowsPath.startsWith('\\\\') ||
      windowsPath.startsWith('\\??\\') ||
      windowsPath.toUpperCase().startsWith('\\GLOBALROOT\\')
    ) {
      setSrc(null);
      return (): void => {
        cancelled = true;
      };
    }
    void window.api
      .readFileContent({
        absolutePath: path,
        allowedRoot: 'codex-generated-images',
      })
      .then((content) => {
        if (!cancelled) {
          setSrc(content.kind === 'image' ? content.content : null);
        }
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });
    return (): void => {
      cancelled = true;
    };
  }, [path, dataUrl]);

  if (src === undefined) {
    return (
      <Surface variant="group" data-testid="chat-generated-image-loading">
        <div className="flex items-center justify-center min-h-32 fg-secondary">
          <ThinkingSpinner tone="accent" />
        </div>
      </Surface>
    );
  }
  if (src === null) {
    return (
      <Surface variant="group" data-testid="chat-generated-image-unavailable">
        <div className="px-4 py-3 text-s fg-secondary">Image unavailable</div>
      </Surface>
    );
  }

  return (
    <img
      data-testid="chat-generated-image"
      src={src}
      alt={alt}
      onError={() => setSrc(null)}
      className="max-h-[70vh] max-w-full self-start rounded-lg object-contain shadow-sm"
    />
  );
});

function decorateFilePathText(
  text: string,
  index: FilePathMentionIndex | null | undefined,
  keyPrefix: string,
  originChatTabId: string | undefined,
): ReactNode[] {
  return splitTextByFilePathMentions(text, index).map((piece, index) => {
    if (piece.type === 'text') {
      return piece.text;
    }
    return (
      <FilePathMention
        key={`${keyPrefix}-file-${index}`}
        target={piece.target}
        location={piece.location}
        displayText={piece.text}
        originChatTabId={originChatTabId}
      >
        {piece.text}
      </FilePathMention>
    );
  });
}

/**
 * The file chip for inline code whose whole text is one file path, labelled
 * with the file name and line only (reference chips name the ID, the tooltip
 * keeps the full path), or null for any other code.
 */
function wholeFilePathMention(
  decorators: MentionDecorators,
  children: ReactNode,
): JSX.Element | null {
  if (typeof children !== 'string' || !decorators.filePathIndex) return null;
  const text = children.trim();
  const pieces = splitTextByFilePathMentions(text, decorators.filePathIndex);
  const piece = pieces.length === 1 ? pieces[0] : undefined;
  if (piece?.type !== 'file' || piece.text !== text) return null;
  // Keep the line suffix as written (`:12`, `#L12-L20`): what follows the
  // file name the scanner matched, which may itself contain `:12`.
  const { filename } = piece.target;
  const suffix = piece.location
    ? text.slice(text.lastIndexOf(filename) + filename.length)
    : '';
  return (
    <FilePathMention
      target={piece.target}
      location={piece.location}
      displayText={piece.text}
      originChatTabId={decorators.originChatTabId}
    >
      {`${filename}${suffix}`}
    </FilePathMention>
  );
}

function decoratePluginAndFilePathText(
  text: string,
  filePathIndex: FilePathMentionIndex | null | undefined,
  pluginIndex: PluginMentionIndex | null | undefined,
  keyPrefix: string,
  originChatTabId: string | undefined,
): ReactNode[] {
  return splitTextByPluginMentions(text, pluginIndex).flatMap(
    (piece, index) => {
      if (piece.type === 'text') {
        return decorateFilePathText(
          piece.text,
          filePathIndex,
          `${keyPrefix}-plugin-${index}`,
          originChatTabId,
        );
      }
      return (
        <PluginMention
          key={`${keyPrefix}-plugin-mention-${index}`}
          target={piece.target}
        >
          {piece.text}
        </PluginMention>
      );
    },
  );
}

function decorateMentionText(
  text: string,
  invocableIndex: InvocableMentionIndex | null | undefined,
  filePathIndex: FilePathMentionIndex | null | undefined,
  pluginIndex: PluginMentionIndex | null | undefined,
  keyPrefix: string,
  originChatTabId: string | undefined,
): ReactNode[] {
  return splitTextByInvocableMentions(text, invocableIndex).flatMap(
    (piece, index) => {
      if (piece.type === 'text') {
        return decoratePluginAndFilePathText(
          piece.text,
          filePathIndex,
          pluginIndex,
          `${keyPrefix}-text-${index}`,
          originChatTabId,
        );
      }
      return (
        <InvocableMention
          key={`${keyPrefix}-mention-${index}`}
          target={piece.target}
        >
          {piece.text}
        </InvocableMention>
      );
    },
  );
}

function hasTextDecorators(
  invocableIndex: InvocableMentionIndex | null | undefined,
  filePathIndex: FilePathMentionIndex | null | undefined,
  pluginIndex: PluginMentionIndex | null | undefined,
): boolean {
  return Boolean(
    (invocableIndex && invocableIndex.aliases.size > 0) ||
    (filePathIndex && filePathIndex.aliases.size > 0) ||
    (pluginIndex && pluginIndex.aliases.size > 0),
  );
}

function decorateMentionChildren(
  children: ReactNode,
  invocableIndex: InvocableMentionIndex | null | undefined,
  filePathIndex: FilePathMentionIndex | null | undefined,
  pluginIndex: PluginMentionIndex | null | undefined,
  keyPrefix: string,
  originChatTabId: string | undefined,
  linear: LinearDecoration | null = null,
  github: GitHubDecoration | null = null,
): ReactNode {
  const mentions = hasTextDecorators(
    invocableIndex,
    filePathIndex,
    pluginIndex,
  );
  const teamKeys = linear?.teamKeys ?? null;
  if (!mentions && !teamKeys && !github) return children;
  return Children.toArray(children).map((child, childIndex) => {
    if (typeof child === 'string') {
      const key = `${keyPrefix}-${childIndex}`;
      const decorateText = (text: string): ReactNode =>
        mentions
          ? decorateMentionText(
              text,
              invocableIndex,
              filePathIndex,
              pluginIndex,
              key,
              originChatTabId,
            )
          : text;
      return (
        <Fragment key={key}>
          {teamKeys || github
            ? decorateReferences(
                child,
                key,
                decorateText,
                teamKeys,
                github,
                linear?.mode,
              )
            : decorateText(child)}
        </Fragment>
      );
    }
    return child;
  });
}

interface MentionDecorators {
  invocableIndex: InvocableMentionIndex | null | undefined;
  filePathIndex: FilePathMentionIndex | null | undefined;
  pluginIndex: PluginMentionIndex | null | undefined;
  originChatTabId: string | undefined;
  /** Settled prose whose Linear references are eligible for decoration. */
  linear: LinearDecoration | null;
  /** Settled prose whose GitHub references are eligible for decoration. */
  github: GitHubDecoration | null;
}

const NO_MENTION_DECORATORS: MentionDecorators = {
  invocableIndex: undefined,
  filePathIndex: undefined,
  pluginIndex: undefined,
  originChatTabId: undefined,
  linear: null,
  github: null,
};

/**
 * Mention indexes for the Markdown elements of one text block.
 *
 * The indexes reach the element overrides through context so the overrides
 * keep one identity. An override that changes identity is a different
 * component type to React: when a file index loaded after a transcript was
 * shown, every paragraph, heading and table cell of every visible message was
 * unmounted and rebuilt (and re-styled and laid out), only to render the same
 * text with its mentions decorated.
 */
const MentionDecoratorsContext = createContext<MentionDecorators>(
  NO_MENTION_DECORATORS,
);

/**
 * True inside a fenced or indented block. A block's `code` has no language
 * class when the fence names none, so the class alone can't tell it apart
 * from inline code.
 */
const InCodeBlockContext = createContext(false);

function decorateWithMentions(
  decorators: MentionDecorators,
  children: ReactNode,
  keyPrefix: string,
  references = true,
): ReactNode {
  return decorateMentionChildren(
    children,
    decorators.invocableIndex,
    decorators.filePathIndex,
    decorators.pluginIndex,
    keyPrefix,
    decorators.originChatTabId,
    references ? decorators.linear : null,
    references ? decorators.github : null,
  );
}

function useDecoratedChildren(
  children: ReactNode,
  keyPrefix: string,
): ReactNode {
  return decorateWithMentions(
    useContext(MentionDecoratorsContext),
    children,
    keyPrefix,
  );
}

const MENTION_MARKDOWN_COMPONENTS: MarkdownOverrides = {
  ...MARKDOWN_COMPONENTS,
  pre: function MentionPre(
    props: ComponentPropsWithoutRef<'pre'>,
  ): JSX.Element {
    return (
      <InCodeBlockContext.Provider value={true}>
        <MarkdownCodeBlock {...props} />
      </InCodeBlockContext.Provider>
    );
  },
  a: function MentionMarkdownLink(
    props: ComponentPropsWithoutRef<'a'>,
  ): JSX.Element {
    const decorators = useContext(MentionDecoratorsContext);
    // A link label never nests a reference trigger, including in its emphasis.
    const labelDecorators = useMemo(
      (): MentionDecorators => ({ ...decorators, linear: null, github: null }),
      [decorators],
    );
    const linear =
      decorators.linear?.urls === true && typeof props.href === 'string'
        ? linearReferenceFromHref(props.href)
        : null;
    const github =
      decorators.github && typeof props.href === 'string'
        ? gitHubReferenceFromHref(props.href)
        : null;
    return (
      <MentionDecoratorsContext.Provider value={labelDecorators}>
        {github && decorators.github && typeof props.href === 'string' ? (
          <GitHubReferencePreview
            target={github.target}
            mode={decorators.github.mode}
            href={props.href}
            label={gitHubReferenceLabel(
              github.target,
              decorators.github.originRepository,
            )}
            expandTitle={isGeneratedGitHubLinkLabel(
              props.children,
              props.href,
              github.target,
            )}
          >
            {props.children}
          </GitHubReferencePreview>
        ) : linear && typeof props.href === 'string' ? (
          <LinearReferencePreview
            {...linear}
            mode={decorators.linear?.mode}
            href={props.href}
            expandTitle={isGeneratedLinearLabel(
              props.children,
              props.href,
              linear.identifier,
            )}
          >
            {props.children}
          </LinearReferencePreview>
        ) : (
          <ChatMarkdownLink
            {...props}
            originChatTabId={decorators.originChatTabId}
          />
        )}
      </MentionDecoratorsContext.Provider>
    );
  },
  p: function MentionParagraph({
    children,
    ...props
  }: ComponentPropsWithoutRef<'p'>): JSX.Element {
    return <p {...props}>{useDecoratedChildren(children, 'p')}</p>;
  },
  li: function MentionListItem({
    children,
    ...props
  }: ComponentPropsWithoutRef<'li'>): JSX.Element {
    return <li {...props}>{useDecoratedChildren(children, 'li')}</li>;
  },
  strong: function MentionStrong({
    children,
    ...props
  }: ComponentPropsWithoutRef<'strong'>): JSX.Element {
    return (
      <strong {...props}>{useDecoratedChildren(children, 'strong')}</strong>
    );
  },
  em: function MentionEmphasis({
    children,
    ...props
  }: ComponentPropsWithoutRef<'em'>): JSX.Element {
    return <em {...props}>{useDecoratedChildren(children, 'em')}</em>;
  },
  code: function MentionCode({
    children,
    className,
    ...props
  }: ComponentPropsWithoutRef<'code'>): JSX.Element {
    const decorators = useContext(MentionDecoratorsContext);
    const inBlock = useContext(InCodeBlockContext);
    const isCodeBlock =
      inBlock ||
      (typeof className === 'string' &&
        (className.includes('lang-') || className.includes('language-')));
    // Fenced code stays literal, so it is never scanned for mentions: a large
    // generated block would otherwise pay for a decoration it then drops.
    // Inline code that is only a file path is the file chip alone, never a
    // chip boxed inside a code pill.
    const file = isCodeBlock
      ? null
      : wholeFilePathMention(decorators, children);
    if (file) return file;
    // Other inline code keeps skill and plugin mentions, but never a file
    // chip or a reference link inside its box.
    return (
      <code className={className} {...props}>
        {isCodeBlock
          ? children
          : decorateWithMentions(
              { ...decorators, filePathIndex: null },
              children,
              'code',
              false,
            )}
      </code>
    );
  },
  h1: function MentionHeading1({
    children,
    ...props
  }: ComponentPropsWithoutRef<'h1'>): JSX.Element {
    return <h1 {...props}>{useDecoratedChildren(children, 'h1')}</h1>;
  },
  h2: function MentionHeading2({
    children,
    ...props
  }: ComponentPropsWithoutRef<'h2'>): JSX.Element {
    return <h2 {...props}>{useDecoratedChildren(children, 'h2')}</h2>;
  },
  h3: function MentionHeading3({
    children,
    ...props
  }: ComponentPropsWithoutRef<'h3'>): JSX.Element {
    return <h3 {...props}>{useDecoratedChildren(children, 'h3')}</h3>;
  },
  blockquote: function MentionBlockquote({
    children,
    ...props
  }: ComponentPropsWithoutRef<'blockquote'>): JSX.Element {
    return (
      <blockquote {...props}>
        {useDecoratedChildren(children, 'blockquote')}
      </blockquote>
    );
  },
  td: function MentionTableCell({
    children,
    ...props
  }: ComponentPropsWithoutRef<'td'>): JSX.Element {
    return (
      <td {...props} {...markdownTableCellProps(children)}>
        {useDecoratedChildren(children, 'td')}
      </td>
    );
  },
  th: function MentionTableHeader({
    children,
    ...props
  }: ComponentPropsWithoutRef<'th'>): JSX.Element {
    return (
      <th {...props} {...markdownTableCellProps(children, true)}>
        {useDecoratedChildren(children, 'th')}
      </th>
    );
  },
};

const MENTION_MARKDOWN_OPTIONS = markdownOptions(MENTION_MARKDOWN_COMPONENTS, {
  allowLocalFileLinks: true,
});
const MENTION_MARKDOWN_OPTIONS_WITH_LINE_BREAKS = withSoftLineBreaks(
  MENTION_MARKDOWN_OPTIONS,
);

const MARKDOWN_OPTIONS = markdownOptions(MARKDOWN_COMPONENTS, {
  allowLocalFileLinks: true,
});

const EMPTY_PENDING: PendingQuestion[] = [];
const EMPTY_WAITING_DELEGATIONS: ReadonlySet<string> = new Set();

/** Delegations whose request to this chat still waits in its queue. */
// eslint-disable-next-line react-refresh/only-export-components -- The parent message list owns this provider.
export const WaitingDelegationsContext = createContext<ReadonlySet<string>>(
  EMPTY_WAITING_DELEGATIONS,
);

type BuiltinGhChatKind = Extract<
  DisplayBlock,
  { type: 'builtin_gh_chat_info' }
>['kind'];

/**
 * Banner copy for a chat a GitHub action started. A marker persisted by a
 * newer build can carry a kind this build does not know, so the fallback stays
 * neutral instead of claiming a specific cause.
 */
function builtinGhChatBannerCopy(
  kind: BuiltinGhChatKind,
  target: string,
): { source: string; description: string } {
  switch (kind) {
    case 'merge_conflict':
      return {
        source: 'Merge conflict resolution',
        description: `GitHub reported merge conflicts for ${target}. An agent will resolve the conflicts, then commit and push the merge.`,
      };
    case 'review_comment_triage':
      return {
        source: 'Review comment triage',
        description: `GitHub reported unresolved review comments on ${target}. An agent will triage them and get your approval before addressing.`,
      };
    case 'ci_check_fix':
      return {
        source: 'CI check fix',
        description: `GitHub reported failing CI checks on ${target}. An agent will diagnose the failures and push fixes.`,
      };
    case 'merge_queue':
      return {
        source: 'Merge queue',
        description: `The base branch for ${target} uses a merge queue. This chat can add the pull request to the queue, watch it, and help resolve failures.`,
      };
    default:
      return {
        source: 'GitHub',
        description: `An agent will work on ${target}.`,
      };
  }
}

/**
 * The skipped-Mod notice for this chat: its context names the chat and the
 * repository it has selected, so the desktop finds the chat's skills folder.
 */
const ClaudeModsSkippedBlockView = memo(function ClaudeModsSkippedBlockView({
  block,
}: {
  block: Extract<DisplayBlock, { type: 'claude_mods_skipped' }>;
}): JSX.Element {
  const source = useContext(DelegationTranscriptSourceContext);
  const projectId = source?.projectId;
  const worktreeId = source?.worktreeId;
  const chatId = source?.chatId;
  const chatTarget = useMemo(
    () =>
      projectId !== undefined &&
      worktreeId !== undefined &&
      chatId !== undefined
        ? { projectId, worktreeId, chatId }
        : null,
    [projectId, worktreeId, chatId],
  );
  const repoId = useChatTabRenderState(chatTarget, ({ tab }) =>
    tab && tab.kind !== 'file' ? tab.selectedRepoId : undefined,
  );
  const context = useMemo<ClaudeModsChatContext | undefined>(
    () =>
      chatTarget
        ? { ...chatTarget, ...(repoId !== undefined ? { repoId } : {}) }
        : undefined,
    [chatTarget, repoId],
  );
  const onOpenDetails = useCallback(
    (details: ClaudeModPluginDetailsTarget): void =>
      openClaudeModPluginDetails(details),
    [],
  );
  return (
    <ClaudeModsSkippedNoticeView
      mods={block.mods}
      {...(context !== undefined ? { context } : {})}
      onOpenDetails={onOpenDetails}
    />
  );
});

function copyNativeSessionId(id: string): void {
  void copyTextToClipboard(id);
}

/**
 * The delegated-task card with the host's Stop. Only this component reads
 * the stop context, so a change in live delegations re-renders the delegated
 * cards, never the rest of the transcript.
 */
const DelegatedAgentCallCard = memo(function DelegatedAgentCallCard({
  block: committed,
  renderSubBlock,
}: {
  block: Extract<DisplayBlock, { type: 'delegated_agent_call' }>;
  renderSubBlock: (subBlock: DisplayBlock, index: number) => ReactNode;
}): JSX.Element {
  // A logged card's progress and children come from its live snapshots or
  // its delegate log rather than from committed child rows.
  const block = useDelegatedAgentTranscript(committed);
  const hint = useDelegationStreamHint(block);
  const source = useContext(DelegationTranscriptSourceContext);
  const [expanded, setExpanded] = useState(false);
  useExpandedRunInterest(
    source
      ? {
          projectId: source.projectId,
          worktreeId: source.worktreeId,
          chatId: source.chatId,
          delegationId: block.delegationId,
          runGeneration: block.runGeneration,
        }
      : null,
    expanded,
  );
  const stopControls = useContext(ManagedDelegationStopContext);
  const waitingDelegations = useContext(WaitingDelegationsContext);
  const target = stopControls?.target;
  const delegationId = block.delegationId;
  const onOpenChat = useSubagentOpenChatCallback(
    'managed',
    delegationId,
    block.description,
  );
  const live = block.status === 'pending' || block.status === 'running';
  const onStop = useMemo(
    () =>
      target && live
        ? (): Promise<boolean> =>
            requestManagedDelegationStop(target, delegationId)
        : undefined,
    [delegationId, live, target],
  );
  const revision = block.workspaceDiscarded
    ? undefined
    : block.isolatedWorkspace?.revision;
  const onLoadChanges = useMemo(
    () =>
      target && revision
        ? (): Promise<DelegationWorkspaceChanges> =>
            requestManagedDelegationChanges(target, delegationId, revision)
        : undefined,
    [delegationId, revision, target],
  );
  return (
    <ManagedDelegationCard
      delegation={block}
      runGeneration={block.runGeneration}
      onCopyNativeSessionId={copyNativeSessionId}
      onOpenChat={onOpenChat}
      onExpandedChange={setExpanded}
      onStop={onStop}
      onLoadChanges={onLoadChanges}
      hasLiveDescendants={
        stopControls?.withLiveDescendants.has(delegationId) ?? false
      }
      waitingOnParent={waitingDelegations.has(delegationId)}
      {...(source ? { source: transcriptReadSource(source) } : {})}
      hint={hint}
      renderRows={(entries, shown) =>
        renderDelegationChildRows(entries, block, renderSubBlock, shown)
      }
      v2Available={true}
      renderBlock={(entry, row) =>
        renderDelegationChildBlock(entry, row, renderSubBlock)
      }
    >
      {block.subBlocks
        .filter(
          (child) =>
            !(
              child.type === 'text' &&
              child.text.trim() === block.finalText?.trim()
            ),
        )
        .map((child, i) => renderSubBlock(child, i))}
    </ManagedDelegationCard>
  );
});
const LARGE_TRANSCRIPT_MARKDOWN_PROGRESSIVE_OPTIONS = Object.freeze({
  minimumCharacters: 16_000,
  initialBlocks: 6,
  blocksPerFrame: 3,
});

const visualOwners = new WeakMap<ToolResult, ChatVisualOwner>();

/** Share owner identity across ordinary and collapsed visual mounts. */
export function ChatVisualResult({
  result,
  variant,
}: {
  result?: ToolResult;
  variant: 'inline' | 'visual-only';
}): JSX.Element | null {
  if (
    !result ||
    result.isError ||
    !result.visualRef ||
    !result.messageId ||
    !result.toolUseId
  ) {
    return null;
  }
  let owner = visualOwners.get(result);
  if (!owner) {
    owner = {
      messageId: result.messageId,
      toolUseId: result.toolUseId,
      reference: result.visualRef,
    };
    visualOwners.set(result, owner);
  }
  return <ChatVisualBlock owner={owner} variant={variant} />;
}

interface TranscriptProseProps {
  text: string;
  invocableMentionIndex: InvocableMentionIndex | null | undefined;
  filePathMentionIndex: FilePathMentionIndex | null | undefined;
  pluginMentionIndex: PluginMentionIndex | null | undefined;
  originChatTabId: string | undefined;
  markdownOptions: typeof MENTION_MARKDOWN_OPTIONS;
  streaming: boolean;
  progressiveMarkdown: boolean;
  linear: LinearDecoration | null;
  github: GitHubDecoration | null;
}

function TranscriptProse({
  text,
  invocableMentionIndex,
  filePathMentionIndex,
  pluginMentionIndex,
  originChatTabId,
  markdownOptions,
  streaming,
  progressiveMarkdown,
  linear,
  github,
}: TranscriptProseProps): JSX.Element {
  // Smooth streaming (Labs) paces text inside `Markdown`, so a block that
  // mounts streaming with it on stays on that path, even as plain prose,
  // until it unmounts; switching paths at the end would cut its last words
  // short. Decided at mount, like `Markdown`'s own choice.
  const smoothStreaming = useSmoothStreaming();
  const [smoothStreamed] = useState(() => streaming && smoothStreaming);
  const mentionDecorators = useMemo(
    (): MentionDecorators => ({
      invocableIndex: invocableMentionIndex,
      filePathIndex: filePathMentionIndex,
      pluginIndex: pluginMentionIndex,
      originChatTabId,
      linear,
      github,
    }),
    [
      filePathMentionIndex,
      invocableMentionIndex,
      pluginMentionIndex,
      originChatTabId,
      linear,
      github,
    ],
  );
  return (
    <div className={TRANSCRIPT_PROSE_CLASS}>
      {!smoothStreamed && canRenderAsPlainParagraph(text) ? (
        <p>
          {decorateMentionChildren(
            text,
            invocableMentionIndex,
            filePathMentionIndex,
            pluginMentionIndex,
            'p',
            originChatTabId,
            linear,
            github,
          )}
        </p>
      ) : (
        <MentionDecoratorsContext.Provider value={mentionDecorators}>
          <Markdown
            options={markdownOptions}
            streaming={streaming}
            progressive={
              progressiveMarkdown && !streaming
                ? LARGE_TRANSCRIPT_MARKDOWN_PROGRESSIVE_OPTIONS
                : undefined
            }
          >
            {text}
          </Markdown>
        </MentionDecoratorsContext.Provider>
      )}
    </div>
  );
}

/**
 * Smooth-streamed prose: one component whether or not the block has settled,
 * decorating what its candidates allow once it has.
 */
function SmoothTranscriptProse({
  linearCandidates,
  githubCandidates,
  ...props
}: TranscriptProseProps & {
  linearCandidates: LinearCandidates | null;
  githubCandidates: GitHubCandidates | null;
}): JSX.Element {
  const target = useContext(ChatMarkdownFileTargetContext);
  return (
    <TranscriptProse
      {...props}
      linear={useLinearDecoration(linearCandidates)}
      github={useGitHubDecoration(githubCandidates, target)}
    />
  );
}

/** Settled prose with GitHub candidates: decorate what the origin allows. */
function GitHubTranscriptProse({
  candidates,
  ...props
}: TranscriptProseProps & { candidates: GitHubCandidates }): JSX.Element {
  const target = useContext(ChatMarkdownFileTargetContext);
  return (
    <TranscriptProse
      {...props}
      github={useGitHubDecoration(candidates, target)}
    />
  );
}

/** Settled prose with Linear candidates: decorate what the catalog allows. */
function LinearTranscriptProse({
  candidates,
  githubCandidates,
  ...props
}: TranscriptProseProps & {
  candidates: LinearCandidates;
  githubCandidates: GitHubCandidates | null;
}): JSX.Element {
  const linear = useLinearDecoration(candidates);
  return githubCandidates ? (
    <GitHubTranscriptProse
      {...props}
      linear={linear}
      candidates={githubCandidates}
    />
  ) : (
    <TranscriptProse {...props} linear={linear} />
  );
}

export const ChatBlockRenderer = memo(function ChatBlockRenderer({
  block,
  streaming = false,
  chatPendingQuestions = EMPTY_PENDING,
  invocableMentionIndex,
  filePathMentionIndex,
  pluginMentionIndex,
  originChatTabId,
  originMessageId,
  isCodeReviewChat,
  stripAgentCitations = false,
  isSystemMessage = false,
  preserveLineBreaks = false,
  progressiveMarkdown = false,
  settled = !streaming,
  turnSettled = false,
}: {
  block: DisplayBlock;
  streaming?: boolean;
  chatPendingQuestions?: PendingQuestion[];
  invocableMentionIndex?: InvocableMentionIndex | null;
  filePathMentionIndex?: FilePathMentionIndex | null;
  /**
   * Whole-plugin `@` mentions of THIS message (built from its
   * `file_references` block), rendered as inline chips.
   */
  pluginMentionIndex?: PluginMentionIndex | null;
  originChatTabId?: string;
  originMessageId?: string;
  /** True inside a Code Review sidecar chat — forwarded to `ToolCallBlock`
   * so the shared plan/review comment tools pick the code-flavored icon. */
  isCodeReviewChat?: boolean;
  /** Strip opaque provider citation markers from assistant-authored text. */
  stripAgentCitations?: boolean;
  /** Enables narrowly classified recovery UI for host-generated errors. */
  isSystemMessage?: boolean;
  /**
   * Render single newlines in text blocks as line breaks (CAN-2811). Set for
   * user-authored bubbles, where a typed newline is deliberate; agent prose
   * keeps standard markdown soft-break handling.
   */
  preserveLineBreaks?: boolean;
  /** Progressively commit top-level blocks for large, completed transcript text. */
  progressiveMarkdown?: boolean;
  /**
   * The block's text is final, so references may be decorated. Defaults to
   * `!streaming`; a streaming turn's earlier blocks pass `true`.
   */
  settled?: boolean;
  /**
   * The owning turn is authoritatively settled, so a tool call with no
   * result renders interrupted rather than pending.
   */
  turnSettled?: boolean;
}): JSX.Element | null {
  const cleanChatLook = useCleanChatLook();
  // Smooth streaming (Labs): a text block that mounts streaming with it on
  // renders through one component for its lifetime, so settling (a later
  // block arriving) never re-mounts it and restarts or cuts its reveal.
  const smoothStreaming = useSmoothStreaming();
  const [smoothTextBlock] = useState(
    () => block.type === 'text' && streaming && smoothStreaming,
  );
  const textMarkdownOptions = preserveLineBreaks
    ? MENTION_MARKDOWN_OPTIONS_WITH_LINE_BREAKS
    : MENTION_MARKDOWN_OPTIONS;
  const blockText = block.type === 'text' ? block.text : '';
  // Pure scans, once per settled text; prose without reference candidates
  // never reads preview state.
  const linearCandidates = useMemo(
    () => (settled ? scanLinearCandidates(blockText) : null),
    [blockText, settled],
  );
  const githubCandidates = useMemo(
    () => (settled ? scanGitHubCandidates(blockText) : null),
    [blockText, settled],
  );
  // Recursive sub-block renderer passed down to AgentBlock so the AgentBlock
  // module does not need to import ChatBlockRenderer (which would create a
  // mutually-recursive import cycle). Same chatPendingQuestions is propagated
  // so nested ask-user prompts continue to resolve correctly. Tool-approval
  // prompts no longer thread through here — they render in `ToolApprovalDock`
  // above the composer instead of anchoring to a transcript block.
  const renderSubBlock = (
    subBlock: DisplayBlock,
    index: number,
  ): JSX.Element | null => (
    <ChatBlockRenderer
      key={getDisplayBlockKey(subBlock, index)}
      block={subBlock}
      streaming={streaming}
      settled={settled}
      chatPendingQuestions={chatPendingQuestions}
      invocableMentionIndex={invocableMentionIndex}
      filePathMentionIndex={filePathMentionIndex}
      pluginMentionIndex={pluginMentionIndex}
      originChatTabId={originChatTabId}
      originMessageId={originMessageId}
      isCodeReviewChat={isCodeReviewChat}
      stripAgentCitations={stripAgentCitations}
      isSystemMessage={subBlock.isSystemMessage ?? isSystemMessage}
    />
  );

  if (block.type === 'tool_use' && block.result?.fullOutputRef) {
    return (
      <>
        <ToolCallBlock
          originChatTabId={originChatTabId}
          originMessageId={originMessageId}
          toolName={block.toolName}
          toolUseId={block.toolUseId}
          input={block.input}
          result={block.result}
          resolvedRecipient={block.resolvedRecipient}
          isCodeReviewChat={isCodeReviewChat}
        />
        <ChatVisualResult result={block.result} variant="inline" />
      </>
    );
  }
  switch (block.type) {
    case 'mcp_activation':
      return null;
    case 'file_references':
      return null;

    case 'image':
      return (
        <ChatImageBlock
          path={block.path}
          dataUrl={block.dataUrl}
          alt={block.alt}
        />
      );

    case 'text': {
      if (block.providerErrorDetails !== undefined) {
        return (
          <div data-chat-notice>
            <ErrorBanner
              error={block.text}
              details={block.providerErrorDetails}
              testId="chat-provider-error"
            />
          </div>
        );
      }
      if (isClaudeAiCreditsFallbackErrorCode(block.errorCode)) {
        return <ClaudeAiCreditsFallbackError />;
      }
      if (block.asyncQuestionAnswer) {
        const { answers } = block.asyncQuestionAnswer;
        const displayAnswers: AnsweredQuestionDisplay[] = answers.map(
          (answer) => ({
            question: answer.question,
            answer: answer.selectedOptions.join(', '),
            ...(answer.freeformText ? { additional: answer.freeformText } : {}),
          }),
        );
        return (
          <>
            {/* Clean chat look: the answers card says it all; the question
                step itself folds into the work line before it. */}
            {!cleanChatLook && (
              <ToolCallBlock
                originChatTabId={originChatTabId}
                originMessageId={originMessageId}
                toolName="AskUserQuestion"
                input={JSON.stringify({
                  questions: answers.map((answer) => ({
                    question: answer.question,
                  })),
                })}
                result={{ output: block.text, isError: false }}
                label={askUserQuestionRowLabel({
                  count: answers.length,
                  answers: displayAnswers,
                })}
              />
            )}
            <AnsweredQuestionsBlock answers={displayAnswers} />
          </>
        );
      }
      if (block.asyncQuestion) {
        const pending = chatPendingQuestions.find(
          (question) => question.requestId === block.asyncQuestion?.requestId,
        );
        if (pending && pending.dismissedAt === undefined) {
          // Active controls live above the composer; completed answers stay here.
          return null;
        }
      }
      if (block.verbatim) {
        return (
          <pre
            data-testid="chat-verbatim-text"
            className="max-w-none whitespace-pre-wrap break-words rounded-md bg-fg-primary/[0.06] px-3 py-2 text-s fg-primary/80"
          >
            {block.text}
          </pre>
        );
      }
      const text = stripAgentCitations
        ? stripProposedPlanEnvelope(stripOpaqueAgentCitationMarkers(block.text))
        : block.text;
      // A Codex turn the ChatGPT account was refused for its model (CAN-4716).
      // Structured, validated data stamped from the terminal event (or restored
      // from a Portal part or import), so not gated on `isSystemMessage`; the
      // raw `Error:` text is not rendered for it. The action re-checks live
      // tab state before it resends.
      if (block.modelAccessFailure) {
        return (
          <CodexAccountModelNoticeAction
            failure={block.modelAccessFailure}
            originChatTabId={originChatTabId}
            sourceText={block.text}
          />
        );
      }
      // Checked BEFORE the harness-connection check: a structured AI Credits
      // proxy failure gets its own notice, and its `credentials_unavailable`
      // case must not fall through to a provider sign-in CTA. A body without
      // the proxy marker parses to `null` and keeps today's rendering, so this
      // is the single switch between the two paths.
      // The desktop's own account proxy failure: only proxy settings fix it.
      if (isSystemMessage && isAccountProxySettingsFailure(text)) {
        return <AccountProxyFailureNoticeAction text={text} />;
      }
      const proxyError = isSystemMessage ? parseCanopyProxyError(text) : null;
      // Nothing could pay for the message (CAN-5160). The composer's No
      // billing source banner is where the user chooses how to pay, so the
      // transcript only says why the chat stopped.
      if (proxyError?.code === 'no_billing_source') {
        return <AiCreditsStopLine />;
      }
      if (proxyError) {
        return (
          <CanopyProxyErrorNotice
            error={proxyError}
            originChatTabId={originChatTabId}
            // Raw block text, NOT the citation-stripped `text` above: this is
            // the notice's identity in the transcript, and it must compare
            // equal to the persisted message block it was rendered from.
            sourceText={block.text}
          />
        );
      }
      // Structured data (CAN-1814) wins over the text heuristic below, and is
      // NOT gated on `isSystemMessage`: main attached this verdict to the
      // block itself, so there is nothing to guess at. Re-validated here for
      // the same reason `ToolCallBlock` re-validates — the persisted read path
      // passes `authFailure` through unchecked, so a hand-edited chat file
      // could otherwise pair a non-recoverable class with a login recovery.
      const structuredAuthFailures = readAuthDependencyFailures(block).failures;
      if (structuredAuthFailures.length > 0) {
        return (
          <AuthRecoveryCard
            failures={structuredAuthFailures}
            originChatTabId={originChatTabId}
            sourceMessageId={originMessageId}
          />
        );
      }
      const connectionProvider = isSystemMessage
        ? getHarnessConnectionProvider(text)
        : null;
      if (connectionProvider) {
        return (
          <AuthRecoveryCard
            failures={[legacyProviderAuthFailure(connectionProvider, text)]}
          />
        );
      }
      // Clean chat look: the app's own messages read as a quiet note, not as
      // the agent talking.
      if (cleanChatLook && isSystemMessage) {
        return <ChatAppNote text={text} />;
      }
      const proseProps: TranscriptProseProps = {
        text,
        invocableMentionIndex,
        filePathMentionIndex,
        pluginMentionIndex,
        originChatTabId,
        markdownOptions: textMarkdownOptions,
        streaming,
        progressiveMarkdown,
        linear: null,
        github: null,
      };
      if (smoothTextBlock) {
        return (
          <SmoothTranscriptProse
            {...proseProps}
            linearCandidates={linearCandidates}
            githubCandidates={githubCandidates}
          />
        );
      }
      if (linearCandidates) {
        return (
          <LinearTranscriptProse
            {...proseProps}
            candidates={linearCandidates}
            githubCandidates={githubCandidates}
          />
        );
      }
      return githubCandidates ? (
        <GitHubTranscriptProse {...proseProps} candidates={githubCandidates} />
      ) : (
        <TranscriptProse {...proseProps} />
      );
    }

    case 'thinking':
      if (block.text.trim().length === 0) {
        return null;
      }
      return (
        <CollapsibleBlock
          label="Thinking"
          doneLabel="Thought"
          running={!settled}
          content={block.text}
        />
      );

    case 'tool_use': {
      if (block.toolName === 'ExitPlanMode') {
        const plan = extractExitPlanModePlan(block.input);
        if (!plan) return null;
        return (
          <div className={TRANSCRIPT_PROSE_CLASS}>
            <Markdown options={MARKDOWN_OPTIONS} streaming={streaming}>
              {plan}
            </Markdown>
          </div>
        );
      }

      if (block.toolName === 'EnterPlanMode') return null;

      if (block.toolName === 'Skill') {
        let skillName = 'skill';
        let rawCommand = '';
        try {
          const p = JSON.parse(block.input) as Record<string, unknown>;
          if (typeof p.skill === 'string') skillName = p.skill;
          if (typeof p.raw_command === 'string') rawCommand = p.raw_command;
        } catch {
          // ignore
        }
        if (rawCommand.length > 0) {
          return (
            <ToolCallBlock
              originChatTabId={originChatTabId}
              originMessageId={originMessageId}
              toolName={block.toolName}
              toolUseId={block.toolUseId}
              input={block.input}
              result={block.result}
              turnSettled={turnSettled}
            />
          );
        }
        // Only a name the inventory resolves becomes a details button; an
        // unknown name stays plain text rather than guessing a target.
        const skillTarget = findInvocableMentionTarget(
          invocableMentionIndex,
          skillName,
        );
        return (
          <div className="flex items-center gap-1.5 py-1 text-xs fg-secondary">
            <span className="flex-shrink-0">
              <SkillIcon />
            </span>
            <span className="inline-flex items-center gap-2.5">
              <span>
                Using skill{' '}
                {skillTarget ? (
                  <InvocableDetailsButton target={skillTarget}>
                    {skillName}
                  </InvocableDetailsButton>
                ) : (
                  <code className="rounded bg-fg-primary/[0.08] px-1 py-0.5 font-mono text-2xs">
                    {skillName}
                  </code>
                )}
              </span>
              {!block.result && (
                <ThinkingSpinner tone="accent" className="flex-shrink-0" />
              )}
            </span>
          </div>
        );
      }

      if (isAskUserQuestionToolName(block.toolName)) {
        // The shared resolver owns precedence between the tool result and the
        // chat's question record (see `ask-user-question-presentation.ts`).
        // A restored question whose turn ended can lack a result, or carry a
        // synthetic `Cancelled` one; its answered record still settles it.
        const resultAnswers =
          block.result && !block.result.isError
            ? parseAnsweredQuestions(block.input, block.result.output)
            : null;
        const resultEvidence: AskUserQuestionResultEvidence = !block.result
          ? { kind: 'none' }
          : block.result.isError
            ? { kind: 'error' }
            : resultAnswers && resultAnswers.length > 0
              ? { kind: 'answers', answers: resultAnswers }
              : { kind: 'other' };
        const presentation = resolveAskUserQuestionPresentation(
          resultEvidence,
          findAskUserQuestionRecordState(
            chatPendingQuestions,
            block.toolName,
            block.toolUseId,
            block.input,
          ),
        );
        switch (presentation.kind) {
          case 'awaiting':
            // The composer owns the unanswered prompt.
            return null;
          case 'preparing':
            return (
              <div
                className="flex items-center gap-1.5 py-1 text-xs fg-secondary"
                data-testid="ask-user-question-preparing"
              >
                <ThinkingSpinner tone="accent" />
                <span>Preparing question…</span>
              </div>
            );
          case 'answered':
            return (
              <>
                {!cleanChatLook && (
                  <ToolCallBlock
                    originChatTabId={originChatTabId}
                    originMessageId={originMessageId}
                    toolName={block.toolName}
                    toolUseId={block.toolUseId}
                    input={block.input}
                    result={block.result}
                    label={askUserQuestionRowLabel({
                      count: askUserQuestionCount(block.input),
                      answers: presentation.answers,
                    })}
                    status={presentation.status}
                  />
                )}
                <AnsweredQuestionsBlock answers={presentation.answers} />
              </>
            );
          case 'settled':
            return (
              <ToolCallBlock
                originChatTabId={originChatTabId}
                originMessageId={originMessageId}
                toolName={block.toolName}
                toolUseId={block.toolUseId}
                input={block.input}
                result={block.result}
                status={presentation.status}
              />
            );
          case 'result':
            // Errors and other results use the generic tool row below.
            break;
        }
      }

      return (
        <>
          <ToolCallBlock
            originChatTabId={originChatTabId}
            originMessageId={originMessageId}
            toolName={block.toolName}
            toolUseId={block.toolUseId}
            input={block.input}
            result={block.result}
            resolvedRecipient={block.resolvedRecipient}
            isCodeReviewChat={isCodeReviewChat}
            turnSettled={turnSettled}
          />
          <ChatVisualResult result={block.result} variant="inline" />
        </>
      );
    }

    case 'delegated_agent_call':
      return (
        <DelegatedAgentCallCard block={block} renderSubBlock={renderSubBlock} />
      );
    case 'agent':
      return (
        <AgentBlock
          toolUseId={block.toolUseId}
          chatId={originChatTabId}
          subagentIdentity={{
            kind: 'claude-native',
            id: block.toolUseId,
            title: block.description,
          }}
          subagentType={block.subagentType}
          description={block.description}
          prompt={block.prompt}
          runInBackground={block.runInBackground}
          result={block.result}
          taskOutputResult={block.taskOutputResult}
          subBlocks={block.subBlocks}
          usage={block.usage}
          nativeTaskStop
          renderSubBlock={renderSubBlock}
        />
      );

    case 'workflow':
      return (
        <WorkflowBlock
          toolUseId={block.toolUseId}
          workflowName={block.workflowName}
          summary={block.summary}
          runId={block.runId}
          transcriptDir={block.transcriptDir}
          result={block.result}
        />
      );

    case 'codex_agent': {
      // Codex `codex_agent` blocks never produce a Claude-shaped tool_result,
      // so we drive the AgentBlock spinner / error label off `status` and
      // `agentsStates` via the `*Override`props. Without these the spinner
      // would be permanent (Phase F3 §4).
      const { running: isRunningOverride, error: isErrorOverride } =
        codexAgentState(block);
      return (
        <AgentBlock
          subagentIdentity={{
            kind: 'codex-native',
            id: block.receiverThreadIds[0] ?? block.agentBlockId,
            title: block.description || block.displayName,
          }}
          subagentType={block.displayName}
          description={block.description}
          prompt={block.prompt}
          model={block.model}
          reasoningEffort={block.reasoningEffort}
          runInBackground={false}
          subBlocks={block.subBlocks}
          usage={block.usage}
          isRunningOverride={isRunningOverride}
          isErrorOverride={isErrorOverride}
          renderSubBlock={renderSubBlock}
        />
      );
    }

    case 'turn_timer':
      return (
        <TurnTimer
          startedAt={block.startedAt}
          pausedAt={block.pausedAt}
          resumedAt={block.resumedAt}
          accumulatedPausedDurationMs={block.accumulatedPausedDurationMs}
          completedAt={block.completedAt}
          // Inline timer blocks (subagent transcripts, standalone messages)
          // are not a turn's footer and have no `group/turn` scope to reveal
          // them, so they stay visible at rest (CAN-4278).
          alwaysVisible
        />
      );

    case 'wake_boundary':
      // `ChatMessageItem` renders a wake's head row, with its turn link.
      return null;

    case 'hook_info':
      return (
        <HookInfoBanner
          triggerName={block.triggerName}
          timestamp={block.timestamp}
          originChatTabId={originChatTabId}
        />
      );

    case 'automation_info': {
      const localTime = new Date(block.timestamp).toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
      });
      return (
        <Surface variant="group" data-testid="chat-automation-info">
          <div className="flex items-center gap-2 px-3 py-1.5 text-xs fg-secondary">
            <AppCatalogTimeFliesIcon size="sm" className="flex-shrink-0" />
            <span>
              Chat initiated by automation
              {block.activityName ? (
                <>
                  {' '}
                  <strong>{block.activityName}</strong>
                </>
              ) : null}{' '}
              at {localTime}
            </span>
          </div>
        </Surface>
      );
    }

    case 'claude_terminal_sync_warning': {
      const localTime = new Date(block.timestamp).toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
      });
      return (
        <Notice
          role="none"
          intent="attention"
          title={
            <>
              Claude Code transcript sync failed{' '}
              <span className="fg-secondary">at {localTime}</span>
            </>
          }
        >
          {block.message ??
            'This fork is still usable, but it may be missing the latest terminal output.'}
        </Notice>
      );
    }

    case 'account_proxy_switch':
      return (
        <AccountProxySwitchLine
          account={block.account}
          {...(block.previousAccount !== undefined
            ? { previousAccount: block.previousAccount }
            : {})}
          {...(block.previousAtLimit === true ? { previousAtLimit: true } : {})}
        />
      );

    case 'claude_mods_skipped':
      return <ClaudeModsSkippedBlockView block={block} />;

    case 'compaction_info': {
      // Compaction banner copy is keyed off both provider and interface mode
      // so native Codex events do not inherit the Claude-specific fallback;
      // the rule is shared with the portal transcript. The block is
      // append-only — earlier transcript content is never rewritten by the
      // renderer.
      const headline = compactionHeadline(block.provider, block.interfaceMode);
      return (
        <CompactionInfoBlock
          headline={headline}
          timestamp={block.timestamp}
          summary={block.summary}
        />
      );
    }

    case 'pending_setup_info':
      // Older persisted transcripts still contain this supported legacy
      // block. It read as a setup error, so it is no longer shown; the queued
      // bubble explains a setup wait while it happens.
      return null;

    case 'approval_safety_denied_info':
      // Placed after its denied tool row by `placeSafetyDenialReceipts`;
      // unmatched receipts render where they were committed.
      return (
        <ApprovalSafetyDeniedNotice
          reason={block.reason}
          command={block.command}
        />
      );

    // A pending approval card was released without a click because the user
    // widened the chat's approval mode while it was on screen (CAN-3083).
    // Quiet by design: the user already made this decision in the composer,
    // so this is a receipt, not a thing to act on.
    case 'approval_resolution_info': {
      const localTime = new Date(block.timestamp).toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
      });
      const modeLabel = APPROVAL_MODE_PROSE_LABELS[block.mode];
      const requestCount = block.titles.length;
      // Only claim a switch when one is actually recorded. Main omits
      //`previousMode` when it cannot name a real widening — the live-authority
      // clamp settled on the mode the chat was already in or on a narrower
      // one, or the registration-window fallback had no prior mode stashed.
      // Saying "by switching to" there would describe a transition that did
      // not happen.
      //
      // Note this is a mode-direction test, not an authority test. A rule that
      // landed while the card sat there can be what granted the allow, and a
      // genuine widening around it still reports `previousMode` and still
      // reads "by switching to" — intended, since without the widening the
      // card would still be standing. The `approval_decision` diagnostic
      // carries the real granting tier for the audit trail.
      const releasedBySwitch = block.previousMode !== undefined;
      const summary = releasedBySwitch
        ? requestCount > 1
          ? `Approved ${requestCount} requests by switching to ${modeLabel}`
          : `Approved by switching to ${modeLabel}`
        : requestCount > 1
          ? `Approved ${requestCount} requests under ${modeLabel}`
          : `Approved under ${modeLabel}`;
      return (
        <Notice
          role="none"
          intent="neutral"
          title={
            <>
              {summary} <span className="fg-secondary">at {localTime}</span>
            </>
          }
        >
          {requestCount === 0 ? null : (
            <ul className="flex flex-col list-none gap-0.5">
              {block.titles.map((title, titleIndex) => (
                <li
                  key={`${titleIndex}:${title}`}
                  className="fg-secondary truncate font-mono text-xs"
                  title={title}
                >
                  {title}
                </li>
              ))}
            </ul>
          )}
        </Notice>
      );
    }

    case 'revert_info': {
      const localTime = new Date(block.timestamp).toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
      });
      const fileCount = block.files.length;
      const fileSummary =
        fileCount === 0
          ? 'No tracked file changes'
          : `${fileCount} file${fileCount === 1 ? '' : 's'} (+${block.totalInsertions}, -${block.totalDeletions})`;
      return (
        <Notice
          role="none"
          intent="attention"
          icon={<RevertIcon size={16} aria-hidden="true" />}
          title={
            <>
              Reverted prior turn{' '}
              <span className="fg-secondary">at {localTime}</span>
            </>
          }
        >
          Rolled back {fileSummary}.
          {block.attachmentPath
            ? ' Summary attached to next message.'
            : ' Summary could not be attached.'}
        </Notice>
      );
    }

    // Note: the raw `codex_agent_call` block never reaches this renderer —
    // `mergeToolResults` folds it into the `codex_agent` display variant
    // before grouping. The `case 'codex_agent'` arm above handles it.

    case 'rebase_resolution_info': {
      const localTime = new Date(block.timestamp).toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
      });
      const title =
        block.kind === 'rebase_conflict'
          ? 'Chat initiated to resolve rebase conflicts'
          : 'Chat initiated to resolve stash-pop conflicts';
      const description =
        block.kind === 'rebase_conflict'
          ? `"git pull --rebase --autostash" left ${block.repoName} (branch "${block.branchName}") in a rebasing state.`
          : `"git pull --rebase --autostash" completed the rebase on ${block.repoName} (branch "${block.branchName}") but could not re-apply the autostashed changes.`;
      return (
        <Notice
          role="none"
          intent="attention"
          title={
            <>
              {title} <span className="fg-secondary">at {localTime}</span>
            </>
          }
        >
          {description}
        </Notice>
      );
    }

    case 'builtin_gh_chat_info': {
      const localTime = new Date(block.timestamp).toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
      });
      const target =
        block.repoName && block.branchName
          ? `${block.repoName} (branch "${block.branchName}")`
          : (block.repoName ?? 'this pull request');
      const { source, description } = builtinGhChatBannerCopy(
        block.kind,
        target,
      );
      return (
        <Surface variant="group">
          <div className="flex items-start gap-2 px-3 py-1.5 text-xs fg-secondary">
            <AppCatalogInfoIcon size="sm" className="mt-0.5 flex-shrink-0" />
            <div className="flex flex-col gap-0.5">
              <div>
                Chat initiated by <strong>{source}</strong> at {localTime}
              </div>
              <div>{description}</div>
            </div>
          </div>
        </Surface>
      );
    }
  }
});
