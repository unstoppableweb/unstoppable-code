import { useEffect, useMemo, useState, type JSX } from 'react';
import type { ReportOutputs } from '@canopy/execution-engine/types/pipeline';
import { formatPipelineReportContent } from '@/lib/pipelineExecutionDetail';
import { LoadingSpinner } from '../../shared/loading/spinners/LoadingSpinner';
import { PipelineReportMarkdown } from '../PipelineReportMarkdown';
import { Surface } from '@canopy/ui-shared/components';

type ReportKind = 'text' | 'json';

interface ReportEntry {
  kind: ReportKind;
  label: string;
  path: string;
}

interface ReportLoadState {
  loading: boolean;
  content?: string;
  error?: string;
}

function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path.trim());
}

/**
 * Inline report renderer for the pipeline Summary view. Always renders the
 * report(s) when present (no expand/collapse): a `.md` text report is rendered
 * with the markdown renderer, anything else (plain-text or JSON reports) is
 * rendered as preformatted plain text.
 *
 * With `archivedSource` set, report content is read through the
 * container-scoped `window.api.archivedContainers` transport instead of the
 * live `window.pipelines` API (archived executions no longer exist there).
 */
export function PipelineReportView({
  executionId,
  reportOutputs,
  archivedSource,
}: {
  executionId: string;
  reportOutputs: ReportOutputs;
  archivedSource?: { projectId: string; containerId: string };
}): JSX.Element | null {
  const entries = useMemo<ReportEntry[]>(() => {
    const list: ReportEntry[] = [];
    if (reportOutputs.report_file) {
      list.push({
        kind: 'text',
        label: 'Report',
        path: reportOutputs.report_file,
      });
    }
    if (reportOutputs.report_json_file) {
      list.push({
        kind: 'json',
        label: 'JSON report',
        path: reportOutputs.report_json_file,
      });
    }
    return list;
  }, [reportOutputs.report_file, reportOutputs.report_json_file]);

  const [stateByKind, setStateByKind] = useState<
    Record<string, ReportLoadState>
  >({});

  useEffect(() => {
    let cancelled = false;
    setStateByKind(
      Object.fromEntries(
        entries.map((entry) => [entry.kind, { loading: true }]),
      ),
    );
    for (const entry of entries) {
      const readContent: Promise<{ content: string } | { error: string }> =
        archivedSource !== undefined
          ? window.api.archivedContainers
              .readExecutionReport({
                projectId: archivedSource.projectId,
                containerId: archivedSource.containerId,
                executionId,
                kind: entry.kind,
              })
              .then((response) => ({ content: response.content }))
          : window.pipelines
              .readReportFile(executionId, entry.kind)
              .then((result) =>
                result.success && result.data
                  ? { content: result.data.content }
                  : { error: result.error ?? 'Failed to load report' },
              );
      void readContent
        .then((result) => {
          if (cancelled) return;
          setStateByKind((current) => ({
            ...current,
            [entry.kind]:
              'content' in result
                ? {
                    loading: false,
                    content: formatPipelineReportContent(
                      entry.kind,
                      result.content,
                    ),
                  }
                : {
                    loading: false,
                    error: result.error,
                  },
          }));
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setStateByKind((current) => ({
            ...current,
            [entry.kind]: {
              loading: false,
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to load report',
            },
          }));
        });
    }
    return (): void => {
      cancelled = true;
    };
  }, [executionId, entries, archivedSource]);

  if (entries.length === 0) {
    return null;
  }

  return (
    <Surface
      variant="inset"
      className="overflow-hidden"
      data-testid="pipeline-report"
    >
      <Surface variant="section" boundary="bottom">
        <div className="px-4 py-2 text-xs font-medium fg-secondary">Report</div>
      </Surface>
      <div className="flex flex-col p-4 gap-4">
        {entries.map((entry) => {
          const reportState = stateByKind[entry.kind] ?? { loading: true };
          const renderAsMarkdown =
            entry.kind === 'text' && isMarkdownPath(entry.path);
          return (
            <div
              key={entry.kind}
              className="flex flex-col gap-1.5"
              data-testid={`pipeline-report-${entry.kind}`}
            >
              {entries.length > 1 && (
                <div className="text-2xs font-medium fg-secondary/70">
                  {entry.label}
                </div>
              )}
              {reportState.loading ? (
                <div className="flex items-center gap-2 text-s fg-secondary">
                  <LoadingSpinner tone="active" />
                  Loading report…
                </div>
              ) : reportState.error !== undefined ? (
                <div className="text-s fg-destructive-strong">
                  {reportState.error}
                </div>
              ) : renderAsMarkdown ? (
                <PipelineReportMarkdown content={reportState.content ?? ''} />
              ) : (
                <pre className="overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed fg-primary/80">
                  {reportState.content ?? ''}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </Surface>
  );
}
