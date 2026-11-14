/**
 * Next prompt suggestions: after a completed turn, the provider's prediction
 * of the person's next message. The empty composer shows it as its
 * placeholder, Tab fills it in, and Escape dismisses it. These rules are
 * shared so every composer offers and accepts a suggestion the same way; the
 * host only decides where suggestions come from.
 */

/** One suggestion, and the user message of the turn it follows. */
export interface PromptSuggestion {
  text: string;
  turnUserMessageId: string;
}

export interface PromptSuggestionOfferInput {
  suggestion: PromptSuggestion | null | undefined;
  /** Escape dismissed this suggestion. */
  dismissed: boolean;
  /** The chat's newest user message; a later turn makes the suggestion stale. */
  latestUserMessageId: string | undefined;
  /**
   * The draft has no text, whitespace included, and no file references: the
   * editor hides its placeholder, and so the suggestion, for any text.
   */
  draftEmpty: boolean;
  /**
   * The composer shows its default placeholder: the chat is idle, and no
   * question, plan, approval, queued edit, dictation or terminal mode owns it.
   */
  showsDefaultPlaceholder: boolean;
}

/** The suggestion text the composer offers now, or null. */
export function offeredPromptSuggestion(
  input: PromptSuggestionOfferInput,
): string | null {
  const { suggestion } = input;
  if (
    !suggestion ||
    input.dismissed ||
    !input.draftEmpty ||
    !input.showsDefaultPlaceholder ||
    input.latestUserMessageId !== suggestion.turnUserMessageId
  )
    return null;
  return suggestion.text;
}

export interface PromptSuggestionKeyEvent {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  /** Present on native keyboard events; true while an IME composes. */
  isComposing?: boolean;
}

/**
 * What a key does to an offered suggestion. Call it only after menus and
 * typeaheads have had the key, so their Tab and Escape keep working. Tab
 * accepts and Escape dismisses, with no modifier held and no IME composition
 * active; any other key, or no offered suggestion, does nothing, so Tab keeps
 * moving focus.
 */
export function promptSuggestionKeyAction(
  event: PromptSuggestionKeyEvent,
  offered: boolean,
): 'accept' | 'dismiss' | null {
  if (
    !offered ||
    event.isComposing === true ||
    event.shiftKey ||
    event.altKey ||
    event.metaKey ||
    event.ctrlKey
  )
    return null;
  if (event.key === 'Tab') return 'accept';
  if (event.key === 'Escape') return 'dismiss';
  return null;
}
