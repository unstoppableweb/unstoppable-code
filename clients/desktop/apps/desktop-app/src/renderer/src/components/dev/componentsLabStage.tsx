import {
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { Button } from '@canopy/ui-shared/components';
import { MoreHorizontalIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  Stage,
  Window,
  type Layout,
  type Rect,
  type Script,
} from '../../../../../vendor/stageshow/kit';
import { LabColorModeContext } from './componentsLabStageContext';
import './componentsLabStage.css';

/**
 * The components lab's stageshow frame. Every stage is the vendored kit's
 * `Stage` (design size, the scripted cursor, playback and the reduced-motion
 * poster) with one Canopy window inside it, pinned top and sides and running
 * off the bottom. What is inside the window is always the real shared
 * component; the kit only frames it and moves the cursor.
 *
 * The lab's Vite config maps `:hover` and `:active` to the kit's
 * `data-hover` and `data-pressed` marks, so a real component shows its own
 * hover and press when the scripted cursor is on it. State the cursor cannot
 * cause that way (a tooltip opening, a copy confirming) is reached through
 * the component's real handlers with `pointAt` and `press`.
 */

const STAGE_WIDTH = 560;
// The phone column: a 390px viewport with 16px gutters.
const COMPACT_WIDTH = 358;

export interface LabStageProps<S extends object> {
  /** Names the stage for film's `--select '[data-stage=<id>]'`. */
  readonly id: string;
  readonly initial: S;
  /** The frame reduced motion and thumbnails show: the story told at rest. */
  readonly poster: S;
  readonly script: Script<S>;
  readonly height?: number;
  /** The phone design's height, when its crop differs from the wide one. */
  readonly compactHeight?: number;
  /**
   * A system story (something changes on its own) has no cursor; never a
   * focus ring or halo standing in for one (references/motion.md, The cursor).
   */
  readonly pointer?: boolean;
  /** Targets shown hovered in the poster, where no script hovers them. */
  readonly posterHover?: string[];
  readonly children: (
    state: S,
    rect: (name: string) => Rect,
    layout: Layout,
  ) => ReactNode;
}

export function LabStage<S extends object>({
  id,
  initial,
  poster,
  script,
  height = 300,
  compactHeight = height,
  pointer = true,
  posterHover,
  children,
}: LabStageProps<S>): JSX.Element {
  const theme = useContext(LabColorModeContext);
  // Replay remounts the scene at its story boundary (references/kit.md,
  // Explicit replay); the stage plays once and holds its payoff.
  const [run, setRun] = useState(0);
  return (
    <div data-stage={id} className="flex flex-col items-center gap-2">
      <div className="canopy-lab-stage-band w-full">
        <Stage
          key={run}
          width={STAGE_WIDTH}
          height={height}
          compact={{
            below: STAGE_WIDTH,
            width: COMPACT_WIDTH,
            height: compactHeight,
          }}
          initial={initial}
          poster={poster}
          script={script}
          play="once"
          hover={posterHover}
          theme={theme}
          cursor={
            pointer
              ? {
                  at: {
                    wide: { x: STAGE_WIDTH - 60, y: height - 24 },
                    compact: {
                      x: COMPACT_WIDTH - 40,
                      y: compactHeight - 24,
                    },
                  },
                }
              : undefined
          }
          className="canopy-lab-stage"
        >
          {children}
        </Stage>
      </div>
      <Button
        size="compact"
        variant="ghost"
        onClick={(): void => setRun((count) => count + 1)}
      >
        Replay
      </Button>
    </div>
  );
}

/**
 * The Canopy window a stage's story happens in: the title left beside the
 * lights and the window's own actions on the right, as Canopy's header
 * draws them (the kit's unified toolbar).
 */
export function LabWindow({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <Window
      title={title}
      toolbar={
        <Button
          size="compact"
          variant="ghost"
          iconOnly
          aria-label="More actions"
          tabIndex={-1}
        >
          <MoreHorizontalIcon />
        </Button>
      }
      className="canopy-lab-window"
    >
      {children}
    </Window>
  );
}

/**
 * Names a control inside a shared component that takes no `data-target` of
 * its own (the retry button inside `ErrorState`, one tab of a `TabBar`): the
 * first descendant button whose text starts with `text`, so the script can
 * aim at it and the cursor's hover lands on it.
 */
export function NameWithin({
  name,
  text,
  children,
}: {
  readonly name: string;
  readonly text: string;
  readonly children: ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const match = Array.from(
      ref.current?.querySelectorAll('button') ?? [],
    ).find((button) => (button.textContent ?? '').trim().startsWith(text));
    match?.setAttribute('data-target', name);
  });
  return (
    <div ref={ref} className="contents">
      {children}
    </div>
  );
}
