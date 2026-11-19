import { useGitHubStore } from '@/stores/githubStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';

/**
 * The first message of the Pipelines page's interview chat (CAN-3487). It is
 * sent as the user's own turn, so it reads as something the user would say.
 * Cowork chats carry the pipeline actions (`pipeline.create` /
 * `pipeline.update` through `dispatch_action`), which is how the interview
 * ends with a saved pipeline.
 */
export const PIPELINE_INTERVIEW_PROMPT =
  'Interview me to help me build a workflow, then save it with the pipeline tools.';

/**
 * Opens a new Cowork chat in the default Cowork project and immediately sends
 * {@link PIPELINE_INTERVIEW_PROMPT}, the same route the Home composer takes
 * for a Cowork send. Resolves `false` (after surfacing a toast) when the chat
 * could not be started.
 */
export async function startPipelineInterviewChat(): Promise<boolean> {
  try {
    await useStandaloneChatStore.getState().createStandaloneChatWithMessage({
      message: PIPELINE_INTERVIEW_PROMPT,
    });
  } catch (error) {
    useGitHubStore
      .getState()
      .addToast("Couldn't start the chat. Try again.", 'error', undefined, {
        caught: error,
      });
    return false;
  }
  useNavigationStore.getState().navigate('chat');
  return true;
}
