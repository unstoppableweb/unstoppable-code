import { mkdtempSync, rmSync } from 'node:fs';
import {
  mkdtemp,
  realpath,
  readFile,
  writeFile,
  rename,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { WindowsColdInspectionError } from '@canopy/core-platform';
import {
  migrateInternalRoot,
  InternalRootMigrationRefused,
  type InternalRootIdentity,
  type InternalRootMigrationWorker,
  type InternalRootRepairs,
} from '@canopy/core-runtime/node/internal-root-migration';
import {
  createInternalRootMigrationWorker,
  internalRootIdentity,
  isWithinInternalRoot,
} from '@canopy/desktop-shared/node/internal-root-migration';
import {
  internalRootFilesystemHost,
  createPrivateMigrationDirectory,
} from '@canopy/desktop-shared/node/internal-root-migration/filesystem-host';
import { statIfPresent } from '@canopy/desktop-shared/node/internal-root-migration/filesystem';
import {
  internalRootColdHost,
  assertInternalRootNativeCold,
} from '@canopy/desktop-shared/node/internal-root-migration/native-cold';
import {
  W5CommitLog,
  fingerprintW5File,
} from '@canopy/core-runtime/node/w5/commit-log';
import {
  prepareRelocationGit,
  repairRelocationGit,
  relocationTransition,
  movedOwnedPath,
} from '@canopy/core-runtime/node/relocation';
import canopy from '../../../../../../../brands/canopy/brand.json';
import unstoppableCode from '../../../../../../../brands/unstoppable-code/brand.json';
import { settleInternalRootW5 } from '../../internal-root-migration-maintenance';
import { startedWorkers } from '../../../ledger/__tests__/fixtures/tsx-worker-threads';

export type ComposedMigrationOutcome = {
  brand: string;
  scenario: string;
  outcome: string;
  diagnostic?: string;
  attempt?: number;
  stage?: string;
  reason?: string;
  pid?: number;
  image?: string;
  inspectionReason?: WindowsColdInspectionError['reason'];
  continuity?: {
    before: WindowsColdInspectionError['before'];
    after: WindowsColdInspectionError['after'];
  };
  observation?: string;
  verification?: string;
  refusals?: readonly {
    reason: string;
    diagnostic: string;
    ancestry?: readonly number[];
  }[];
};

// One transaction fixture, two evidence scopes: native filesystem + fixture cold
// proof in CI, complete unfiltered host observation only in the manual receipt.
export function defineComposedMigrationCases({
  wholeHost,
  assertExactHead,
}: {
  wholeHost: boolean;
  assertExactHead?: () => Promise<void>;
}): ComposedMigrationOutcome[] {
  const receipts: ComposedMigrationOutcome[] = [];
  (wholeHost || process.platform !== 'darwin' ? describe : describe.skip)(
    wholeHost
      ? 'native composed v7 migration (CAN-5942 / CAN-5786)'
      : 'composed v7 outcomes (fixture cold proof)',
    () => {
      let home: string;
      let identity: InternalRootIdentity;
      let worker: InternalRootMigrationWorker;
      let host: ReturnType<typeof internalRootFilesystemHost>;
      let ownedChildPath: string;
      let nativeBuild: string | undefined;
      let settledFingerprint: string | undefined;
      const phaseCases = [
        {
          brand: canopy,
          phases: [
            'prepared',
            'building',
            'exposure',
            'complete',
            'rebuilding',
          ],
          completionPasses: 1,
        },
        {
          brand: unstoppableCode,
          phases: [
            'source-settled',
            'copy',
            'publication',
            'restoring-external',
          ],
          completionPasses: 2,
        },
      ];
      if (!wholeHost) {
        const phases = phaseCases.flatMap((row) => row.phases);
        for (const row of phaseCases) row.phases = phases;
      }
      const unresolvedCases = ['commit', 'reservation'] as const;
      // Windows 20261107T064328: ~50s per interruption/resume on a loaded desktop.
      // V7 adds two secure-completion proof groups and one populated-secure
      // rebuild refusal per brand to the v6 workload. Never abandon a proof.
      const phaseCostMs = 50_000;
      const phaseAllowanceMs = phaseCostMs * 1.25;
      const admissionBudgetMs = 3 * 60_000;
      const secureCompletionGroupsPerBrand = 2;
      const populatedSecureRebuildRefusalsPerBrand = 1;
      const brandBudgetUnits = (row: (typeof phaseCases)[number]): number =>
        row.phases.length +
        row.completionPasses +
        secureCompletionGroupsPerBrand +
        populatedSecureRebuildRefusalsPerBrand;
      const matrixBudgetMs =
        (phaseCases.reduce((count, row) => count + brandBudgetUnits(row), 0) +
          unresolvedCases.length) *
          phaseAllowanceMs +
        admissionBudgetMs;
      const caseBudgetMs =
        admissionBudgetMs +
        Math.max(...phaseCases.map(brandBudgetUnits)) * phaseAllowanceMs;
      const caseTimeoutMs = caseBudgetMs + 60_000;
      const maxAdmissionAttempts = 2;
      let matrixStartedAt: number;
      let matrixDeadline: number;
      let caseStartedAt: number;
      let caseDeadline: number;
      let caseName: string;
      let scenario: string;
      let proofOrdinal: number;
      let activeCase: Promise<void> | undefined;
      let inspection: WindowsColdInspectionError | undefined;
      function nativeCase<Args extends unknown[]>(
        operation: (...args: Args) => Promise<void>,
      ): (...args: Args) => Promise<void> {
        return (...args): Promise<void> => {
          caseStartedAt = performance.now();
          caseDeadline = Math.min(matrixDeadline, caseStartedAt + caseBudgetMs);
          caseName = expect.getState().currentTestName ?? 'unknown case';
          scenario = 'setup';
          proofOrdinal = 0;
          activeCase = (async (): Promise<void> => {
            let passed = false;
            try {
              await assertExactHead?.();
              try {
                await operation(...args);
              } finally {
                await assertExactHead?.();
              }
              passed = true;
            } finally {
              if (wholeHost) {
                const now = performance.now();
                process.stdout.write(
                  `CAN-5942 native case duration ${JSON.stringify({
                    case: caseName,
                    brand: identity.brandId,
                    scenario,
                    status: passed ? 'passed' : 'failed',
                    elapsedCaseMs: Math.round(now - caseStartedAt),
                    elapsedMatrixMs: Math.round(now - matrixStartedAt),
                    proofs: proofOrdinal,
                  })}\n`,
                );
              }
            }
          })();
          return activeCase;
        };
      }
      function assertCaseBudget(label: string): void {
        proofOrdinal++;
        const now = performance.now();
        if (now >= caseDeadline)
          throw Object.assign(
            new Error(
              `Native proof-start budget exhausted: ${JSON.stringify({
                case: caseName,
                scenario,
                proof: { label, ordinal: proofOrdinal },
                elapsedMatrixMs: Math.round(now - matrixStartedAt),
                elapsedCaseMs: Math.round(now - caseStartedAt),
                effectiveDeadlineMs: Math.round(caseDeadline - matrixStartedAt),
                limitingDeadline:
                  matrixDeadline <= caseStartedAt + caseBudgetMs
                    ? 'matrix'
                    : 'case',
                matrixBudgetMs,
                caseBudgetMs,
              })}`,
            ),
            {
              code: 'NATIVE_PROOF_START_BUDGET_EXHAUSTED',
              stage: 'proof-start',
            },
          );
      }
      const location = { kind: 'repository' as const, root: resolve('.') };
      const windowsProcessPath = resolve(
        '.cache/bin/win32-x64/canopy-process-identity.exe',
      );
      const entry = join(__dirname, 'w5-commit-log-source-worker.ts');
      const apply = { apply: true, declareInternal: true };
      const noRepairs: InternalRootRepairs = {
        prepare: () => Promise.resolve({ kind: 'ready', externalFiles: [] }),
        repair: () => Promise.resolve({ kind: 'ok' }),
        verify: () => Promise.resolve({ kind: 'ok' }),
        qualifyPublished: () => Promise.resolve({ kind: 'ok' }),
      };
      beforeAll(() => {
        ownedChildPath = resolve(
          (!wholeHost && process.env.CANOPY_OWNED_CHILD_ADDON) ||
            join(
              '.cache/native-owned-child',
              `${process.platform}-${process.arch}`,
              'core-owned-child.node',
            ),
        );
        if (!wholeHost && process.platform === 'linux') {
          nativeBuild = mkdtempSync(join(tmpdir(), 'composed-native-'));
          ownedChildPath = join(nativeBuild, 'core-owned-child.node');
          execFileSync(
            process.execPath,
            [resolve('scripts/build-owned-child.mjs'), '--out', ownedChildPath],
            { stdio: 'pipe' },
          );
        }
        matrixStartedAt = performance.now();
        matrixDeadline = matrixStartedAt + matrixBudgetMs;
      }, 60_000);
      afterAll(() => {
        if (nativeBuild) rmSync(nativeBuild, { recursive: true, force: true });
        process.stdout.write(
          `CAN-5942 ${wholeHost ? 'native' : 'fixture-cold'} outcomes ${JSON.stringify(receipts)}\n`,
        );
      });
      function assertNoRecoveryWorkers(): void {
        expect(
          startedWorkers
            .filter((entry) => entry.exitCode === undefined)
            .map((entry) => entry.filename),
        ).toEqual([]);
      }
      beforeEach(async () => {
        assertNoRecoveryWorkers();
        const temporary = await realpath(tmpdir());
        // W5 binds a Unix socket: runner TMPDIRs can exceed its address budget.
        const endpoint = join(
          temporary,
          'b23-XXXXXX',
          '.unstoppable-code',
          'runtime',
          '.000000000000',
        );
        const parent =
          process.platform === 'win32' || Buffer.byteLength(endpoint) <= 103
            ? temporary
            : await realpath('/tmp');
        home = await realpath(await mkdtemp(join(parent, 'b23-')));
        identity = internalRootIdentity(home, canopy);
        host = internalRootFilesystemHost(ownedChildPath);
        settledFingerprint = undefined;
        activeCase = undefined;
        inspection = undefined;
        worker = createInternalRootMigrationWorker({
          ownedChildPath,
          ...(wholeHost
            ? { nativeColdHost: location }
            : { proveCold: (): Promise<void> => Promise.resolve() }),
          executableBrands: [canopy, unstoppableCode],
          recoverW5: async (source, qualification) => {
            // CI substitutes admission only, as the legacy offline matrix does;
            // Windows still requires custody/process helpers and a real W5 writer.
            // The manual receipt must retain the worker-issued native callback.
            const assertCold = wholeHost
              ? qualification.assertCold
              : qualification.assertHeld;
            await settleInternalRootW5(
              source,
              entry,
              {
                ...qualification,
                ...(assertCold
                  ? {
                      assertCold: (): Promise<void> =>
                        boundedProof('W5 qualification.assertCold', assertCold),
                    }
                  : {}),
              },
              { ownedChildPath, windowsProcessPath },
            );
            settledFingerprint = (await worker.inventory(identity)).fingerprint;
          },
        });
        const proveCold = worker.proveCold.bind(worker);
        worker.proveCold = (...args): Promise<void> =>
          boundedProof('worker.proveCold', () => proveCold(...args));
      });
      async function boundedProof(
        label: string,
        operation: () => Promise<void>,
      ): Promise<void> {
        assertCaseBudget(label);
        inspection = undefined;
        try {
          await operation();
        } catch (error) {
          if (
            error instanceof InternalRootMigrationRefused &&
            'cause' in error &&
            error.cause instanceof WindowsColdInspectionError
          )
            inspection = error.cause;
          throw error;
        }
      }
      afterEach(async () => {
        // Jest timeout does not cancel promises. Drain the case before touching its
        // files; its rejection is reported by the test, not swallowed as success.
        await activeCase?.catch(() => undefined);
        assertNoRecoveryWorkers();
        if (await statIfPresent(identity.coordination)) {
          const release = await worker.coordinate(identity);
          await release();
          expect(
            await statIfPresent(
              join(identity.coordination, 'coordination.sqlite-journal'),
            ),
          ).toBeNull();
        }
        await rm(home, { recursive: true, force: true });
      }, caseTimeoutMs);
      async function seed(
        brand: typeof canopy | typeof unstoppableCode = canopy,
        unresolved?: 'commit' | 'reservation',
      ): Promise<void> {
        identity = internalRootIdentity(home, brand);
        for (const directory of [identity.source, identity.historicalSecure])
          await createPrivateMigrationDirectory(directory, host);
        for (const name of ['runtime', 'workspaces', 'w5'])
          await createPrivateMigrationDirectory(
            join(identity.source, name),
            host,
          );
        await writeFile(
          join(identity.source, 'preferences.json'),
          '{"theme":"dark"}',
          { mode: 0o600 },
        );
        await writeFile(
          join(identity.historicalSecure, 'opaque'),
          Buffer.from([0, 255, 23]),
          { mode: 0o600 },
        );
        const path = join(identity.source, 'workspaces/index.json');
        const before = '{"version":1,"workspaces":[]}';
        await writeFile(path, before, { mode: 0o600 });
        const log = W5CommitLog.open(
          join(identity.source, 'w5/commit-log.sqlite'),
        );
        try {
          log.commit({
            operation: 'core.workspace.update',
            advance: [{ kind: 'workspaces' }],
            files: [
              {
                path,
                contents: '{"version":1,"workspaces":[],"saved":true}',
                previousFingerprint: fingerprintW5File(before),
              },
            ],
            outcome: { saved: true },
          });
          if (unresolved === 'reservation')
            log.reserve({
              reservationId: 'uncertain',
              operation: 'core.worktree.create',
              diagnostics: {},
            });
        } finally {
          log.close();
        }
        if (unresolved === 'commit')
          await writeFile(
            path,
            '{"version":1,"workspaces":[],"operatorEdit":true}',
          );
      }
      async function run(
        effects = worker,
        repairs = noRepairs,
      ): ReturnType<typeof migrateInternalRoot> {
        return migrateInternalRoot(effects, identity, apply, repairs);
      }
      // Share the same full-snapshot policy and ancestry verification before
      // admission AND after it: a concurrent runner may start a writer at any proof.
      function createRefusalVerifier(scenario: string): {
        verify: (
          refusal: Pick<InternalRootMigrationRefused, 'reason' | 'recovery'>,
          stage: string,
          attempt: number,
        ) => Promise<boolean>;
        attempts: typeof receipts;
        refusals: {
          reason: string;
          diagnostic: string;
          ancestry?: readonly number[];
        }[];
        deadline: number;
      } {
        const refusals: {
          reason: string;
          diagnostic: string;
          ancestry?: readonly number[];
        }[] = [];
        const attempts: (typeof receipts)[number][] = [];
        const admissionDeadline = performance.now() + admissionBudgetMs;
        async function verify(
          refusal: {
            readonly reason: InternalRootMigrationRefused['reason'];
            readonly recovery: string;
          },
          stage: string,
          attempt: number,
        ): Promise<boolean> {
          const receipt: (typeof receipts)[number] = {
            brand: identity.brandId,
            scenario,
            outcome: 'admission-attempt',
            attempt: attempt + 1,
            stage,
            reason: refusal.reason,
            diagnostic: refusal.recovery,
            observation: '',
            verification: 'unverified',
          };
          receipts.push(receipt);
          attempts.push(receipt);
          if (refusal.reason === 'cold-proof-unavailable') {
            receipt.verification = 'typed-cold-refusal';
            expect(refusal.recovery).toMatch(/inspect|incomplete/i);
            if (inspection) {
              receipt.inspectionReason = inspection.reason;
              receipt.pid = inspection.pid;
              receipt.image = inspection.image;
              receipt.continuity = {
                before: inspection.before,
                after: inspection.after,
              };
              expect(refusal.recovery).toContain(inspection.reason);
              expect(refusal.recovery).toContain(inspection.image);
              expect(refusal.recovery).toContain(`pid ${inspection.pid}`);
            }
            refusals.push({
              reason: refusal.reason,
              diagnostic: refusal.recovery,
            });
            return true;
          }
          // A separate runner may start product fixtures under this same user.
          // Accept refusal only with positive ancestry evidence, never by PID absence.
          const match = /^Product executable (\d+) remains;/.exec(
            refusal.recovery,
          );
          if (refusal.reason !== 'writer-active' || !match)
            throw new Error(
              `Unexpected native admission: ${JSON.stringify({ scenario, source: identity.source, coldProof: refusal })}`,
            );
          assertNoRecoveryWorkers();
          const os = process.platform;
          if (os !== 'win32' && os !== 'linux')
            throw new Error('Native host required');
          receipt.pid = Number(match[1]);
          const observer = internalRootColdHost(os, location);
          if (performance.now() >= admissionDeadline) {
            receipt.verification =
              'admission-budget-exhausted-before-verification';
            return false;
          }
          const roots = [
            identity.source,
            identity.destination,
            identity.historicalSecure,
            identity.coordination,
            worker.stagingRoot(identity),
          ];
          const observe: (
            roots: readonly string[],
          ) => ReturnType<typeof observer.observe> = observer.observe;
          assertCaseBudget('writer verification observation');
          const rows = await observe(roots).catch((error: unknown) => {
            receipt.verification = `snapshot-inspection-failed: ${error instanceof WindowsColdInspectionError ? `${error.reason}: ` : ''}${error instanceof Error ? error.message : String(error)}`;
            if (error instanceof WindowsColdInspectionError) {
              receipt.inspectionReason = error.reason;
              receipt.image = error.image;
              receipt.observation = JSON.stringify({
                inspectionPid: error.pid,
                before: error.before,
                after: error.after,
              });
            }
            return undefined;
          });
          if (!rows)
            throw new Error(
              `Writer verification failed: ${JSON.stringify(receipt)}`,
            );
          const byPid = new Map(rows.map((row) => [row.pid, row]));
          const ancestors = new Set<number>([process.ppid]);
          let parent: number | null = process.ppid;
          while (parent && !ancestors.has(byPid.get(parent)?.parentPid ?? -1)) {
            const next: number | null = byPid.get(parent)?.parentPid ?? null;
            if (!next) break;
            expect(next).not.toBe(process.pid);
            ancestors.add(next);
            parent = next;
          }
          let pid = Number(match[1]);
          const seen = new Set<number>();
          const writer = byPid.get(pid);
          receipt.observation = JSON.stringify(
            writer
              ? {
                  pid: writer.pid,
                  scope: writer.scope,
                  parentPid: writer.parentPid,
                  startIdentity: writer.startIdentity,
                  executable: writer.executable,
                }
              : null,
          );
          // A disappeared/exited/post-T row cannot verify the previous refusal.
          // Restart admission rather than accepting a writer on PID absence.
          if (
            !writer ||
            writer.scope === 'exited' ||
            writer.scope === 'post-t'
          ) {
            receipt.verification = `writer-${writer?.scope ?? 'absent'}`;
            return false;
          }
          expect(writer.scope).toBe('same-user');
          expect(writer.startIdentity).toBeTruthy();
          // PID reuse alone is not evidence of a product writer. Reapply B2-1's
          // product policy to the complete second snapshot, without filtering it.
          let productVerified = false;
          let policyDiagnostic = 'ready';
          try {
            await assertInternalRootNativeCold({
              os,
              // Keep every row: policy reports its first writer, so prioritize the
              // named candidate without letting another product mask its identity.
              rows: rows.toSorted(
                (left, right) =>
                  Number(right.pid === writer.pid) -
                  Number(left.pid === writer.pid),
              ),
              roots,
              brands: [canopy, unstoppableCode],
              managedPids: new Set(),
            });
          } catch (error) {
            if (!(error instanceof InternalRootMigrationRefused)) throw error;
            policyDiagnostic = `${error.reason}: ${error.recovery}`;
            productVerified =
              error.reason === 'writer-active' &&
              /^Product executable (\d+) remains;/.exec(error.recovery)?.[1] ===
                match[1];
          }
          if (!productVerified) {
            receipt.verification = `second-policy-did-not-confirm-writer: ${policyDiagnostic}`;
            throw new Error(
              `Writer verification failed: ${JSON.stringify(receipt)}`,
            );
          }
          while (pid && !ancestors.has(pid)) {
            expect(pid).not.toBe(process.pid);
            if (seen.has(pid)) throw new Error('Cyclic process ancestry');
            seen.add(pid);
            const row = byPid.get(pid);
            if (!row || row.parentPid === null) {
              receipt.verification = `incomplete-ancestry-at-${pid}: ${JSON.stringify([...seen])}`;
              throw new Error(
                `Writer verification failed: ${JSON.stringify(receipt)}`,
              );
            }
            pid = row.parentPid;
          }
          receipt.verification = 'verified-external-writer';
          refusals.push({
            reason: refusal.reason,
            diagnostic: refusal.recovery,
            ancestry: [...seen, pid],
          });
          return true;
        }
        return { verify, attempts, refusals, deadline: admissionDeadline };
      }
      // Whole-user observation is never filtered to make a desktop session cold.
      // Refusal is evidence of fail-closed admission, NOT of phase composition.
      async function admitOrAssertColdRefusal(
        scenarioName: string,
      ): Promise<boolean> {
        scenario = `${scenarioName} admission`;
        if (!wholeHost) return true;
        const before = await worker.inventory(identity);
        const secureBefore = await readFile(
          join(identity.historicalSecure, 'opaque'),
        );
        async function assertUnchanged(): Promise<void> {
          expect((await worker.inventory(identity)).fingerprint).toBe(
            before.fingerprint,
          );
          expect(
            await readFile(join(identity.historicalSecure, 'opaque')),
          ).toEqual(secureBefore);
          expect(await statIfPresent(identity.coordination)).toBeNull();
          expect(await statIfPresent(identity.destination)).toBeNull();
        }
        const {
          verify,
          attempts,
          refusals,
          deadline: admissionDeadline,
        } = createRefusalVerifier(scenarioName);
        let attempt = 0;
        let stage = 'inventory';
        for (attempt = 0; attempt < maxAdmissionAttempts; attempt++) {
          if (performance.now() >= admissionDeadline) break;
          stage = 'inventory';
          refusals.length = 0;
          const inventory = await migrateInternalRoot(
            worker,
            identity,
            { ...apply, apply: false },
            noRepairs,
          );
          if (inventory.kind !== 'inventory')
            throw new Error('Expected inventory');
          if (inventory.coldProof.kind === 'ready') return true;
          if (!(await verify(inventory.coldProof, stage, attempt))) {
            await assertUnchanged();
            continue;
          }
          // Apply must independently prove its refusal. If the host becomes cold,
          // stop at prepare (before coordination/mutation) and run the real scenario.
          const admitted = new Error('Native admission became ready');
          let verified = false;
          let ready = false;
          stage = 'apply';
          if (performance.now() >= admissionDeadline) break;
          try {
            await run(worker, {
              ...noRepairs,
              prepare: () => {
                throw admitted;
              },
            });
            throw new Error('Apply bypassed admission probe');
          } catch (error) {
            if (error === admitted) ready = true;
            else if (error instanceof InternalRootMigrationRefused)
              verified = await verify(
                {
                  reason: error.reason,
                  recovery: error.recovery,
                },
                stage,
                attempt,
              );
            else throw error;
          }
          await assertUnchanged();
          if (ready) return true;
          if (!verified) continue;
          receipts.push({
            brand: identity.brandId,
            scenario: scenarioName,
            outcome: refusals.some(
              (refusal) => refusal.reason === 'writer-active',
            )
              ? 'writer-refusal-only'
              : 'cold-refusal-only',
            diagnostic: inventory.coldProof.recovery,
            refusals: [...refusals],
          });
          return false;
        }
        throw new Error(
          `Native admission exhausted ${maxAdmissionAttempts} attempts or ${admissionBudgetMs}ms (external writer churn or incomplete verification): ${scenarioName}: ${JSON.stringify(attempts)}`,
        );
      }
      async function expectNativeError(
        operation: Promise<unknown>,
        expected: Error | InternalRootMigrationRefused['reason'],
        diagnostic?: string,
      ): Promise<void> {
        try {
          await operation;
        } catch (error) {
          if (error === expected) return;
          if (
            typeof expected === 'string' &&
            error instanceof InternalRootMigrationRefused &&
            error.reason === expected
          ) {
            if (diagnostic) expect(error.recovery).toContain(diagnostic);
            return;
          }
          throw error;
        }
        throw new Error(`Native operation did not reject: ${String(expected)}`);
      }
      async function assertNativeOutcome(
        scenarioName: string,
        operation: () => Promise<void>,
      ): Promise<boolean> {
        scenario = scenarioName;
        if (!wholeHost) {
          await operation();
          return true;
        }
        const { verify, attempts, refusals, deadline } =
          createRefusalVerifier(scenarioName);
        for (let attempt = 0; attempt < maxAdmissionAttempts; attempt++) {
          try {
            await operation();
            return true;
          } catch (error) {
            if (!(error instanceof InternalRootMigrationRefused)) throw error;
            if (await verify(error, 'apply', attempt)) {
              receipts.push({
                brand: identity.brandId,
                scenario: scenarioName,
                outcome:
                  error.reason === 'writer-active'
                    ? 'writer-refusal-only'
                    : 'cold-refusal-only',
                diagnostic: error.recovery,
                refusals: [...refusals],
              });
              return false;
            }
            // Retry only a vanished named writer, once, with all proofs rerun.
            // Budget/inspection/policy failures must not become a passing refusal.
            if (performance.now() >= deadline) break;
          }
        }
        throw new Error(
          `Native apply exhausted ${maxAdmissionAttempts} attempts (external writer churn or incomplete verification): ${scenarioName}: ${JSON.stringify(attempts)}`,
        );
      }
      async function assertRetained(): Promise<void> {
        expect((await worker.inventory(identity)).fingerprint).toBe(
          settledFingerprint,
        );
        expect(
          await readFile(join(identity.source, 'preferences.json'), 'utf8'),
        ).toBe('{"theme":"dark"}');
        const journal = await worker.readJournal(identity);
        const secure =
          journal?.secureRelocation === 'complete'
            ? join(identity.destination, 'secure-storage')
            : identity.historicalSecure;
        expect(await readFile(join(secure, 'opaque'))).toEqual(
          Buffer.from([0, 255, 23]),
        );
        if (journal?.secureRelocation === 'complete')
          expect(await statIfPresent(identity.historicalSecure)).toBeNull();
        expect(
          await statIfPresent(
            join(identity.source, 'runtime/w5-maintenance.json'),
          ),
        ).toBeNull();
        expect(
          await statIfPresent(
            join(identity.source, 'runtime/startup-claim.json'),
          ),
        ).toBeNull();
      }
      test.each(phaseCases)(
        '$brand.id W5 + Git: phase interruptions/resumes and uninterrupted completion',
        nativeCase(async ({ brand, phases }: (typeof phaseCases)[number]) => {
          await seed(brand);
          if (!(await admitOrAssertColdRefusal('W5 + Git'))) return;
          const common = join(home, 'repository');
          await createPrivateMigrationDirectory(common, host);
          const git = async (
            cwd: string,
            args: readonly string[],
          ): Promise<string> =>
            (
              await promisify(execFile)(
                'git',
                ['--no-optional-locks', ...args],
                {
                  cwd,
                  env: {
                    ...process.env,
                    GIT_CONFIG_GLOBAL:
                      process.platform === 'win32' ? 'NUL' : '/dev/null',
                    GIT_CONFIG_NOSYSTEM: '1',
                    GIT_OPTIONAL_LOCKS: '0',
                    GIT_AUTHOR_NAME: 'Fixture',
                    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
                    GIT_COMMITTER_NAME: 'Fixture',
                    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
                  },
                },
              )
            ).stdout;
          await git(common, ['init']);
          await writeFile(join(common, 'tracked'), 'base\n');
          await git(common, ['add', 'tracked']);
          await git(common, ['commit', '-m', 'fixture']);
          const managed = join(identity.source, 'checkout');
          await git(common, ['worktree', 'add', '-b', 'managed', managed]);
          await writeFile(join(managed, 'tracked'), 'dirty\n');
          await writeFile(join(managed, 'untracked'), 'preserve\n');
          const transition = relocationTransition({
            version: 1,
            installationId: 'fixture',
            brandId: identity.brandId,
            from: {
              authorityId: 'a'.repeat(64),
              canonicalDataRoot: identity.source,
            },
            to: {
              authorityId: 'b'.repeat(64),
              canonicalDataRoot: identity.destination,
            },
          });
          const plan = await prepareRelocationGit(git, [common, managed], {
            portableFilesystem: true,
          });
          const repairs: InternalRootRepairs = {
            prepare: () =>
              Promise.resolve({
                kind: 'ready',
                externalFiles: plan.backlinks
                  .map((row) => row.path)
                  .filter(
                    (path) => !isWithinInternalRoot(identity.source, path),
                  ),
              }),
            repair: async (context) => {
              await repairRelocationGit(transition, plan, context.workingRoot);
              return { kind: 'ok' };
            },
            verify: async (context) => {
              await repairRelocationGit(transition, plan, context.workingRoot);
              return { kind: 'ok' };
            },
            qualifyPublished: async () => {
              const actual = await prepareRelocationGit(
                git,
                [common, movedOwnedPath(transition, managed)],
                { portableFilesystem: true },
              );
              const state = (
                value: typeof plan,
              ): { head: string; branch: string; status: string }[] =>
                value.checkouts.map(({ head, branch, status }) => ({
                  head,
                  branch,
                  status,
                }));
              expect(state(actual)).toEqual(state(plan));
              return { kind: 'ok' };
            },
          };
          const unsettledFingerprint = (await worker.inventory(identity))
            .fingerprint;
          // Manual qualification splits barriers between brands; CI covers each
          // barrier for both. The final pass builds/publishes uninterrupted.
          // Entry proof cannot cover time spent acquiring coordination: recheck
          // while held and before each mutation; W5 also checks writer admission.
          let phase: string;
          const interrupted = new Error('interrupted');
          const crash = (): never => {
            throw interrupted;
          };
          const effects: InternalRootMigrationWorker = {
            ...worker,
            saveJournal: async (journal) => {
              await worker.saveJournal(journal);
              if (
                journal.phase === phase &&
                (phase !== 'complete' ||
                  journal.secureRelocation === 'complete')
              )
                crash();
            },
            build: async (journal) => {
              const result = await worker.build(journal);
              if (phase === 'copy') crash();
              return result;
            },
            exposeStaging: async (journal) => {
              await worker.exposeStaging(journal);
              if (phase === 'exposure') crash();
            },
            publish: async (journal) => {
              await worker.publish(journal);
              if (phase === 'publication') crash();
            },
          };
          for (phase of phases) {
            // This brand stopped after publication, not the complete journal.
            // Finish qualification before explicitly entering the restore path.
            if (phase === 'restoring-external') {
              const qualified = await assertNativeOutcome(
                'restore qualification',
                async () => {
                  expect(await run(worker, repairs)).toMatchObject({
                    kind: 'complete',
                    journal: {
                      version: 7,
                      phase: 'complete',
                      secureRelocation: 'complete',
                    },
                  });
                },
              );
              await assertRetained();
              if (!qualified) return;
            }
            if (phase === 'restoring-external' || phase === 'rebuilding') {
              const completedJournal = await worker.readJournal(identity);
              expect(completedJournal).toMatchObject({
                version: 7,
                phase: 'complete',
                secureRelocation: 'complete',
              });
              if (!completedJournal)
                throw new Error('Missing completed journal');
              expect(completedJournal.publicationIdentity).toBe(
                (await worker.inventory(identity, true)).destinationIdentity,
              );
              await assertRetained();
              const refused = await assertNativeOutcome(
                'populated secure rebuild refusal',
                () =>
                  expectNativeError(
                    migrateInternalRoot(
                      worker,
                      identity,
                      { ...apply, rebuild: true },
                      repairs,
                    ),
                    'recovery-required',
                  ),
              );
              if (!refused) return;
              expect(await worker.readJournal(identity)).toEqual(
                completedJournal,
              );
              await assertRetained();
              // Explicit operator recovery: docs/internal-root-migration.md#explicit-rebuild-after-secure-relocation.
              await rename(
                join(identity.destination, 'secure-storage'),
                identity.historicalSecure,
              );
            }
            const reached = await assertNativeOutcome(phase, () =>
              expectNativeError(
                migrateInternalRoot(
                  effects,
                  identity,
                  {
                    ...apply,
                    rebuild:
                      phase === 'restoring-external' || phase === 'rebuilding',
                  },
                  repairs,
                ),
                interrupted,
              ),
            );
            if (settledFingerprint) await assertRetained();
            else
              expect((await worker.inventory(identity)).fingerprint).toBe(
                unsettledFingerprint,
              );
            if (!reached) return;
            receipts.push({
              brand: identity.brandId,
              scenario: phase,
              outcome: 'phase-interrupted',
            });
            if (
              phase === 'complete' &&
              !(await assertNativeOutcome('completed resume', () =>
                expectNativeError(run(worker, repairs), 'already-complete'),
              ))
            )
              return;
          }
          const completed = await assertNativeOutcome(
            'W5 + Git completion',
            async () => {
              expect(await run(worker, repairs)).toMatchObject({
                kind: 'complete',
                journal: {
                  version: 7,
                  phase: 'complete',
                  secureRelocation: 'complete',
                },
              });
            },
          );
          await assertRetained();
          if (!completed) return;
          expect(
            await readFile(
              join(identity.destination, 'workspaces/index.json'),
              'utf8',
            ),
          ).toContain('"saved":true');
          const journal = await worker.readJournal(identity);
          if (!journal) throw new Error('Missing migration journal');
          expect(journal.publicationIdentity).toBe(
            (await worker.inventory(identity, true)).destinationIdentity,
          );
          // Legacy root completion is readable, but cannot claim secure completion.
          const journalPath = join(identity.coordination, 'journal.json');
          await writeFile(
            journalPath,
            JSON.stringify({
              ...journal,
              version: 6,
              secureRelocation: 'pending',
            }),
          );
          expect(await worker.readJournal(identity)).toMatchObject({
            version: 6,
            phase: 'complete',
            secureRelocation: 'pending',
          });
          await writeFile(
            journalPath,
            JSON.stringify({
              ...journal,
              version: 6,
              secureRelocation: 'complete',
            }),
          );
          await expect(worker.readJournal(identity)).rejects.toMatchObject({
            reason: 'journal-unsupported',
          });
          await writeFile(journalPath, JSON.stringify(journal));
          expect(await worker.readJournal(identity)).toEqual(journal);
          await assertRetained();
          receipts.push({
            brand: identity.brandId,
            scenario: 'W5 + Git',
            outcome: 'composed-complete',
          });
        }),
        caseTimeoutMs,
      );
      test(
        'uncomposed native host cannot create a migration journal or destination',
        nativeCase(async () => {
          await seed();
          const gated = createInternalRootMigrationWorker({
            ownedChildPath,
            executableBrands: [canopy, unstoppableCode],
            recoverW5: () => Promise.reject(new Error('must not settle')),
          });
          await expect(run(gated)).rejects.toMatchObject({
            reason: 'cold-proof-unavailable',
          });
          expect(await statIfPresent(identity.coordination)).toBeNull();
          expect(await statIfPresent(identity.destination)).toBeNull();
          receipts.push({
            brand: identity.brandId,
            scenario: 'uncomposed',
            outcome: 'uncomposed-refused',
          });
        }),
      );
      test.each(unresolvedCases)(
        'unresolved %s requires recovery-required and release',
        nativeCase(async (state: 'commit' | 'reservation') => {
          await seed(canopy, state);
          if (!(await admitOrAssertColdRefusal(`unresolved ${state}`))) return;
          const recoveryRequired = await assertNativeOutcome(
            `unresolved ${state}`,
            () =>
              expectNativeError(
                run(),
                'recovery-required',
                'W5 remains unresolved:',
              ),
          );
          // Refusal can precede journal creation; only recovery-required pins prepared.
          if (recoveryRequired)
            expect((await worker.readJournal(identity))?.phase).toBe(
              'prepared',
            );
          expect(await statIfPresent(identity.destination)).toBeNull();
          expect(
            await statIfPresent(
              join(identity.source, 'runtime/w5-maintenance.json'),
            ),
          ).toBeNull();
          expect(
            await statIfPresent(
              join(identity.source, 'runtime/startup-claim.json'),
            ),
          ).toBeNull();
          if (state === 'commit')
            expect(
              await readFile(
                join(identity.source, 'workspaces/index.json'),
                'utf8',
              ),
            ).toContain('"operatorEdit":true');
          const log = W5CommitLog.open(
            join(identity.source, 'w5/commit-log.sqlite'),
          );
          try {
            if (state === 'reservation')
              expect(log.listReservations()).toHaveLength(1);
          } finally {
            log.close();
          }
          if (recoveryRequired)
            receipts.push({
              brand: identity.brandId,
              scenario: `unresolved ${state}`,
              outcome: 'recovery-required',
            });
        }),
        caseTimeoutMs,
      );
    },
  );

  return receipts;
}
