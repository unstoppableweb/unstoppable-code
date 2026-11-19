import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useModelCatalogStore } from '@/stores/modelCatalogStore';
import { isCursorHarnessReleased } from '@/lib/cursor-settings';
import { useCursorChatAvailable } from './useCursorChatAvailable';

/**
 * Whether Settings → Harnesses shows a Cursor column, and whether Cursor is
 * connected there. The one place harnesses get connected; Customize reads it
 * to point "Connect a harness…" at the column that still needs it.
 */
export function useCursorHarnessState(enabled: boolean): {
  readonly cursorAvailable: boolean;
  readonly showCursor: boolean;
} {
  const modelGatewayEnforced = useModelCatalogStore(
    (state) => state.modelGatewayEnforced,
  );
  const cursorReleased = useFeatureFlagsStore(isCursorHarnessReleased);
  const cursorRuntimeAvailable = useCursorChatAvailable(enabled);
  const cursorAvailable = cursorRuntimeAvailable && !modelGatewayEnforced;
  return {
    cursorAvailable,
    showCursor: cursorAvailable || (cursorReleased && !modelGatewayEnforced),
  };
}
