'use client';
import { useId, useRef, useState, type JSX } from 'react';
import type {
  BotColor,
  BotGlyph as BotGlyphValue,
} from '@canopy/protocol/bot-glyph';
import { SIDEBAR_ITEM_GROUP_COLORS } from '@canopy/protocol/sidebar';
import { PencilIcon } from '../../icons/AppIcons';
import { deriveBotColors } from '../../lib/bot-colors';
import { Button } from '../../primitives/Button';
import { ColorSwatchPicker } from '../ColorSwatchPicker';
import { SearchEmptyState, SearchField } from '../../primitives/SearchField';
import { TabBar } from '../../primitives/TabBar';
import { Tooltip } from '../../primitives/Tooltip';
import { BotCustomColor } from './BotCustomColor';
import { BOT_ICON_OPTIONS } from './bot-icons';
import emojiData from './emoji-data.json';
import { useBotColorTheme } from './useBotColorTheme';

export interface BotGlyphPickerProps {
  readonly value: BotGlyphValue;
  readonly onChange: (value: BotGlyphValue) => void;
  /** Host-owned recent history; no persistence or invented usage in display UI. */
  readonly recentEmojis?: readonly string[];
  readonly initialTab?: 'icons' | 'emojis';
  readonly disabled?: boolean;
}
const DEFAULT_COLOR: BotColor = { kind: 'theme', key: 'categorical-1' };
const EMOJI_PAGE = 120;
// Unicode category metadata stays intact; visible headings follow our copy rules.
const EMOJI_GROUPS = emojiData.map((group) => ({
  ...group,
  label: (group.label.charAt(0) + group.label.slice(1).toLowerCase()).replace(
    ' & ',
    ' and ',
  ),
}));

/** Controlled picker body; wrap in Popover, or use BotGlyphControl. */
export function BotGlyphPicker({
  value,
  onChange,
  recentEmojis = [],
  initialTab = 'icons',
  disabled = false,
}: BotGlyphPickerProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const theme = useBotColorTheme(rootRef);
  const id = useId();
  const [tab, setTab] = useState(initialTab);
  const [defaultColor, setDefaultColor] = useState<BotColor>(DEFAULT_COLOR);
  const [query, setQuery] = useState('');
  const [customOpen, setCustomOpen] = useState(
    value.kind !== 'default' && value.color.kind === 'custom',
  );
  const [limit, setLimit] = useState(EMOJI_PAGE);
  const color = value.kind === 'default' ? defaultColor : value.color;
  const colors = theme ? deriveBotColors(color, theme) : null;
  const changeColor = (next: BotColor): void => {
    if (disabled) return;
    // A color prepares the next glyph choice without replacing the default orbit.
    if (value.kind === 'default') setDefaultColor(next);
    else onChange({ ...value, color: next });
  };
  const search = query.trim().toLowerCase();
  const icons = BOT_ICON_OPTIONS.filter((option) =>
    `${option.name} ${option.label} ${option.group}`
      .toLowerCase()
      .includes(search),
  );
  const recent = [...new Set(recentEmojis)].flatMap((emoji) => {
    const item = emojiData
      .flatMap((group) => group.items)
      .find((entry) => entry[0] === emoji);
    return item ? [item] : [];
  });
  const groups = [
    ...(recent.length > 0 && !search
      ? [{ label: 'Frequently used', items: recent }]
      : []),
    ...EMOJI_GROUPS,
  ];
  let remaining = limit;
  let count = 0;
  const emojis = groups.map((group) => {
    const matches = group.items.filter((entry) =>
      `${entry[0]} ${entry[1]} ${group.label}`.toLowerCase().includes(search),
    );
    count += matches.length;
    const items = matches.slice(0, Math.max(0, remaining));
    remaining -= items.length;
    return { label: group.label, items };
  });
  return (
    <div
      ref={rootRef}
      className="flex w-96 max-w-full flex-col"
      data-testid="bot-glyph-picker"
    >
      <div className="border-b px-3">
        <TabBar
          label="Avatar type"
          value={tab}
          items={[
            { id: 'icons', label: 'Icons', tabId: `${id}-icons` },
            { id: 'emojis', label: 'Emojis', tabId: `${id}-emojis` },
          ]}
          panelId={`${id}-panel`}
          onChange={(next): void => {
            setTab(next);
            setQuery('');
            setLimit(EMOJI_PAGE);
          }}
        />
      </div>
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`}>
        {tab === 'icons' ? (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b px-3 py-3">
              <ColorSwatchPicker
                value={color.kind === 'theme' ? color.key : undefined}
                label="Avatar color"
                disabled={disabled}
                palette={SIDEBAR_ITEM_GROUP_COLORS.map((key) => {
                  const c = theme
                    ? deriveBotColors({ kind: 'theme', key }, theme)
                    : null;
                  return {
                    value: key,
                    label:
                      key === 'neutral' ? 'Neutral' : `Color ${key.slice(-1)}`,
                    color:
                      c?.swatch ??
                      `var(--${key === 'neutral' ? 'fg-secondary' : key})`,
                    ink: c?.swatchInk,
                  };
                })}
                onChange={(key): void => {
                  const found = SIDEBAR_ITEM_GROUP_COLORS.find(
                    (candidate) => candidate === key,
                  );
                  if (found) {
                    setCustomOpen(false);
                    changeColor({ kind: 'theme', key: found });
                  }
                }}
              />
              <Tooltip label="Custom color">
                <Button
                  variant={customOpen ? 'secondary' : 'ghost'}
                  iconOnly
                  size="compact"
                  aria-label="Custom color"
                  aria-expanded={customOpen}
                  disabled={disabled}
                  onClick={(): void => setCustomOpen(!customOpen)}
                >
                  <PencilIcon size="sm" />
                </Button>
              </Tooltip>
            </div>
            {customOpen ? (
              <BotCustomColor
                color={color}
                theme={theme}
                disabled={disabled}
                onChange={changeColor}
              />
            ) : null}
          </>
        ) : null}
        <div className="border-b px-3 py-2">
          <SearchField
            value={query}
            onValueChange={(next): void => {
              setQuery(next);
              setLimit(EMOJI_PAGE);
            }}
            aria-label={tab === 'icons' ? 'Search icons' : 'Search emoji'}
            placeholder={tab === 'icons' ? 'Search icons' : 'Search emoji'}
            clearOnEscape={false}
          />
        </div>
        <div
          className={
            tab === 'icons'
              ? 'flex max-h-56 flex-col gap-3 overflow-auto px-3 py-3'
              : 'flex max-h-72 flex-col gap-3 overflow-auto px-3 py-3'
          }
        >
          {tab === 'icons'
            ? [...new Set(icons.map((option) => option.group))].map((group) => (
                <div key={group} className="flex flex-col gap-1.5">
                  <span className="text-xs fg-tertiary">{group}</span>
                  <div
                    className="flex flex-wrap gap-1"
                    style={colors ? { color: colors.ink } : undefined}
                  >
                    {icons
                      .filter((option) => option.group === group)
                      .map((option) => {
                        const Icon = option.icon;
                        return (
                          <Tooltip
                            key={option.name}
                            label={option.label}
                            delay="long"
                          >
                            <Button
                              variant="ghost"
                              iconOnly
                              iconShape="nested"
                              size="compact"
                              aria-label={option.label}
                              aria-pressed={
                                value.kind === 'icon' &&
                                value.name === option.name
                              }
                              disabled={disabled}
                              onClick={(): void =>
                                onChange({
                                  kind: 'icon',
                                  name: option.name,
                                  color,
                                })
                              }
                            >
                              <span
                                style={
                                  colors ? { color: colors.ink } : undefined
                                }
                              >
                                <Icon size="md" />
                              </span>
                            </Button>
                          </Tooltip>
                        );
                      })}
                  </div>
                </div>
              ))
            : emojis
                .filter((group) => group.items.length > 0)
                .map((group) => (
                  <div key={group.label} className="flex flex-col gap-1.5">
                    <span className="text-xs fg-tertiary">{group.label}</span>
                    <div className="flex flex-wrap gap-0.5">
                      {group.items.map(([emoji, label]) => (
                        <Tooltip key={emoji} label={label ?? ''} delay="long">
                          <Button
                            variant="ghost"
                            iconOnly
                            iconShape="nested"
                            size="md"
                            aria-label={label ?? 'Emoji'}
                            aria-pressed={
                              value.kind === 'emoji' && value.emoji === emoji
                            }
                            disabled={disabled}
                            onClick={(): void => {
                              if (emoji)
                                onChange({ kind: 'emoji', emoji, color });
                            }}
                          >
                            <span className="text-lg" aria-hidden="true">
                              {emoji}
                            </span>
                          </Button>
                        </Tooltip>
                      ))}
                    </div>
                  </div>
                ))}
          {(tab === 'icons' ? icons.length === 0 : count === 0) ? (
            <SearchEmptyState
              title="Nothing matches your search."
              actionLabel="Clear search"
              onAction={(): void => setQuery('')}
            />
          ) : null}
          {tab === 'emojis' && count > limit ? (
            <Button
              variant="secondary"
              size="compact"
              onClick={(): void => setLimit(limit + EMOJI_PAGE)}
            >
              Show more emoji
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
