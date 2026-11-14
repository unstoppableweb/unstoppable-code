import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
  type JSX,
  type ReactNode,
} from 'react';
import type { ChatDetail } from '@canopy/protocol/chat-detail';
import { buttonClassName } from './Button';

/**
 * The contexts that shape how transcript parts draw. Every host draws the
 * one chat look, which reads like the Codex, ChatGPT and Claude Code
 * transcripts:
 * - a turn opens with "Working for 28s", then "Worked for 3m 24s", which
 *   folds the steps away once the turn is done;
 * - every step (tool call, group, thinking, helper agent, changed files) is
 *   the same quiet `StepRow`: an icon at the text's size and color and plain
 *   stable action words ("Run git status", "Read file.ts") and separate outcomes;
 * - runs of steps read as words ("Ran commands, read files");
 * - work in progress shimmers its words instead of showing a spinner, and
 *   the only colors left are a diff's added and removed line counts.
 * Hosts provide the product name (`ChatAppNameProvider`) and chat detail
 * (`ChatDetailProvider`) at their root; step rows set their tense
 * (`StepTenseProvider`) and badge line (`StepBadgeLine`).
 */

const ChatAppNameContext = createContext<string | undefined>(undefined);

/**
 * The product name transcript markers use ("… closed · resumed 9:41 AM",
 * "Interrupted when … closed"). This shared package cannot know the active
 * brand, so each host provides it once at its root.
 */
export function ChatAppNameProvider({
  value,
  children,
}: {
  readonly value: string | undefined;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <ChatAppNameContext.Provider value={value}>
      {children}
    </ChatAppNameContext.Provider>
  );
}

export function useChatAppName(): string | undefined {
  return useContext(ChatAppNameContext);
}

// Without a host choice every step keeps its own row.
const ChatDetailContext = createContext<ChatDetail>('detailed');

/**
 * How much of an agent's work the transcript shows (Appearance → "Chat
 * detail", see `ChatDetail`). Hosts provide the saved choice (or
 * `DEFAULT_CHAT_DETAIL`) once at their root; parts read it with
 * `useChatDetail`.
 */
export function ChatDetailProvider({
  value,
  children,
}: {
  readonly value: ChatDetail;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <ChatDetailContext.Provider value={value}>
      {children}
    </ChatDetailContext.Provider>
  );
}

export function useChatDetail(): ChatDetail {
  return useContext(ChatDetailContext);
}

/**
 * Completed turns open folded. Detailed work also folds when it finishes
 * on screen; Compact and Recent keep their between-reply groups in place.
 * Collapse only on that transition so a reader can reopen a completed turn.
 */
export function useTurnCollapse(
  complete: boolean,
  detail: ChatDetail,
): readonly [boolean, Dispatch<SetStateAction<boolean>>] {
  const [collapsed, setCollapsed] = useState(complete);
  const wasComplete = useRef(complete);
  useEffect(() => {
    if (!wasComplete.current && complete && detail === 'detailed') {
      setCollapsed(true);
    }
    wasComplete.current = complete;
  }, [complete, detail]);
  return [collapsed, setCollapsed];
}

/**
 * Whether the transcript folds the work between two replies into one line:
 * every chat detail but `detailed`.
 */
export function useGroupToolCalls(): boolean {
  return useContext(ChatDetailContext) !== 'detailed';
}

/** Set by a step row around the words of its badge line. */
const StepBadgeLineContext = createContext(false);

/** Marks a step row's badge line, where code badges can shrink. */
export function StepBadgeLine({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <StepBadgeLineContext.Provider value>
      {children}
    </StepBadgeLineContext.Provider>
  );
}

/** Code badges in step rows are retired; labels keep plain inline details. */
export function useStepBadges(): boolean {
  return false;
}

/**
 * A turn's icon button (copy, fork, "•••", thumbs,
 * watch): the shared quiet ghost `Button`'s 28px capsule, its 14px icon in
 * tertiary ink at a 1.5px stroke, full ink on hover, focus, open and
 * pressed. Prefer `<Button variant={CLEAN_ICON_BUTTON_VARIANT} size="sm"
 * iconOnly>`; this is the same recipe for a control that must stay a plain
 * `<button>`.
 */
export const CLEAN_ICON_BUTTON_VARIANT = 'ghost-quiet';
export const CLEAN_FOOTER_ICON_BUTTON_CLASS = buttonClassName({
  variant: CLEAN_ICON_BUTTON_VARIANT,
  size: 'sm',
  iconOnly: true,
});

/**
 * Whether a step is done, still running, failed, was blocked before it ran,
 * or was interrupted or is waiting for approval. Status changes do not
 * change the stable action label.
 */
export type StepTense =
  | 'done'
  | 'running'
  | 'failed'
  | 'blocked'
  | 'interrupted'
  | 'waiting';

// No tense outside a step (a drawer listing an agent's steps): labels then
// read without claiming the step ran or is running.
const StepTenseContext = createContext<StepTense | null>(null);

export function StepTenseProvider({
  value,
  children,
}: {
  readonly value: StepTense;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <StepTenseContext.Provider value={value}>
      {children}
    </StepTenseContext.Provider>
  );
}

export function useStepTense(): StepTense | null {
  return useContext(StepTenseContext);
}
