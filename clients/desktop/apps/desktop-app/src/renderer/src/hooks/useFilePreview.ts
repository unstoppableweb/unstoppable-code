import { useEffect, useState } from 'react';
import type { FilePreviewResponse } from '@canopy/desktop-shared/types';
import { cloudAttachmentPreview } from '@/cloud-chats/cloud-chat-attachments';

export type FilePreviewState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly preview: FilePreviewResponse }
  | { readonly status: 'failed' };

/**
 * Reads a local file's preview (`window.api.readFilePreview`): an image as a
 * data URL, a text file's content. Re-reads when the path changes; stays
 * `loading` while `enabled` is false.
 */
export function useFilePreview(
  absolutePath: string,
  enabled = true,
): FilePreviewState {
  const [state, setState] = useState<FilePreviewState>({ status: 'loading' });
  useEffect(() => {
    if (!enabled) return undefined;
    // A cloud chat's attachment is never read through main.
    const cloud = cloudAttachmentPreview(absolutePath);
    if (cloud !== undefined) {
      setState({ status: 'ready', preview: cloud });
      return undefined;
    }
    let cancelled = false;
    setState({ status: 'loading' });
    void window.api
      .readFilePreview({ absolutePath })
      .then((preview) => {
        if (!cancelled) setState({ status: 'ready', preview });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'failed' });
      });
    return (): void => {
      cancelled = true;
    };
  }, [absolutePath, enabled]);
  return state;
}
