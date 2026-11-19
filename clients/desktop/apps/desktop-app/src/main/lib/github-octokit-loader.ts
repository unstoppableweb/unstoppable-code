import { loadRequiredNodeModuleExport } from '@canopy/desktop-shared/node/lib/packaged-module-loader';
import type { Octokit } from '@octokit/rest';
import type {
  OctokitBrokerClientOptions,
  OctokitClientOptions,
} from './github-octokit-options';

export type OctokitConstructor = new (
  options: OctokitClientOptions | OctokitBrokerClientOptions,
) => Octokit;

let octokitConstructor: OctokitConstructor | null = null;

export function loadOctokitConstructor(): OctokitConstructor {
  if (!octokitConstructor) {
    octokitConstructor = loadRequiredNodeModuleExport<OctokitConstructor>({
      moduleId: '@octokit/rest',
      exportName: 'Octokit',
      requireFrom: __filename,
      validate: (value): value is OctokitConstructor =>
        typeof value === 'function',
    });
  }

  return octokitConstructor;
}
