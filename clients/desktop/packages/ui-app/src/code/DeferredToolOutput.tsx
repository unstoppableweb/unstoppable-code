'use client';
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useRef,
  useState,
  type JSX,
} from 'react';
import type { PersistedToolOutputReference } from '@canopy/protocol/canopy-core/core';
import type { TranscriptContentField } from '@canopy/protocol/canopy-core/core';
import {
  DeferredTextOutput,
  stripHookErrorPrefix,
} from '@canopy/ui-shared/components';

/** One byte range of a stored tool output, as every host's reader returns it. */
export interface ToolOutputPage {
  text: string;
  nextOffset?: number;
  byteLength: number;
}

/** A stored artifact reference, or a body located by its stored row block. */
export type ToolOutputIdentity =
  | {
      readonly kind: 'reference';
      readonly messageId: string;
      readonly toolUseId: string;
      readonly reference: PersistedToolOutputReference;
    }
  | {
      readonly kind: 'row';
      readonly messageId: string;
      readonly blockOrdinal: number;
      readonly field: TranscriptContentField;
    };

interface TranscriptFieldReaderCopy {
  readonly openLabel: string;
  readonly loadingLabel: string;
  readonly unavailableMessage: string;
}

const TRANSCRIPT_FIELD_READER_COPY: Record<
  TranscriptContentField,
  TranscriptFieldReaderCopy
> = {
  output: {
    openLabel: 'View full output',
    loadingLabel: 'Loading output…',
    unavailableMessage: "Couldn't load full output in this view.",
  },
  input: {
    openLabel: 'View full input',
    loadingLabel: 'Loading input…',
    unavailableMessage: "Couldn't load full input in this view.",
  },
  text: {
    openLabel: 'View full text',
    loadingLabel: 'Loading text…',
    unavailableMessage: "Couldn't load full text in this view.",
  },
  partialText: {
    openLabel: 'View full partial text',
    loadingLabel: 'Loading partial text…',
    unavailableMessage: "Couldn't load full partial text in this view.",
  },
  finalText: {
    openLabel: 'View full final text',
    loadingLabel: 'Loading final text…',
    unavailableMessage: "Couldn't load full final text in this view.",
  },
};

/** Field-specific fallback for hosts that cannot read a transcript field. */
export function transcriptFieldUnavailable(
  field: TranscriptContentField,
): string {
  return TRANSCRIPT_FIELD_READER_COPY[field].unavailableMessage;
}

/** Host transport for full tool output; absent where the host cannot read it. */
export type ToolOutputReader = (
  identity: ToolOutputIdentity,
  offset: number,
  signal: AbortSignal,
) => Promise<ToolOutputPage>;
export const ToolOutputReaderContext = createContext<ToolOutputReader | null>(
  null,
);

interface DeferredToolOutputProps {
  identity: ToolOutputIdentity;
  preview: string;
  isError?: boolean;
}

export const DeferredToolOutput = memo(function DeferredToolOutput({
  identity,
  preview,
  isError = false,
}: DeferredToolOutputProps): JSX.Element {
  const read = useContext(ToolOutputReaderContext);
  const request = useRef(0);
  const controller = useRef<AbortController | undefined>(undefined);
  const requestedPage = useRef({ offset: 0, position: 0 });
  const [opened, setOpened] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [page, setPage] = useState<ToolOutputPage>();
  const [offsets, setOffsets] = useState([0]);
  const [position, setPosition] = useState(0);
  const identityKey =
    identity.kind === 'reference'
      ? identity.reference.artifactId
      : `${identity.messageId}:${identity.blockOrdinal}:${identity.field}`;
  const field = identity.kind === 'row' ? identity.field : 'output';
  const fieldCopy = TRANSCRIPT_FIELD_READER_COPY[field];
  useEffect(() => {
    request.current += 1;
    setOpened(false);
    setLoading(false);
    setError(undefined);
    setPage(undefined);
    setOffsets([0]);
    setPosition(0);
    return (): void => {
      request.current += 1;
      controller.current?.abort();
      controller.current = undefined;
    };
  }, [identityKey, read]);
  async function load(offset: number, nextPosition: number): Promise<void> {
    const token = ++request.current;
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    requestedPage.current = { offset, position: nextPosition };
    setOpened(true);
    setLoading(true);
    setError(undefined);
    try {
      if (!read) throw new Error(transcriptFieldUnavailable(field));
      const result = await read(identity, offset, nextController.signal);
      if (request.current !== token) return;
      setPage(result);
      setPosition(nextPosition);
      setOffsets((current) => [...current.slice(0, nextPosition), offset]);
    } catch (failure) {
      if (request.current === token) {
        const message =
          failure instanceof Error ? failure.message : String(failure);
        setError(
          message === "Couldn't load full output in this view."
            ? transcriptFieldUnavailable(field)
            : message,
        );
      }
    } finally {
      if (request.current === token) setLoading(false);
    }
  }
  return (
    <DeferredTextOutput
      preview={preview}
      text={
        page !== undefined && isError && offsets[position] === 0
          ? stripHookErrorPrefix(page.text)
          : page?.text
      }
      opened={opened}
      loading={loading}
      error={error}
      openLabel={fieldCopy.openLabel}
      loadingLabel={fieldCopy.loadingLabel}
      hasPrevious={position > 0}
      hasNext={page?.nextOffset !== undefined}
      onOpen={() => {
        void load(0, 0);
      }}
      onPrevious={() => {
        void load(offsets[position - 1], position - 1);
      }}
      onNext={() => {
        if (page?.nextOffset !== undefined)
          void load(page.nextOffset, position + 1);
      }}
      onRetry={() => {
        void load(requestedPage.current.offset, requestedPage.current.position);
      }}
      onClose={() => {
        request.current += 1;
        controller.current?.abort();
        controller.current = undefined;
        setOpened(false);
        setPage(undefined);
        setLoading(false);
        setError(undefined);
      }}
    />
  );
});
