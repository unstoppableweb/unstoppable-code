import { removeRepositoryGitEnv } from './git-repository-env.mjs';

// Jest globalSetup runs in the parent before workers fork, so the workers (and
// every child process they spawn) inherit the cleaned environment.
export default function isolateGitEnv() {
  removeRepositoryGitEnv(process.env);
}
