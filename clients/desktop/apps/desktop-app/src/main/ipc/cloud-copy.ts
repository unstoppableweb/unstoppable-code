import { z } from 'zod';
import {
  IPC_CHANNELS,
  type CloudCopyAnalyzeResult,
  type CloudCopyAudience,
} from '@canopy/desktop-shared/types';
import type {
  RendererRelayEvent,
  RendererRelaySurfaceResolution,
} from '../canopy-runtime/renderer-relay/relay';
import { analyzeForCloudCopy } from '../cloud-copy/analyze-for-cloud-copy';
import { bindCloudCopyAnalysis } from '../pipelines/pipeline-package-service';
import { cloudChatsEnabled, signedInAccountId } from './cloud-chats';
import { registerIpcHandler } from './register';

const analyzeSchema = z.strictObject({
  entryId: z.string().min(1).max(512),
  expectedAccountId: z.string().min(1).max(256),
});

/**
 * The consent dialog's analysis of a desktop skill or plugin for its cloud
 * copy (CAN-6176 9c): only the app's own main window may call it, by the same
 * trusted-surface check as the cloud chats handlers, and only for the
 * account the cloud chat belongs to; remote control blocks it.
 */
export function registerCloudCopyHandlers(
  resolveSurface: (event: RendererRelayEvent) => RendererRelaySurfaceResolution,
  analyze: (
    entryId: string,
    accountId: string,
  ) => Promise<CloudCopyAnalyzeResult> = (entryId, accountId) =>
    analyzeForCloudCopy(entryId, accountId),
  accountId: () => Promise<string | null> = signedInAccountId,
  bind: (
    analysisId: string,
    accountId: string,
    audience: CloudCopyAudience,
  ) => void = bindCloudCopyAnalysis,
): void {
  registerIpcHandler(
    IPC_CHANNELS.cloudCopyAnalyze,
    async (event, raw: unknown): Promise<CloudCopyAnalyzeResult> => {
      let trusted = false;
      try {
        trusted = resolveSurface(event).surface === 'main';
      } catch {
        // An untrusted sender is refused below.
      }
      if (!trusted) throw new Error('Untrusted cloud copy sender.');
      const request = analyzeSchema.parse(raw);
      if (!cloudChatsEnabled()) return { ok: false, reason: 'disabled' };
      const signedIn = await accountId();
      if (signedIn === null) return { ok: false, reason: 'signed-out' };
      if (signedIn !== request.expectedAccountId)
        return { ok: false, reason: 'account-mismatch' };
      const result = await analyze(request.entryId, signedIn);
      // Its publish goes only to the account it was issued for, and only to
      // the audience the dialog showed.
      if (result.ok)
        bind(result.analysis.analysisId, signedIn, result.audience);
      return result;
    },
  );
}
