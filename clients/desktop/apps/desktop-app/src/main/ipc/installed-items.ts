import { classifyError } from '@canopy/protocol/app-errors/classification';
import {
  SetInstalledItemStatusRequestSchema,
  UninstallInstalledItemRequestSchema,
} from '@canopy/protocol/installed-items';
import { INSTALLED_ITEM_CHANNELS } from '@canopy/desktop-shared/types/installed-items';
import { registerIpcHandler } from './register';

export function registerInstalledItemHandlers(): void {
  registerIpcHandler(
    INSTALLED_ITEM_CHANNELS.LIST_STATUS,
    async (_event, request: unknown) => {
      if (request !== undefined)
        throw classifyError(
          new Error('Installed item status does not take a request body.'),
          'input.not_accepted',
        );
      const { installedItemService } =
        await import('../installed-items/installed-item-service');
      return installedItemService.listStatus();
    },
  );
  registerIpcHandler(
    INSTALLED_ITEM_CHANNELS.SET_STATUS,
    async (_event, request: unknown) => {
      const parsed = SetInstalledItemStatusRequestSchema.parse(request);
      const { installedItemService } =
        await import('../installed-items/installed-item-service');
      return installedItemService.setStatus(parsed);
    },
  );
  registerIpcHandler(
    INSTALLED_ITEM_CHANNELS.UNINSTALL,
    async (_event, request: unknown) => {
      const parsed = UninstallInstalledItemRequestSchema.parse(request);
      const { installedItemService } =
        await import('../installed-items/installed-item-service');
      return installedItemService.uninstall(parsed);
    },
  );
}
