import { useState, type JSX, type ReactNode } from 'react';
import { McpServerIcon } from '../icons/AppIcons';
import { imageReferrerPolicyFor } from '../lib/first-party-image-referrer';
import { useLogoOpaqueEdges } from '../lib/logo-edge-opacity';
import {
  MCP_BRAND_LOGOS,
  MCP_FLOATING_BRAND_LOGOS,
  tileBrandMark,
} from '../lib/mcp-brand-logos';

/**
 * The light plate's fill: the same neutral in both themes (zinc-100), so a
 * logo reads as it would on a light page. The avatar chrome's hairline ring
 * keeps it from glowing in light mode.
 */
const LOGO_PLATE_CLASSNAME = 'bg-[#f4f4f5]';

/**
 * A neutral edge keeps light, dark, and fallback marks at the same visual
 * weight against either app theme. The half-pixel ring reads as a hairline on
 * Retina displays without changing the avatar's measured size.
 */
const AVATAR_CHROME_CLASSNAME =
  'ring-[length:var(--border-hairline)] ring-line-secondary';

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
   * marks where a caller explicitly needs it; `tile` is the small rounded
   * square of the curated plugin logos. Callers cannot express this through
   * `className` — the radius is set here, so a caller-supplied `rounded-*`
   * only ever ties with it.
   */
  shape?: 'circle' | 'squircle' | 'tile';
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
  /**
   * New Customize surfaces only (rows, detail pages, the tile benchmark): set
   * a remote logo on a theme-neutral light plate so transparent dark art
   * shows on dark rows. Every other surface keeps the plain image.
   */
  plate?: boolean;
}

/**
 * The one way MCP server logos render across the app (suggestion chips,
 * capability pickers, the browse dialog, server lists): a circular mark with
 * a hairline edge, resolved bundled-first from this package's catalog,
 * falling back to a matching circular tile when no logo exists or the remote
 * image fails to load. Stateful remote resolution and the active brand mark
 * are host-injected so this component remains pure display code.
 */
export function McpServerLogo({
  plate = false,
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
  // A rounded-square tile frames a disc-composed mark with a square instead.
  const localLogo =
    shape === 'tile' && (bundledLogo ?? curatedLogo) !== undefined
      ? tileBrandMark(bundledLogo ?? curatedLogo ?? '')
      : (bundledLogo ?? curatedLogo);
  // The injected resolver is always called so it may be a React hook, but it
  // receives no URL when a local mark wins and therefore performs no fetch.
  const remoteLogo = useRemoteLogo(
    localLogo === undefined ? logoUrl : undefined,
  );
  const src = localLogo ?? remoteLogo ?? undefined;
  const platesEnabled = plate === true;
  // A logo that fills its own square (a UD tile, a photo avatar) skips the
  // plate, which would only ring it; only plated surfaces measure.
  const opaqueEdges = useLogoOpaqueEdges(
    platesEnabled && localLogo === undefined ? (src ?? undefined) : undefined,
  );
  const radiusClassName =
    shape === 'squircle'
      ? 'rounded-xl'
      : shape === 'tile'
        ? ''
        : 'rounded-full';
  // The app-icon corner of a rounded-square tile: 22% of its side, at any
  // size (New Customize's items; people stay round).
  const radiusStyle = shape === 'tile' ? { borderRadius: '22%' } : undefined;
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
        style={{ width: size, height: size, ...radiusStyle }}
      >
        {renderBrandMark(Math.round(size * 0.62))}
      </span>
    );
  }
  const letter = name?.trim().charAt(0).toUpperCase() ?? '';
  const fallbackTile = (
    <span
      className={`flex shrink-0 items-center justify-center ${radiusClassName} ${backgroundClassName} ${chromeClassName} ${className}`}
      style={{ width: size, height: size, ...radiusStyle }}
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
  // New Customize (Sergii's QA): a remote logo sits on a theme-neutral light
  // plate, so transparent dark artwork (Amazon's black "a") stays visible on
  // a dark row. Bundled marks carry their own backing, and letters and the
  // product mark never get one.
  if (
    platesEnabled &&
    !opaqueEdges &&
    localLogo === undefined &&
    chrome !== 'transparent'
  ) {
    const padding = Math.max(1, Math.round(size * 0.06));
    return (
      <McpLogoImage
        key={src}
        src={src}
        size={size - padding * 2}
        className="shrink-0 object-contain"
        imgTestId={imgTestId}
        fallback={fallbackTile}
        plate={{
          className: `flex shrink-0 items-center justify-center overflow-hidden ${LOGO_PLATE_CLASSNAME} ${radiusClassName} ${chromeClassName} ${className}`,
          size,
          radiusStyle,
        }}
      />
    );
  }
  return (
    <McpLogoImage
      key={src}
      src={src}
      size={size}
      // An opaque logo on a plated surface fills its tile edge to edge.
      className={`shrink-0 ${radiusClassName} ${fit === 'contain' && !(platesEnabled && opaqueEdges) ? 'object-contain' : 'object-cover'} ${chromeClassName} ${className}`}
      radiusStyle={radiusStyle}
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
  plate,
  radiusStyle,
}: {
  src: string;
  size: number;
  className: string;
  imgTestId?: string;
  fallback: JSX.Element;
  /** The light plate a remote logo sits on; a broken image drops it too. */
  plate?: {
    readonly className: string;
    readonly size: number;
    readonly radiusStyle?: { readonly borderRadius: string };
  };
  /** A rounded-square tile's corner, for an unplated image. */
  radiusStyle?: { readonly borderRadius: string };
}): JSX.Element {
  const [broken, setBroken] = useState(false);
  if (broken) return fallback;
  const image = (
    <img
      src={src}
      alt=""
      draggable={false}
      loading="lazy"
      decoding="async"
      referrerPolicy={imageReferrerPolicyFor(src)}
      onError={() => setBroken(true)}
      style={{ width: size, height: size, ...radiusStyle }}
      className={className}
      data-testid={imgTestId}
    />
  );
  if (plate === undefined) return image;
  return (
    <span
      data-logo-plate=""
      className={plate.className}
      style={{ width: plate.size, height: plate.size, ...plate.radiusStyle }}
    >
      {image}
    </span>
  );
}
