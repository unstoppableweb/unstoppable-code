'use client';

import {
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import { Button } from './Button';
import { DetailMoreMenu } from './DetailMoreMenu';
import { EyeOffIcon } from '../icons/AppIcons';
import { Heading } from './Heading';

interface HomeSectionsContextValue {
  hidden: ReadonlySet<string>;
  hide: (id: string) => void;
  restore: () => void;
  registerHeading: (id: string, node: HTMLHeadingElement | null) => void;
  registerRestore: (node: HTMLButtonElement | null) => void;
}
const HomeSectionsContext = createContext<HomeSectionsContextValue | null>(
  null,
);

/** Scope may sit above portals; the restore control stays beside the composer. */
export function HomeSectionsProvider({
  children,
  fallbackFocusRef,
}: {
  children: ReactNode;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
}): JSX.Element {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const lastHidden = useRef<string | null>(null);
  const headings = useRef(new Map<string, HTMLHeadingElement>());
  const restoreButton = useRef<HTMLButtonElement | null>(null);
  const focusRequest = useRef<'restore' | { sectionId: string | null } | null>(
    null,
  );
  useLayoutEffect(() => {
    const request = focusRequest.current;
    focusRequest.current = null;
    if (request === 'restore') restoreButton.current?.focus();
    else if (request) {
      const target = request.sectionId
        ? headings.current.get(request.sectionId)
        : undefined;
      (
        target ??
        headings.current.values().next().value ??
        fallbackFocusRef?.current
      )?.focus();
    }
  }, [hidden, fallbackFocusRef]);
  return (
    <HomeSectionsContext.Provider
      value={{
        hidden,
        hide: (id): void => {
          lastHidden.current = id;
          focusRequest.current = 'restore';
          setHidden((previous) => new Set([...previous, id]));
        },
        restore: (): void => {
          focusRequest.current = { sectionId: lastHidden.current };
          setHidden(new Set());
        },
        registerHeading: (id, node): void => {
          if (node) headings.current.set(id, node);
          else headings.current.delete(id);
        },
        registerRestore: (node): void => {
          restoreButton.current = node;
        },
      }}
    >
      {children}
    </HomeSectionsContext.Provider>
  );
}
function HomeSectionsRestore(): JSX.Element | null {
  const context = useContext(HomeSectionsContext);
  if (!context || context.hidden.size === 0) return null;
  return (
    <div className="px-4">
      <Button
        ref={context.registerRestore}
        variant="ghost"
        size="compact"
        onClick={context.restore}
      >
        Show hidden sections ({context.hidden.size})
      </Button>
    </div>
  );
}
/** Closing suggestions only changes visibility for this page session. */
export function HomeSections({
  children,
  fallbackFocusRef,
}: {
  children: ReactNode;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
}): JSX.Element {
  const inherited = useContext(HomeSectionsContext);
  return inherited ? (
    <>
      {children}
      <HomeSectionsRestore />
    </>
  ) : (
    <HomeSectionsProvider fallbackFocusRef={fallbackFocusRef}>
      {children}
      <HomeSectionsRestore />
    </HomeSectionsProvider>
  );
}

export interface HomeSectionProps {
  sectionId: string;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  testId?: string;
  headingId?: string;
  onVisibilityChange?: (visible: boolean) => void;
}

/** Shared below-composer section: one alignment rail, divider and ••• menu. */
export function HomeSection({
  sectionId,
  title,
  description,
  children,
  testId,
  headingId,
  onVisibilityChange,
}: HomeSectionProps): JSX.Element | null {
  const generatedId = useId();
  const id = headingId ?? generatedId;
  const context = useContext(HomeSectionsContext);
  const [hidden, setHidden] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const restoreButton = useRef<HTMLButtonElement>(null);
  const wasHidden = useRef(false);
  const grouped = context !== null;
  useLayoutEffect(() => {
    if (!grouped) {
      if (hidden) restoreButton.current?.focus();
      else if (wasHidden.current) heading.current?.focus();
      wasHidden.current = hidden;
    }
  }, [grouped, hidden]);
  const visible = !(context?.hidden.has(sectionId) ?? hidden);
  useLayoutEffect(() => {
    onVisibilityChange?.(visible);
  }, [onVisibilityChange, visible]);
  useLayoutEffect(
    () => (): void => onVisibilityChange?.(false),
    [onVisibilityChange],
  );
  if (context?.hidden.has(sectionId)) return null;
  if (!context && hidden)
    return (
      <div className="px-4">
        <Button
          ref={restoreButton}
          variant="ghost"
          size="compact"
          onClick={(): void => setHidden(false)}
        >
          Show {title}
        </Button>
      </div>
    );
  return (
    <section
      data-testid={testId}
      aria-labelledby={id}
      className="group/home-section flex w-full min-w-0 select-none flex-col gap-3"
    >
      <div className="px-4">
        <div className="flex flex-col gap-2 border-b-[length:var(--border-hairline)] border-line-quaternary pb-3">
          <div className="flex min-h-7 items-center gap-2">
            <Heading
              level={2}
              variant="section"
              ref={(node): void => {
                heading.current = node;
                context?.registerHeading(sectionId, node);
              }}
              tabIndex={-1}
              id={id}
              className="min-w-0 flex-1"
            >
              {title}
            </Heading>
            {/* Shown while the section is hovered or focused, or its menu is
              open (the menu portals out of the section); always on touch.
              It bleeds 6px past the divider into the column a row's
              trailing control sits in (SuggestionRowTrailing, 10px in). */}
            <span
              data-testid={`home-section-actions-${sectionId}`}
              className="-mr-1.5 flex opacity-0 transition-opacity group-hover/home-section:opacity-100 group-focus-within/home-section:opacity-100 has-[[aria-expanded=true]]:opacity-100 pointer-coarse:opacity-100 [@media(hover:none)]:opacity-100"
            >
              <DetailMoreMenu
                name={typeof title === 'string' ? title : 'this section'}
                variant="ghost"
                size="compact"
                placement="bottom-right"
                triggerTestId={`home-section-more-${sectionId}`}
                menuTestId={`home-section-menu-${sectionId}`}
                items={[
                  {
                    id: 'hide',
                    label: 'Hide section',
                    icon: <EyeOffIcon size="sm" aria-hidden />,
                    testId: `home-section-hide-${sectionId}`,
                    onSelect: (): void => {
                      if (context) context.hide(sectionId);
                      else setHidden(true);
                    },
                  },
                ]}
              />
            </span>
          </div>
          {description && (
            <p className="text-xs leading-5 fg-secondary">{description}</p>
          )}
        </div>
      </div>
      {children}
    </section>
  );
}
