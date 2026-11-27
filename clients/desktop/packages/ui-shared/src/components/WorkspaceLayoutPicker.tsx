'use client';

import type { JSX } from 'react';
import { MenuControl, MenuItem } from '../primitives/MenuItem';
function IllustrationDivider({
  className,
  width,
  height = 1,
}: {
  className: string;
  width: number;
  height?: number;
}): JSX.Element {
  return (
    <svg
      className={className}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <line
        y1={height / 2}
        x2={width}
        y2={height / 2}
        stroke="currentColor"
        strokeOpacity={0.08}
        strokeWidth={height}
      />
    </svg>
  );
}
// Figma 15:201: artwork-specific colors intentionally preserve the supplied illustration.
function ChatWidthIllustration({
  full = false,
}: {
  full?: boolean;
}): JSX.Element {
  return (
    <span
      className={`chat-width-art${full ? ' chat-width-art-full' : ''}`}
      aria-hidden="true"
    >
      <span className="chat-width-art-panel">
        <span className="chat-width-art-title" />
        {[0, 1, 2, 3, 4].map((line) => (
          <span key={line} className={`chat-width-art-line line-${line}`} />
        ))}
      </span>
      <span className="chat-width-art-panel composer-layer">
        <span className="chat-width-art-composer" />
      </span>
    </span>
  );
}
// Updated Figma artwork 15:344, retaining the exported divider assets.
function LayoutIllustration({
  advanced = false,
}: {
  advanced?: boolean;
}): JSX.Element {
  const lines = advanced
    ? [
        [4, 9, 17],
        [4, 11, 15],
        [4, 13, 12],
        [28, 5, 20],
        [28, 7, 15],
        [28, 20, 18],
        [28, 22, 12],
        [28, 24, 8],
      ]
    : [
        [4, 9, 25.5],
        [4, 11, 22.5],
      ];
  return (
    <span className="chat-width-art" aria-hidden="true">
      <span className="chat-width-art-panel layout-window">
        <span
          className="layout-window-title"
          style={{ width: advanced ? 20 : 30 }}
        />
        {lines.map(([left, top, width], i) => (
          <span
            key={i}
            className="layout-window-line"
            style={{ left, top, width }}
          />
        ))}
        {advanced ? (
          <>
            <IllustrationDivider
              className="layout-window-divider split"
              width={32}
              height={1}
            />
            <IllustrationDivider
              className="layout-window-divider tabs-top"
              width={26}
              height={3}
            />
            <IllustrationDivider
              className="layout-window-divider tabs-bottom"
              width={26}
              height={3}
            />
          </>
        ) : (
          <>
            <IllustrationDivider
              className="layout-window-divider drawer"
              width={52}
              height={1}
            />
            <IllustrationDivider
              className="layout-window-divider sidebar"
              width={24}
              height={1}
            />
          </>
        )}
      </span>
      <span className="chat-width-art-panel layout-window composer-layer">
        <span
          className="layout-window-composer"
          style={{
            left: 3,
            top: advanced ? 24 : 15,
            width: advanced ? 20 : 30,
          }}
        />
      </span>
    </span>
  );
}

export interface WorkspaceLayoutPickerProps {
  mode: 'minimal' | 'advanced';
  chatWidth: 'default' | 'full';
  disabled?: boolean;
  onModeChange: (mode: 'minimal' | 'advanced') => void;
  onChatWidthChange: (width: 'default' | 'full') => void;
  onSaveDefault: () => void;
}
export function WorkspaceLayoutPicker({
  mode,
  chatWidth,
  disabled,
  onModeChange,
  onChatWidthChange,
  onSaveDefault,
}: WorkspaceLayoutPickerProps): JSX.Element {
  return (
    <div className="workspace-layout-picker">
      <div className="setting-section">
        <p className="label text-xs">Chat width</p>
        <div className="layouts" role="group" aria-label="Chat width">
          {(['default', 'full'] as const).map((value) => (
            <MenuControl
              key={value}
              type="button"
              choice={{ type: 'radio', checked: chatWidth === value }}
              disabled={disabled}
              data-testid={`workspace-chat-width-${value}`}
              presentation="workspace-layout-option"
              onClick={() => onChatWidthChange(value)}
            >
              <ChatWidthIllustration full={value === 'full'} />
              <span className="caption">
                {value === 'default' ? 'Default' : 'Full width'}
              </span>
            </MenuControl>
          ))}
        </div>
      </div>
      <div className="setting-section">
        <p className="label text-xs">Layout</p>
        <div
          className="layouts"
          role="group"
          aria-label="Layout mode"
          data-testid="workspace-layout-mode-toggle"
        >
          {(['minimal', 'advanced'] as const).map((value) => (
            <MenuControl
              key={value}
              type="button"
              choice={{ type: 'radio', checked: mode === value }}
              disabled={disabled}
              data-testid={`workspace-layout-mode-${value}`}
              presentation="workspace-layout-option"
              onClick={() => onModeChange(value)}
            >
              <LayoutIllustration advanced={value === 'advanced'} />
              <span className="caption">
                {value === 'minimal' ? 'Minimal' : 'Advanced'}
              </span>
            </MenuControl>
          ))}
        </div>
      </div>
      {mode === 'advanced' && (
        <>
          <hr className="divider" />
          <MenuItem
            data-testid="save-layout-default-item"
            onClick={onSaveDefault}
          >
            Save current layout as default
          </MenuItem>
        </>
      )}
    </div>
  );
}
