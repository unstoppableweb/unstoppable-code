import {
  removeRepositoryGitEnv,
  useUnsignedGitConfig,
} from './git-repository-env.mjs';

// Jest globalSetup runs in the parent before workers fork, so the workers (and
// every child process they spawn) inherit the cleaned environment: no
// repository variables, and Git's global config with signing off. Globals set
// here reach only globalTeardown, which restores the environment.
export default function isolateGitEnv() {
  removeRepositoryGitEnv(process.env);
  globalThis.canopyRestoreTestGitConfig = useUnsignedGitConfig(process.env);
}
