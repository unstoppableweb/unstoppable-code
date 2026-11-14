import { useState, type JSX, type ReactNode } from 'react';
import { McpServerIcon } from '../icons/AppIcons';
import { imageReferrerPolicyFor } from '../lib/first-party-image-referrer';
import {
  MCP_BRAND_LOGOS,
  MCP_FLOATING_BRAND_LOGOS,
} from '../lib/mcp-brand-logos';

/**
 * A neutral edge plus shadow keeps light, dark, and fallback marks at the same
 * visual weight against either app theme. The half-pixel ring reads as a
 * hairline on Retina displays without changing the avatar's measured size.
 */
const AVATAR_CHROME_CLASSNAME =
  'shadow-sm ring-[length:var(--border-hairline)] ring-line-secondary';

export interface McpServerLogoProps {
  /** Curated catalog key, when the server is linked to a curated entry. */
  curatedKey?: string;
  /** Remote catalog logo URL fallback (used when no bundled mark exists). */
  logoUrl?: string;
  /**
   * A mark the app already ships, as a ready-to-render data URL. Takes
   * precedence over `logoUrl` and never reaches the remote image resolver,
   * because it did not come from the network in the first place.
   */
  bundledLogo?: string;
  /**
   * Render the app's own brand mark on the tile.
   *
   * Inline rather than as an `<img>`: the brand asset is authored with
   * `currentColor` (both shipped brands rely on it), which inside an `<img>`
   * has nothing to inherit and collapses to black — invisible on a dark tile.
   */
  brandMark?: boolean;
  /** Disc diameter in px. */
  size: number;
  /**
   * What renders when no logo resolves (or the remote image breaks):
   * - `icon` (default): the generic MCP icon on a circular tile — used by
   *   the suggestion chips.
   * - `monogram`: the first letter of `name` on the same tile — used by
   *   picker/browse/settings lists where rows are identified by name.
   */
  fallback?: 'icon' | 'monogram';
  /** Server display name; provides the `monogram` fallback letter. */
  name?: string;
  /**
   * Tile shape. `circle` (default) is the avatar language used by chips,
   * pickers, and server lists; `squircle` remains available for square app
   * marks where a caller explicitly needs it. Callers cannot express this through
   * `className` — the radius is set here, so a caller-supplied `rounded-*`
   * only ever ties with it.
   */
  shape?: 'circle' | 'squircle';
  /**
   * How a resolved logo fills its tile. `cover` (default) crops to fill, which
   * suits the square brand marks the catalogs ship; `contain` letterboxes the
   * whole mark instead. Like `shape`, this cannot be expressed through
   * `className` — the base class already sets an `object-fit` utility, and a
   * caller-supplied one only ties with it at equal specificity, so which wins
   * depends on stylesheet order rather than the caller's intent.
   */
  fit?: 'cover' | 'contain';
  /**
   * Visual treatment around the mark. Prompt rows use `transparent` so the
   * plugin icon floats beside the prompt without avatar tile chrome.
   */
  chrome?: 'default' | 'transparent';
  /** Extra classes on the outer element (img or fallback tile). */
  className?: string;
  /** Test id for the resolved logo image. */
  imgTestId?: string;
  /** Test id applied to the fallback tile contents. */
  fallbackTestId?: string;
  /**
   * Host hook for resolving an untrusted remote catalog URL. It is called on
   * every render, with `undefined` when a bundled logo wins, so hosts may
   * safely inject a stateful React hook. Desktop supplies its IPC data-URL
   * cache; browser hosts can supply a safe-URL passthrough.
   */
  useRemoteLogo?: (logoUrl: string | undefined) => string | null | undefined;
  /** Host renderer for the active brand mark. Desktop supplies `BrandLogo`. */
  renderBrandMark?: (size: number) => ReactNode;
}

/**
 * The one way MCP server logos render across the app (suggestion chips,
 * capability pickers, the browse dialog, server lists): a circular mark with
 * the shared drop shadow, resolved bundled-first from this package's catalog,
 * falling back to a matching circular tile when no logo exists or the remote
 * image fails to load. Stateful remote resolution and the active brand mark
 * are host-injected so this component remains pure display code.
 */
export function McpServerLogo({
  curatedKey,
  logoUrl,
  bundledLogo,
  brandMark = false,
  size,
  fallback = 'icon',
  name,
  shape = 'circle',
  fit = 'cover',
  chrome = 'default',
  className = '',
  imgTestId,
  fallbackTestId,
  useRemoteLogo = (): undefined => undefined,
  renderBrandMark,
}: McpServerLogoProps): JSX.Element {
  const curatedLogo =
    curatedKey !== undefined &&
    Object.prototype.hasOwnProperty.call(MCP_BRAND_LOGOS, curatedKey)
      ? chrome === 'transparent'
        ? MCP_FLOATING_BRAND_LOGOS[curatedKey]
        : MCP_BRAND_LOGOS[curatedKey]
      : undefined;
  const localLogo = bundledLogo ?? curatedLogo;
  // The injected resolver is always called so it may be a React hook, but it
  // receives no URL when a local mark wins and therefore performs no fetch.
  const remoteLogo = useRemoteLogo(
    localLogo === undefined ? logoUrl : undefined,
  );
  const src = localLogo ?? remoteLogo ?? undefined;
  const radiusClassName = shape === 'squircle' ? 'rounded-xl' : 'rounded-full';
  const chromeClassName =
    chrome === 'transparent' ? '' : AVATAR_CHROME_CLASSNAME;
  const backgroundClassName =
    chrome === 'transparent' ? 'bg-transparent' : 'bg-subtle';
  if (brandMark && renderBrandMark) {
    // Same tile chrome as the monogram fallback, so a first-party entry sits
    // in the row at the same weight as everything else. `fg-primary` is what
    // the inlined `currentColor` resolves against.
    return (
      <span
        className={`flex shrink-0 items-center justify-center ${radiusClassName} ${backgroundClassName} fg-primary ${chromeClassName} ${className}`}
        style={{ width: size, height: size }}
      >
        {renderBrandMark(Math.round(size * 0.62))}
      </span>
    );
  }
  const letter = name?.trim().charAt(0).toUpperCase() ?? '';
  const fallbackTile = (
    <span
      className={`flex shrink-0 items-center justify-center ${radiusClassName} ${backgroundClassName} ${chromeClassName} ${className}`}
      style={{ width: size, height: size }}
    >
      {fallback === 'monogram' && letter.length > 0 ? (
        <span
          className="select-none font-medium leading-none fg-secondary"
          style={{ fontSize: Math.round(size * 0.5) }}
          data-testid={fallbackTestId}
        >
          {letter}
        </span>
      ) : (
        <McpServerIcon
          size={Math.round(size * 0.7) > 16 ? 'xl' : 'sm'}
          className="shrink-0 fg-secondary"
          data-testid={fallbackTestId}
        />
      )}
    </span>
  );
  if (!src) return fallbackTile;
  return (
    <McpLogoImage
      key={src}
      src={src}
      size={size}
      className={`shrink-0 ${radiusClassName} ${fit === 'contain' ? 'object-contain' : 'object-cover'} ${chromeClassName} ${className}`}
      imgTestId={imgTestId}
      fallback={fallbackTile}
    />
  );
}

function McpLogoImage({
  src,
  size,
  className,
  imgTestId,
  fallback,
}: {
  src: string;
  size: number;
  className: string;
  imgTestId?: string;
  fallback: JSX.Element;
}): JSX.Element {
  const [broken, setBroken] = useState(false);
  if (broken) return fallback;
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      loading="lazy"
      decoding="async"
      referrerPolicy={imageReferrerPolicyFor(src)}
      onError={() => setBroken(true)}
      style={{ width: size, height: size }}
      className={className}
      data-testid={imgTestId}
    />
  );
}
