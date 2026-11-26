# Rehearsal: components lab stages

The stageshow rehearsal record for the 15 stages in the localhost components
library (`ComponentsLabPage`). Each stage is the vendored stageshow kit's
`Stage` and `Window` around the real shared component, with a short scripted
cursor story, played once, with Replay. The kit is in
`apps/desktop-app/vendor/stageshow` (MIT, see its `VENDOR.md`); the stages are
in `componentsLabStagesControls.tsx` and `componentsLabStagesFeedback.tsx`.

Gold: `close-up` and `form-error`. Kept: a window pinned top and sides that
runs off the bottom, one control story per stage, the result left on screen
as the poster, `play="once"` with a keyed Replay. Changed: Canopy's look
(the kit's tokens mapped to Canopy's theme tokens in `componentsLabStage.css`,
so Light and Dark follow the lab's switch), Canopy's window header (title
left beside the lights, a ghost "More actions" button right: the kit's
unified toolbar), and the real `@canopy/ui-shared` components in place of the
kit's small parts. The kit's `Bar` is the only filler; its `Collapse` brings
the notice and the archived state in.

## Beats

| Stage             | Story                                                                                                                    | Poster                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| button            | Cancel hovered, Create pull request hovered and pressed, busy (`Button loading`), done                                   | Busy                       |
| list-row          | Hover travels down the chat list, a click moves the selection                                                            | New selection              |
| markers           | No cursor: a run finishes, its `StatusGlyph` and `Badge` turn from running to passed                                     | Passed                     |
| chip              | Chip hover, its remove control hovered, the chip folds out of the row                                                    | Remove hovered             |
| tab-bar           | Runs hovered and clicked, the panel crossfades to the runs list                                                          | Runs                       |
| segmented-control | Settings rows; Dark clicked, the surface slides                                                                          | Dark                       |
| fields            | Branch typed with spaces, submit shows the error, the edit clears it, busy, done                                         | Error under the field      |
| reference-chips   | Hover on the PR chip, then the issue chip; the code chip stays grey                                                      | PR chip hovered            |
| notice            | The composer notice rises in over the input, its action under the hand                                                   | Notice with action hovered |
| toast             | Merge pressed (then disabled), the real `ToastStack` brings the card into the window's corner                            | Toast showing              |
| failures          | `ErrorState`, Try again pressed, retrying, the pull request list                                                         | Error state                |
| loading           | No cursor: a skeleton in the list's own rows (icons still, values pulse) resolves top to bottom                          | Skeleton                   |
| facts             | `FactList`; the commit's `CopyButton` pressed, it confirms in place                                                      | Facts at rest              |
| dialogs           | Archive pressed, the confirm `DialogModal` opens in the stage, Cancel hovered, Archive confirmed, the chat's empty state | Dialog open                |
| tooltip-copy      | The New chat button pointed at, its `Tooltip` with the shortcut opens; Copy branch pressed, Copied                       | At rest                    |

Each runs 6 to 9 seconds and holds its payoff. Icon scale, spacing and markers
in context are still sheets with no interaction to tell, so they have no
stage.

## Captured

- Gate: `film.mjs --gate` on every stage, light at desktop width (1280),
  dark at desktop width, and light in the lab's phone column
  (`&width=phone`: a 390px viewport column, the 358px compact design at 1:1).
  Frames: `.playwright/components-lib/film/final/{light,dark,phone}/<id>.png`
  with each run's log beside it. Runner:
  `.playwright/components-lib/film-all.sh`.
  The phone run predates the lab's page shell: `&width=phone` is gone, so a
  phone run films `?component=<id>&frame=1` in a 390px viewport instead.
- Results: all 15 stages end `rehearsal passed` in the light and dark runs.
  The phone run also passed, but it is historical: it filmed the removed
  `&width=phone` column. The current 390px `&frame=1` layout has not been
  through the stage gate, so the phone layout is unverified on this code.
- Reduced motion: the jsdom test renders every stage's poster with
  `prefers-reduced-motion` on; the light and dark sheet captures in
  `.playwright/components-lib/` are taken with reduced motion, so each shows
  its poster.

## How the scripted cursor reaches real components

- Hover and press: the lab's Vite config rewrites `:hover` and `:active` in
  compiled CSS to also match the kit's `data-hover` and `data-pressed` marks.
  Real components show their own hover and press under the cursor without any
  restyle. Lab only; production CSS never passes through that config.
- State with no CSS: `pointAt`, `pointAway` and `press`
  (`componentsLabStageEvents.ts`) dispatch the real mouseover, mouseout and
  click, so Tooltip and CopyButton run their own handlers.
- `NameWithin` names a button inside a component that takes no
  `data-target` (a TabBar tab, a segment, the retry button).
- Dialogs open inside the stage through `DialogModal`'s `portalContainer` on
  a transformed layer. The real `ToastStack` renders inline, so it sits in the
  window's corner.

## Film

Gate lines met and fixed on the way:

- `uneven inset` on the window bar (kit centered title): Canopy's header puts
  the title left with actions right, so the window uses the kit's unified
  toolbar.
- `empty pane` (most stages): each crop set from measured content bottoms
  (`.playwright/components-lib/measure.mjs`); the window always runs 24px past
  the stage. Loading's skeleton pulses to 50% opacity, which the gate counts
  as empty; the skeleton rows keep the row's real icon still and pulse only
  the title, which is also Canopy's loading rule (only values pulse).
- `framing` (toast): the toast corner moved inside the window, one toast.
- `framing` (phone): the compact window is 16px from the top as well as the
  sides, one gutter.
- `spills its slot` (phone): the chip row no longer wraps (README.md chip is
  wide-only); the tab bar hugs its tabs in the phone column; the phone notice
  has no action, because under 384px `Notice` wraps its actions onto their own
  row by design and the gate reads that wrap as a spilled slot. The wide stage
  keeps the action.

Candidates left standing, all real component behavior, not stage faults (to
be routed as follow-ups, not fixed in the lab):

- `Button loading` swaps its idle, busy and done labels in one frame
  (`appears with no entrance` / `vanishes with no exit`) and shifts its label
  2 to 4px on press (button, fields, failures).
- `CopyButton` with a label changes width by 35px on Copied in one frame, and
  its check glyph pops in and out (tooltip-copy, facts).
- `FieldError` appears and leaves in one frame (fields).
- Button `active:scale-97` makes text step inside its box during the press
  (every pressed button).
- 14px glyphs centered in odd-width Chip and Button boxes sit on half pixels
  (chip, dialogs, tooltip-copy).
- `InlineMention` holds its icon 4px from its text, which the film reads as
  `touching` (reference-chips).
- The toast card comes to rest at the end of a transform (toast).

## Review

A fresh-eye review (stageshow `review.md`, given the frames, the golds and
the brief, not this file) returned 14 items. Fixed in the stages:

- dialogs: the dialog's scrim covered the whole stage; the dialog layer is now
  the window's own box, so the scrim dims only the window.
- segmented-control: the Settings rows' divider drew in the text color. The
  kit's unlayered guard beat Canopy's unlayered default border color; the
  lab's look restates that default in Tailwind's base layer.
- toast, dialogs, notice, reference-chips: empty space under the content;
  crops re-measured, filler under Merge, a longer transcript in dialogs, the
  lone bar over the reference sentence dropped.
- tooltip-copy: the tooltip ran past the window's edge; the + button sits
  before Copy branch now.
- tab-bar: the Overview pane was three bars; it is a real `FactList`.
- tab-bar, tooltip-copy, segmented-control: the cursor rested half off the
  crop or on a control seam; it rests on empty surface now.

Kept, with reasons:

- markers and loading have no cursor on purpose: both are system stories
  (motion.md, "What the system does"), told by state alone.
- notice, reference-chips and segmented-control end on a hover or a settled
  choice rather than another press: the payoff is the component's state
  (the notice arrived, the chip's hover, Dark selected).
- The window frame is the same in every stage on purpose: one figure language
  for a page of demos (craft.md, A page of demos).

Component behavior the reviewer also saw (labels swapping in one frame,
CopyButton's width jump, FieldError popping, the busy spinner's look at 1x,
the disabled primary nearly vanishing in dark, the empty state's title
lighter than its description) is listed under Film as follow-ups.

## Not checked

- Hover and press feel at real speed by a person; the contact sheets sample
  every 800ms, and the gate's motion scan samples every frame.
- Windows (the lab is checked on macOS Chrome only).
- Reduced motion toggled mid-playback in a real browser.
