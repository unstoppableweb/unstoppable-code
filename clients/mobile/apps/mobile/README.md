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
thinking-level, and voice-dictation logic. Remote Control (`lib/ui/features/remote/`) and Computer Connect
(`lib/ui/features/device_link/`) both build on it. `RemoteChatMessage` extends
`ChatMessage` to carry its desktop scope. Flutter has no cloud chat client.
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

### Worktree file viewer (CAN-5130)

`RemoteFileScreen` opens one root-scoped worktree file from a
`RemoteFileRequest`. The header shows the file name and its folders. Markdown
(`md`, `markdown`, `mdx`) opens in Formatted mode with a Source switch; other
text opens in Source only. Both modes stay mounted, so switching does not read
again or reload images.

Formatted mode passes `RemoteFileViewModel.readImage` to `MessageMarkdown`.
Sources resolve against the report's folder with
`resolveRemoteFileImagePath`. Root escapes, absolute and UNC paths, `file:`,
http(s) and other schemes, and malformed escapes are rejected before any read.
The desktop still enforces containment. Accepted images are read only through
`readAsset`, with the same project, worktree and root. A tap opens the loaded
bytes in `RemoteImageScreen`, an `InteractiveViewer` with pinch zoom and pan.

Read images stay in memory only, least recently used first, under a 20 MiB
encoded-byte budget per screen. Pending reads are shared and failures are not
cached. A session change clears the file and images, closes an open image, and
discards late results. Closing the screen or a session change also evicts the
screen's decoded images from Flutter's image cache; other cached images stay.
A desktop without `chat_assets_v1` keeps text and alt text and shows an update
notice. Entry points from file lists and links are
separate work; the device test reaches the viewer from a test-only launcher.

The viewer's unit, widget and device tests were removed in the [golden-only test cut](../../docs/golden-tests.md).

## Remote chat controllers (CAN-3429)

`RemoteChatScreen` renders state; it does not reconcile it during `build`.
Pure Dart controllers in `lib/ui/features/remote/view_models/` own the
optimistic state, and `RemoteClientEngine` wires them to its command
registry, session generation, and chat-id minting:

- `RemoteChatTabsController` owns provisional tab creates and closes, the
  selection, and the latched chat resolution. Create and close outcomes
  arrive through the handlers each submission registers.
- `LastViewedChatTabs` keeps, in memory only, the chat tab last shown in
  each worktree (CAN-3940). A worktree opened without an exact chat starts
  on that tab; the tabs controller falls back when it is gone. A new tab
  is remembered once the desktop lists it, even after the screen closed, so
  a failed create is never remembered. A new session generation (pairing,
  disconnect, ended session) forgets it.
- `ComposerOverridesController` holds one record per composer field. A
  value stays until the desktop rejects it, or until it completes and a
  newer projection of its chat arrives.
- `PrStateTracker.pollPrState` gives each chat view its own one-minute PR
  poll. The view reports visibility and foreground state as one input.
- Actions settle from the desktop's events, not from follow-up reads
  (CAN-4875). Activity & files reads the worktree once its snapshot lands.
  A read receipt stops retrying at its command's completion. A later unread
  for the same output can predate the read, because completions overtake
  older summaries and state reads lag. If the read's own summary does not
  confirm it within 3 seconds, one fresh desktop projection decides. When
  the desktop declines a read (`applied: false`: already read, older output,
  or a running turn), a fresh projection reconciles it. While the chat stays
  unread, each later decline asks again. Another client's read can confirm
  the receipt before the phone's own read answers, also while its submit is
  in flight. Then a later unread can predate the phone's read, and a fresh
  projection decides. An unread that arrives before the read's answer, also
  before its submit returns, can be a later desktop unread that a state read
  covers or that follows the read's completion. If the chat still projects
  unread when the read
  applies, the same 3-second wait and fresh projection decide. A worktree chat
  uses a chat `portal.state.request`; a standalone chat uses the overview
  request and its state read. Hook toggles apply the `portal.hook.event`
  upserts.
- `ProjectCloneCoordinator` reads a clone's command status only when its
  completion is 30 seconds overdue, and once on each return.
- `PendingChatAttachmentStore` marks retry drafts restorable from command
  outcomes. A chat view takes each batch once with `takeRestorable`.
- `WorktreeCreateCoordinator` submits immediately and follows pushed Git-ready
  and failure updates. A recovery round runs only after 30 foreground seconds
  without them, then every 30 seconds, and never in the background (CAN-4875).
  A round recovers a missing worktree ID from the command-status endpoint,
  or refreshes the overview once the ID is known. It never identifies a
  create by comparing worktree lists or sends the first message into another
  client's worktree. An outcome with a known command or
  worktree ID stays pending across retries to prevent duplicate creates. After
  the original waiter times out, pull-to-refresh reads command status again
  so a missed completion event cannot strand an accepted create. If
  both IDs were lost, the reconciliation deadline releases the attempt and
  asks the user to check the desktop before trying again, since the original
  request may have created a task.

`ChatSendCoordinator` mints chat ids (`chat-m…`, `cc-…`) next to message
ids (`msg-mobile-…`). For tab creates and closes and composer setting
commands, it does not claim a command whose submit response arrives after
the session was replaced, so their outcomes cannot change or notify the
replacement session. Message sends keep their existing delivery and
recovery behavior and are not covered by this guard. The screen
calls `_syncWithViewModel` from its view-model listener to apply
projection bookkeeping and the bound chat's side effects.

`test/ui/features/remote/remote_chat_screen_test.dart` is the registered
golden for this screen.

## Remote Control compatibility

Remote Control is deprecated in favor of Computer connect. It stays in the
sidebar only while this account has a paired Remote Control session, including
while the desktop is offline or reconnecting. Settings keeps a Remote control
entry in its Organization section (Personal in a Personal context), with a back
button to Settings. Timeline no longer promotes Remote Control setup.

Mobile keeps the existing desktop and web-server support range. Optional
capabilities continue to select the available hydration behavior; missing
`foreground_worktree_chat` or `worktree_chat_summaries_scope` does not require
an update. Uncursored-event reconciliation and paced SSE/long-poll recovery
remain. The [CAN-4878 audit](../../docs/planning/2026-10-29-can-4878/compatibility-audit.md)
records the per-path decisions and the evidence needed before setting a release
cutoff. The cleanup removes local Dart aliases and an unused feedback loader.

## Remote Control request budgets (CAN-4872)

The Remote Control client keeps the HTTP requests and event-stream
connections of each user flow low. The pinned request-budget suite is retired
under the [golden-only test policy](../../docs/golden-tests.md); write a local
budget check under `test/__scratch__/` when a change touches the network path.

For a current server tail, a missing or stale tail, and cold-connect request
ordering (CAN-4877), a nonempty server tail can settle chat hydration when its
projection cursor covers the overview and every observed event for that chat,
and `chatTailCoverage` proves the exact cached message set was seeded by a
completed targeted desktop snapshot. Mobile installs its ordered message IDs
instead of sorting mutable revision timestamps. Absent or mismatched coverage
keeps reconciliation, including on older servers and live-only partial caches.
Missing cursors, stale responses and raced live rows keep the desktop snapshot
fallback. A verified tail ignores older transcript replay for its chat. Legacy
live events without row cursors resume snapshot reconciliation when their order
cannot be proven. Chat reads never advance the session's event-stream cursor.
Advisor prefetch and background summary warming wait for a foreground chat or
overview projection to finish. A usable HTTP overview also releases the gate,
so a fresh connect or restore does not depend on another overview push.
Opening Advisor or chat search still loads it
on demand. State responses of at least 64 KiB decode and map in an isolate.

Measure tap-to-latest-message time, request counts and received bytes on the
same physical device and paired desktop before and after a network or
performance change, and post them in the change's issue.

## Remote Control on-device caches (CAN-4879)

`RemoteFileDiffCache` retains at most 32 diffs and 512 KiB of encoded JSON,
including the session envelope. Each insertion encodes its row once and saves
its UTF-8 size. LRU eviction and expiry subtract those sizes. Reads update
memory only; writes collect for 500 ms, with an explicit flush on background
and view-model disposal. Cold restoration decodes and validates JSON in a
separate isolate. Pairing changes fence late reads and discard deferred writes.

Every diff hit revalidates, including a hit restored from disk. Current
projection revisions identify changed-file metadata rather than patch contents;
a same-size edit can keep both its revision and line counts. Skipping requests
requires a content-bound identity, tracked in
[CAN-5472](https://linear.app/unstoppable-domains/issue/CAN-5472).
Older hosts without revisions keep memory-only entries. The 15-minute expiry
still applies.

Transcript hydration reads each chat's persisted tail once per pairing without
changing its recency. `ShownChatReopener` records actual foreground activations,
including switching tabs or returning from a covered route. Activation waits
for connection readiness so a screen mounted before automatic restoration can
persist subsequent live revisions without another navigation. Notifications to
mounted, hidden screens do not advance recency or rewrite idle tails. Live
transcript changes retain the existing write delay and partial-tail protection.

The cache, request-budget and five-diff profile tests were removed in the
[golden-only test cut](../../docs/golden-tests.md). Profile cache changes with a scratch integration test that
records the Dart timeline, frame timings, write count and encoded bytes, and
run identical before and after builds on the same device.

Emulator results compare the workload; they do not establish physical-device
frame performance.

## Remote Control reconnect pacing (CAN-4873)

`PortalEventStream` (`lib/data/services/portal_event_stream.dart`) paces its
reconnects with `PortalReconnectBackoff`:

- A failed connection, or a batch that reports the desktop inactive or
  ended, waits 4, 8, 16, 32 and then 60 seconds. Each wait takes 80-100% of
  its step. At most five reconnects fit in two minutes of desktop sleep.
- A healthy active batch, a long-lived stream with keepalives, or a fresh
  subscription after foreground resets the wait to the first step.
- A session read that reports the held desktop active ends the current wait
  at once. Without that read, the client reaches a desktop that wakes within
  one 60-second step, plus the connection time.
- Connect errors, timeouts, 5xx and empty streams stay on SSE. Only a
  stream-route 404 or an oversized frame moves the client to long-poll. It
  polls at least once and probes SSE again after its own 4- to 60-second
  step. Polls continue between probes, so delivery does not wait for them.

`PortalReadClient` (`lib/data/services/portal_read_client.dart`) keeps one
connection pool for session, overview and chat-cache reads. A read that
passes its deadline is aborted on its own socket, and its retries do not
reach the network. An abort cannot reach a
connection that is still in its TCP connect or TLS handshake, so the pool
also cancels each connection attempt after 10 seconds. A TLS handshake
that stalls after TCP connects keeps its socket until the server or the OS
closes it, because `dart:io` cannot cancel a handshake. If that handshake
completes later, the pool closes the socket at once. The repository
retires the pool when events pause: on background, session teardown and
session replacement. Retirement fails the reads in flight at once and
rejects their late results. A discarded event cursor keeps the pool, so
reads in flight finish.
Each SSE connection keeps its own client, so cancelling aborts it.
Consecutive long-polls share one client.

## Remote Control composer inventory (CAN-3925)

`RemoteComposerCommands` (`lib/data/repositories/remote_composer_commands.dart`)
reads the `invocable_inventory` session capability. With it, an existing
worktree chat, or a standalone chat that the desktop projects, uses
`portal.editor.list_invocables`. Rows keep the desktop order and groups:
Commands, Skills and commands, then Available to enable. A row that needs
resolution calls `portal.editor.resolve_invocable` before insertion, and the
composer inserts the text that the desktop returns. A failed resolve shows the
shared enable error and keeps the draft. `lib/data/models/remote_invocables.dart`
validates both answers at the data boundary.

Standalone chats also get the Plugins row. Its count and switches come from
the projected `pluginSelectionsDetail` of the standalone chat. An absent
projection is unknown, so the sheet does not load or save it. A toggle sends
`portal.standalone_chat.set_plugin_selections` and holds as a pending choice
until the desktop settles it, like a worktree chat.

Without the capability, worktree chats keep `portal.editor.list_slash_commands`
and standalone chats keep built-in actions only, with no Plugins row.

The composer inventory unit and device tests were removed in the [golden-only test cut](../../docs/golden-tests.md).

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
