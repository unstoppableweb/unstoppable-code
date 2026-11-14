import {
  removeRepositoryGitEnv,
  useUnsignedGitConfig,
} from './git-repository-env.mjs';
import { createJestRunDataRoot } from './jest-data-root.mjs';

// Jest globalSetup runs in the parent before workers fork, so the workers (and
// every child process they spawn) inherit the cleaned environment: no
// repository variables, and Git's global config with signing off. Globals set
// here reach only globalTeardown, which restores the environment.
//
// It also makes the run's data root directory, which every worker's private
// data root goes in, and globalTeardown removes it (CAN-6669).
export default function isolateGitEnv() {
  removeRepositoryGitEnv(process.env);
  globalThis.canopyRestoreTestGitConfig = useUnsignedGitConfig(process.env);
  globalThis.canopyJestRunDataRoot = createJestRunDataRoot(process.env);
}
