import { memo, useId, type JSX } from 'react';
import {
  FILE_TYPE_DEFAULT_ICON,
  FILE_TYPE_EXTENSION_LANGUAGE_IDS,
  FILE_TYPE_EXTENSIONS,
  FILE_TYPE_FILE_NAMES,
  FILE_TYPE_ICONS,
  FILE_TYPE_LANGUAGE_IDS,
  FILE_TYPE_LIGHT_ICONS,
  type FileTypeIconDef,
} from './file-type-icons.generated';
import { DEFAULT_ICON_SIZE, ICON_SIZE_PX, type IconSize } from './icon-size';

/**
 * The icon a file's name resolves to, in the file-type family (Material Icon
 * Theme; docs/design/icons.md#file-types): its exact name, then each
 * extension from the longest (`d.ts` before `ts`), directly or through the
 * VS Code language it belongs to, then the `language` hint (a chat artifact's
 * language id), then the generic file.
 */
export function resolveFileTypeIcon(
  filename: string,
  options: { readonly language?: string } = {},
): string {
  const slash = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'));
  const base = filename.slice(slash + 1).toLowerCase();
  if (base) {
    const exact = FILE_TYPE_FILE_NAMES[base];
    if (exact) return exact;
    for (
      let dot = base.indexOf('.');
      dot !== -1;
      dot = base.indexOf('.', dot + 1)
    ) {
      const extension = base.slice(dot + 1);
      const direct = FILE_TYPE_EXTENSIONS[extension];
      if (direct) return direct;
      const language = FILE_TYPE_EXTENSION_LANGUAGE_IDS[extension];
      const bridged = language ? FILE_TYPE_LANGUAGE_IDS[language] : undefined;
      if (bridged) return bridged;
    }
  }
  const language = options.language?.toLowerCase();
  const hinted = language ? FILE_TYPE_LANGUAGE_IDS[language] : undefined;
  return hinted ?? FILE_TYPE_DEFAULT_ICON;
}

/** Whether an icon's markup points at its own gradients or clip paths. */
const REFERENCES_ID = /url\(#|href="#/;

/**
 * An icon's markup for one instance on the page. Ids are page-global: two
 * copies of an icon would share them, and a copy in a hidden panel would
 * break the gradient of a visible one, so an icon that references its own
 * definitions gets ids unique to this instance.
 */
function instanceBody(
  def: FileTypeIconDef,
  id: string,
  instance: string,
): string {
  if (!REFERENCES_ID.test(def.body)) return def.body;
  return def.body.split(`fti-${id}-`).join(`fti-${id}-${instance}-`);
}

function iconDef(id: string): FileTypeIconDef | undefined {
  return FILE_TYPE_ICONS[id] ?? FILE_TYPE_ICONS[FILE_TYPE_DEFAULT_ICON];
}

/** The id whose definition `iconDef` returned (its fallback included). */
function iconDefId(id: string): string {
  return FILE_TYPE_ICONS[id] ? id : FILE_TYPE_DEFAULT_ICON;
}

export interface FileTypeIconProps {
  /** A file name or path; only its last segment is read. */
  readonly filename: string;
  /** A language id (`typescript`) for a name with no known extension. */
  readonly language?: string;
  /** A step of the icon scale. Defaults to `sm` (14px). */
  readonly size?: IconSize;
  readonly className?: string;
  /** Names the icon for assistive tech; without it the icon is decorative. */
  readonly title?: string;
}

/**
 * A file's type icon, in its own colors, on desktop and the web. Where the
 * icon has a light-background variant it shows in light mode, the default in
 * dark. The markup is vendored and trusted (generated from a pinned package),
 * so it renders as inner SVG rather than one component per icon.
 */
export const FileTypeIcon = memo(function FileTypeIcon({
  filename,
  language,
  size = DEFAULT_ICON_SIZE,
  className,
  title,
}: FileTypeIconProps): JSX.Element | null {
  const instance = useId().replace(/[^\w-]/g, '');
  const id = resolveFileTypeIcon(filename, language ? { language } : {});
  const def = iconDef(id);
  if (!def) return null;
  const defId = iconDefId(id);
  const lightId = FILE_TYPE_LIGHT_ICONS[id];
  const light = lightId ? FILE_TYPE_ICONS[lightId] : undefined;
  const px = ICON_SIZE_PX[size];
  const svg = (
    icon: FileTypeIconDef,
    iconId: string,
    extra: string,
  ): JSX.Element => (
    <svg
      width={px}
      height={px}
      viewBox={icon.viewBox}
      xmlns="http://www.w3.org/2000/svg"
      className={extra}
      aria-hidden
    >
      <g
        dangerouslySetInnerHTML={{
          __html: instanceBody(icon, iconId, instance),
        }}
      />
    </svg>
  );
  // One element carries the name; with a light variant, only one of the two
  // pictures shows (the light one in light mode). The theme is the `.dark`
  // class on desktop and the web alike, not the OS color scheme.
  return (
    <span
      role={title === undefined ? undefined : 'img'}
      aria-label={title}
      aria-hidden={title === undefined ? true : undefined}
      className={`inline-flex shrink-0 ${className ?? ''}`}
      data-file-type-icon={id}
    >
      {light ? (
        <>
          {svg(light, lightId ?? id, 'block [.dark_&]:hidden')}
          {svg(def, defId, 'hidden [.dark_&]:block')}
        </>
      ) : (
        svg(def, defId, 'block')
      )}
    </span>
  );
});
