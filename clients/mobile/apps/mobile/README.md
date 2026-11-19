# mobile

A new Flutter project.

## Getting Started

This project is a starting point for a Flutter application.

A few resources to get you started if this is your first Flutter project:

- [Learn Flutter](https://docs.flutter.dev/get-started/learn-flutter)
- [Write your first Flutter app](https://docs.flutter.dev/get-started/codelab)
- [Flutter learning resources](https://docs.flutter.dev/reference/learning-resources)

For help getting started with Flutter development, view the
[online documentation](https://docs.flutter.dev/), which offers tutorials,
samples, guidance on mobile development, and a full API reference.

## Adaptive mobile navigation

On iOS windows with a vertical navigation-bar edge, the home shell places
chat-list, new-chat, search and destination controls along that edge. UIKit
chooses the physical edge, normally the right on iPhone Duo, and the controls
avoid its status bar, camera occlusions and keyboard.

With enough usable width for a 280-point history sidebar, a 72-point rail and
at least 400 points of chat, the list and selected conversation appear side by
side. Compact windows alternate between the list and conversation. Both use
the same detail navigator so resizing keeps the open route and unsent draft.
Search filters the existing recent chats (up to 30) by title or computer.
Other compact phones retain the slide-behind menu.

The Flutter shell reuses its existing destinations, context selector, recent
chat source and design-system controls. It adds no backend operation or agent
action. Desktop and web keep their existing React navigation; Flutter cannot
mount those components. Release builds need the SDK selection described in
[mobile releases](../../docs/mobile-release.md) for the expanded Duo window
and native geometry to be available.

## Computer connect

The **Computer connect** home page is available in every configured build
mode, including TestFlight release builds. It uses the signed-in personal
account to discover computers with Remote access enabled. **Connect a computer**
creates an account API key through the existing API and keeps its ID/secret in
Keychain/Keystore, separately for each account and server. The key is visible
and revocable in Account → API keys. It has the existing general account
permissions, rather than a new connection-only scope.

The app remembers paired computers and selection across launches, keeps
offline computers visible, and reconnects while active or when resumed.
**Disconnect** disables automatic reconnect for that computer while preserving
pairing; **Forget computer** removes its pairing pin after confirmation. The
initial matching-code approval still happens on desktop. The **Computers**
menu opens the saved/discovered list. **Developer settings** retains manual
URL/key entry with an independent device identity and memory-only credentials.

If setup loses its response, it will not silently create another key. Review
Account → API keys before choosing **Set up access again**. Unreadable saved
state is preserved. Signing out stops active sessions and recovery; saved
credentials are only loaded again inside their matching signed-in account and
server context. Existing installation identity and pairing pins are retained.

Computer connect requires desktop remote protocol 7 or later, with no upper
version limit. It reads the version from the existing authenticated hello,
then confirms that exact version before making IPC calls. Each computer keeps
its own negotiated version, including subsequent status reads. Malformed,
changing or older connection versions remain blocked. An unavailable operation
or unreadable application response fails that feature without closing the
connection. Newer versions can connect, but individual features may still need
mobile changes if their APIs change. See the
[compatibility notes](../../docs/planning/2026-11-03-computer-connect-protocol/README.md).

Computer connect chats show thumbs up and down in the footer of each completed
turn; thumbs down then offers an optional reason and comment. A long press on
a worktree row or a Cowork chat row opens that space's notification choices
when the computer has registered its notification space; the choices are
read-only while the server reports `writesEnabled: false`. A successful turn
counts toward the satisfaction prompt, which appears once the chat is quiet.
These features were restored in CAN-7218; see
[chat feedback and notification choices](../../docs/mobile-computer-connect.md#chat-feedback-and-notification-choices).

Run `flutter test test/device_link test/architecture` for regression coverage.
The native recovery target is
`integration_test/computer_connect_recovery_test.dart`; the isolated runner and
captures are described in the
[recovery notes](../../docs/planning/2026-11-01-computer-connect-recovery/README.md).

### File tabs

Files the computer has open in a worktree, such as agent reports opened with
ShowFiles, appear under Files in the worktree's chat list. They open in the
shared viewer in `lib/ui/core/file_viewer/`: Markdown formatted with its
relative images, image files zoomable, and HTML rendered in a webview.
Reads use the scoped `file:read-content` channel through
`lib/device_link/files/reader.dart`. That channel caps each file at 5 MiB,
which V8 can send as up to 10 MiB of UTF-16, so `desktopMaxMessageBytes` is
12 MiB; the 25 MiB byte channel is avoided because a reply over that limit
ends the session. At most two reads run at once, so a page with many assets
leaves room in the session's request budget.

The rendered page loads from a private origin the viewer answers itself,
with a random host per viewer: a `worktree-file://` scheme on iOS, and an
intercepted `https://<id>.worktree-file.invalid` host on Android, where
WebView cannot resolve relative links against a custom scheme. Scripts do not
run: a script on that origin could read other files under the root, and no
webview setting closes every channel it could send them through. The webview
also refuses every request off the page's origin (Android answers them in
`shouldInterceptRequest`; iOS uses WebKit content rules), each HTML document
starts with a Content-Security-Policy, dotfiles and `.git` are never served,
and only a link the person taps opens in the browser. Pages that depend on
scripts, or load assets from a CDN, render without them. `flutter_inappwebview` is
pinned to `6.2.0-beta.3`: the stable 6.1.5 Android plugin does not build with
AGP 9, and the beta adds `javaScriptBridgeEnabled`. Move to a stable release
once one includes both.

## Android keyboard inset regression

`ImeInsetsRecovery` requests fresh Android insets after an IME animation ends,
including cancellation during background/resume. It runs on the content parent
so Flutter retains its own animation listeners and normal keyboard avoidance.
This works around [Flutter #191156](https://github.com/flutter/flutter/issues/191156).
Re-evaluate the workaround when the upstream engine fix reaches our pinned SDK.

The native keyboard-recovery integration test and its driver were removed in
the [golden-only test cut](../../docs/golden-tests.md). Re-verify the workaround on an explicit Android emulator with
Gboard, covering gesture and three-button navigation, using a scratch
integration test.

## Shared chat stack

`lib/ui/features/chat/` and `lib/data/models/chat_message.dart` hold the
transport-neutral chat UI: the transcript feed (`ChatFeed`), composer
(`ChatInput`, `ComposerToolbar`), tool-call rows, the ask-user
`PendingQuestionCard`, and the pure turn-grouping, turn-timer, tool-display,
thinking-level, and voice-dictation logic. Computer Connect
(`lib/ui/features/device_link/`) builds on it. Flutter has no cloud chat
client.
See [Computer Connect](../../docs/mobile-computer-connect.md) for the home
launcher, protocol choices and selection persistence.

Drafts and unsent sends: `lib/data/models/chat_drafts.dart` (`DraftTarget`,
`UnsentRecord`, `ChatDraftStore`), `lib/data/services/chat_draft_store.dart`
(account file store), and
`lib/ui/features/chat/view_models/composer_draft_binding.dart`. Design:
`docs/planning/2026-10-03-can-3556-mobile-drafts-and-unsent-sends/design.md`.

### Markdown images

`MessageMarkdown` parses `![alt](src)` and `![alt](src "title")` into
`MessageImage` spans in paragraphs and table cells. Chat leaves `imageResolver`
unset, so images render inert alt text without network or desktop reads. Images
with empty alt text show `Image` instead.

A caller that can read images supplies `imageResolver`, a
`Future<Uint8List> Function(String source)`. The caller owns source validation,
authorization and transport. It can throw `MessageImageFailure.notFound`,
`.unsupported` or `.unavailable` for a short reason; other exceptions show a
generic failure without exposing their contents. Invalid image bytes show the
unsupported state. The widget reuses each read across rebuilds and discards
results from replaced resolvers or sources. While resolving and decoding, it
reserves a 160×80 logical pixel box. The first 200ms are blank, followed by a
pulsing skeleton; reduced motion keeps it still. Changing the source or resolver
restarts the delay. Loaded content uses its decoded dimensions.

Loaded images fit the content column with their aspect ratio preserved. Table
images use thumbnails capped at 96 logical pixels. `onImageTap(source, bytes)`
lets a caller open a viewer with the already loaded bytes. The renderer itself
does not read files; the worktree file viewer below supplies both callbacks. The parser retains its
32-column and 512-cell table limits.

## Remote Control (retired)

The Portal-based Remote tab, its Portal transport and its on-device transcript
cache were removed in CAN-5986. Computer connect is the only way to reach a
computer from mobile. Launch deletes a transcript cache an earlier build left
behind.

A notification tap for a cloud run opens the run on the web. Any other tap
shows the Chat home at once. When the push names a chat on a computer
(`computerId` and `clientChatId`, CAN-7218) and that computer is saved on the
phone, the tap selects it, waits up to 8 seconds for it to come online, and
opens the chat through the same row the drawer's Recents uses
(`computer_connect/push_chat_router.dart`). The Chat home stays, with no error,
when the push has no valid `computerId`, the computer is not saved, the shell
has no Computer connect, the computer stays offline, the chat is not listed
after one inventory refresh, or the chat is outside the phone's current
context. A newer tap replaces one still resolving.

## Worktree collation

Remote worktree tie-breakers use ICU4X through pinned `icu_kit` 0.2.0 with the
system locale, tertiary strength, and significant punctuation, matching desktop's
default `localeCompare` semantics. Saved numeric order still takes precedence.
Devices with different system locales can have different locale-specific ordering,
just as two desktop clients can. The collator is cached and rebuilt when the
locale changes.

The package bundles native collation code/data. For platforms with a matching
prebuilt library, its build hook downloads the pinned asset from the package's
GitHub release and verifies its checksum.

iOS builds require Rust 1.86 or later (`rustup` and `cargo` on PATH).
Check the compiler selected by `cargo`, especially if Homebrew Rust and rustup
are both installed. A newer rustup toolchain does not replace an older
Homebrew `cargo` earlier on PATH.
Flutter requests dynamic native libraries, while the package publishes static
iOS archives, so the hook builds the dynamic library from its bundled ICU4X
source. This includes Apple Silicon simulators. Install Rust using
[the official rustup instructions](https://rustup.rs/); the hook installs the
matching target and caches the result. First builds need network access and take
longer than subsequent builds. Flutter unit/widget tests on macOS use the
prebuilt native library and do not require Rust.

The CocoaPods post-install hook raises older plugin deployment targets to
Runner's existing iOS 15 minimum. Xcode 27 rejects older simulator targets.
It preserves plugins that require newer iOS versions. Run
`ruby ios/test/podfile_test.rb` with the Ruby environment used by CocoaPods
after changing this hook; run `flutter pub get` first to generate its Flutter
configuration.

## Foldable displays

The navigator uses `FoldSafeArea` to keep routes, sheets and controls out of
an active fold. iOS 27.1 builds obtain division regions through
`FoldRegionsPlugin`; the app uses the leading or upper pane while partially
folded and the full window when opened. This preserves the existing route
and draft. The adapter supplies geometry only when Flutter's engine does
not already report a fold. Older SDKs compile without the new UIKit calls.

The layout and bridge contract tests were removed in the [golden-only test cut](../../docs/golden-tests.md).
The native verification record and remaining
physical-device checks are in
[iPhone Duo readiness](../../docs/planning/2026-10-23-iphone-duo/README.md).
