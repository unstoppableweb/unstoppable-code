import {
  askPersonToConfirm,
  type RequestPersonAnswers,
} from '../lib/ask-user-outcomes';
import type { AdvisorCollectionSharingHost } from './advisor-collection-sharing-actions';
import {
  memberOrganizationIds,
  selectedOrganizationId,
} from './advisor-sharing-actions-host';
import { chatDriver } from '../remote-control/host/chat-drivers';
import { mainSharedImportPort } from './shared-import-port';

/**
 * The owners behind App Advisor's collection sharing actions (CAN-6003 part
 * B): the window's collection handlers, the shared collection payload and
 * import over Electron main's skill and plugin owners, the window's
 * organization context and memberships, and this chat's AskUserQuestion.
 */
export function mainAdvisorCollectionSharingHost(options: {
  chatId: string;
  requestUserAnswers: RequestPersonAnswers;
}): AdvisorCollectionSharingHost {
  // A chat a controlling computer drives imported in that computer's window
  // before, as a remote principal; its plugin installs stay one.
  const port = mainSharedImportPort({
    remote: chatDriver(options.chatId) !== null,
  });
  return {
    selectedOrganizationId,
    memberOrganizationIds,
    loadCollection: async (id) =>
      (
        await (
          await import('../collections/collection-store')
        ).readCollectionConfig(id)
      )?.collection ?? null,
    editable: async (config) => {
      const [skills, marketplaces, { convertLocalCollectionToEditable }] =
        await Promise.all([
          port.skills.loadSkills(),
          port.plugins.loadMarketplaces(),
          import('@canopy/desktop-shared/collections/shared-collection-payload'),
        ]);
      if (!skills.success || !skills.data)
        throw new Error(skills.error ?? 'Failed to load installed skills.');
      if (!marketplaces.success || !marketplaces.data)
        throw new Error(
          marketplaces.error ?? 'Failed to load plugin marketplaces.',
        );
      return convertLocalCollectionToEditable({
        config,
        installedSkills: skills.data,
        marketplaces: marketplaces.data.marketplaces.map((marketplace) => ({
          id: marketplace.id,
          sourceUrl: marketplace.sourceUrl,
        })),
      }).editable;
    },
    payload: async (editable) =>
      (
        await import('@canopy/desktop-shared/collections/shared-collection-payload')
      ).buildSharedCollectionPayload({
        name: editable.name,
        description: editable.description,
        items: editable.items,
        customSkillReader: (localSkillId) =>
          port.skills.readRawSkill(localSkillId),
      }),
    listShared: async (request) =>
      (
        await import('../collections/collection-handlers')
      ).listSharedCollectionsForCaller(request),
    getShared: async (collectionId) =>
      (
        await import('../collections/collection-handlers')
      ).getSharedCollectionForCaller(collectionId),
    createShared: async (request) =>
      (
        await import('../collections/collection-handlers')
      ).createSharedCollectionForCaller(request),
    updateShared: async (request) =>
      (
        await import('../collections/collection-handlers')
      ).updateSharedCollectionForCaller(request),
    deleteShared: async (collectionId) =>
      (
        await import('../collections/collection-handlers')
      ).deleteSharedCollectionForCaller({ collectionId }),
    resolveImport: async (detail) =>
      (
        await import('@canopy/desktop-shared/lib/shared-import/shared-collection-import')
      ).resolveSharedCollectionImport(port, detail),
    saveCollection: async (collection) =>
      (
        await import('../collections/collection-handlers')
      ).saveCollectionForCaller(collection),
    installPackage: async (request) =>
      (
        await import('../collections/collection-handlers')
      ).installCollectionPackageForCaller(request),
    confirm: (question, labels) =>
      askPersonToConfirm(options.requestUserAnswers, question, labels),
  };
}
