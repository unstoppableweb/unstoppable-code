/**
 * Where an E2E spec opts a cloud task into the cowork page (CAN-6333), set
 * before the page loads. Read only in E2E builds.
 */
export const CLOUD_CHATS_STANDALONE_PAGE_E2E_KEY =
  'canopy.e2e.cloudChatsUseStandalonePage';

/**
 * Whether a cloud task opens in the cowork page, like a local task, instead
 * of on CloudChatPage (CAN-6175 R2). Off until the cowork page serves what
 * CloudChatPage does for cloud chats today: the catalog model picker,
 * attachments, questions and agent tasks. R2b turns it on and deletes
 * CloudChatPage. An E2E build lets a spec turn it on, so the cowork page's
 * cloud path is covered before then; packaged builds never read the opt-in.
 */
export const cloudChatsUseStandalonePage: boolean =
  __CANOPY_E2E__ &&
  globalThis.localStorage?.getItem(CLOUD_CHATS_STANDALONE_PAGE_E2E_KEY) === '1';
