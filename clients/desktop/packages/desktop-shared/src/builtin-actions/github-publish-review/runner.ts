import { setOutput } from '../_lib/output';
import { runWithActionEnvironment } from '../_lib/action-env';
import { PIPELINE_HOST_FAILURE_REASON_OUTPUT } from '../../pipelines/host-actions';
import { publishReviewOutputs } from '@canopy/execution-engine/pipelines/host-publish-review';

/**
 * The Node fallback of `github-publish-review`, for runs without a host that
 * takes it (the CLI, which opts out, and legacy runs). It posts nothing: it
 * answers `unavailable: no_host`, so the preset's `gh` step posts and there
 * is exactly one `gh` path.
 */
export async function runGithubPublishReviewFallback(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await runWithActionEnvironment(env, () => {
    const outputs = publishReviewOutputs({
      status: 'unavailable',
      reason: 'no_host',
    });
    for (const [name, value] of Object.entries(outputs)) {
      setOutput(name, value);
    }
    setOutput(PIPELINE_HOST_FAILURE_REASON_OUTPUT, '');
    return Promise.resolve();
  });
}
