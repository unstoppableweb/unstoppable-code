//! Chat copy: the read path (P5a), from `device_link/chats/{repository,
//! presentation,settings}.dart` and `device_link/protocol.dart`
//! (`deviceLinkObject`); sends, creation and attachments (P5b), from
//! `device_link/chats/{dart_sender,dart_attachments}.dart`. The words the shared feed widgets draw (run words,
//! tool labels, turn durations) stay in Dart with those widgets.
use cc_domain::feed::FeedText;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CopyKey {
    /// A chat was opened while the computer is not connected.
    ReconnectFirst,
    /// A chat read failed for a reason the transport does not word.
    ReadFailed,
    /// A reply did not have the shape the reader requires.
    InvalidMessage,
    /// An older page was read at another transcript revision.
    HistoryChanged,
    /// A tab command was refused without a reason.
    CommandRefused,
    /// A tool call failed without output.
    ToolError,
    /// A block or reference the phone does not show.
    AdditionalContent,
    /// A tab without a title.
    ChatFallback,
    /// A send before the chat is ready, to a closed chat or during a send.
    SendNotReady,
    /// A send without text or files, or with too much text.
    SendTooLong,
    /// A new send while another is unconfirmed.
    PreviousUnconfirmed,
    /// A retry from another chat or of other text.
    OpenOriginalToRetry,
    /// A send for a chat that is no longer the selected one.
    ChatChanged,
    /// The desktop refused a send for a provider sign-in.
    ProviderSignInRequired,
    /// A refused send: `{reason}` is the desktop's words.
    RefusedCheckDelivery,
    /// A send whose outcome is unknown.
    MayHaveReached,
    /// The unconfirmed send's chat closed.
    OriginalClosed,
    /// A new chat in a workspace the catalog does not list.
    ChooseWorkspace,
    /// The desktop did not apply a new chat or tab.
    CouldNotCreate,
    /// A new chat finished after its selection or session changed.
    FindNewChat,
    /// The title of a created chat.
    NewChat,
    /// An attachment import without a stored file.
    FileNotStored,
}

pub(crate) fn text(key: CopyKey) -> &'static str {
    match key {
        CopyKey::ReconnectFirst => "Reconnect to your computer first.",
        CopyKey::ReadFailed => "Could not read the chat from your computer. Try again.",
        CopyKey::InvalidMessage => "The peer sent an invalid message.",
        CopyKey::HistoryChanged => "The history changed. Load older messages again.",
        CopyKey::CommandRefused => {
            "The computer could not complete this action. Refresh and try again."
        }
        CopyKey::ToolError => "Error",
        CopyKey::AdditionalContent => "Additional content is available on your computer.",
        CopyKey::ChatFallback => "Chat",
        CopyKey::SendNotReady => "Wait for this chat to be ready.",
        CopyKey::SendTooLong => "Enter a message shorter than 32,000 characters.",
        CopyKey::PreviousUnconfirmed => "Check the previous message before sending another.",
        CopyKey::OpenOriginalToRetry => "Open the original chat to retry this message.",
        CopyKey::ChatChanged => {
            "This chat is no longer open. Try again to send your message to it."
        }
        CopyKey::ProviderSignInRequired => {
            "Sign in to the required provider on your computer, then try again."
        }
        CopyKey::RefusedCheckDelivery => "{reason} Check delivery before retrying this message.",
        CopyKey::MayHaveReached => {
            "The message may have reached your computer. Check delivery or retry the same message."
        }
        CopyKey::OriginalClosed => "The original chat is closed. Your draft is kept.",
        CopyKey::ChooseWorkspace => "Choose an available workspace first.",
        CopyKey::CouldNotCreate => "The computer could not create this chat.",
        CopyKey::FindNewChat => "Reconnect and refresh the chat list to find the new chat.",
        CopyKey::NewChat => "New chat",
        CopyKey::FileNotStored => "Your computer did not store the file.",
    }
}

/// `key`'s text with `{reason}` filled.
pub(crate) fn render(key: CopyKey, reason: &str) -> String {
    text(key).replace("{reason}", reason)
}

/// The words presentation puts into messages.
pub(crate) fn feed_text() -> FeedText {
    FeedText {
        additional: text(CopyKey::AdditionalContent).into(),
    }
}
