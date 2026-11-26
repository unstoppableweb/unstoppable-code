import { createContext, useContext, type JSX, type ReactNode } from 'react';
import { LoadingSpinner } from './LoadingSpinner';

/**
 * How a region or control says "still loading". `text` shows the loading copy
 * ("Loading…"); `spinner` shows a small secondary spinner in its place, since
 * the word says nothing the spinner does not. Hosts choose it once at their
 * root. Desktop picks `spinner` under early access; every other host keeps
 * the `text` default.
 */
export type LoadingIndicatorStyle = 'text' | 'spinner';

const LoadingIndicatorStyleContext =
  createContext<LoadingIndicatorStyle>('text');

export function LoadingIndicatorStyleProvider({
  value,
  children,
}: {
  readonly value: LoadingIndicatorStyle;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <LoadingIndicatorStyleContext.Provider value={value}>
      {children}
    </LoadingIndicatorStyleContext.Provider>
  );
}

export function useLoadingIndicatorStyle(): LoadingIndicatorStyle {
  return useContext(LoadingIndicatorStyleContext);
}

/**
 * Inline loading content: the `text` copy under the `text` style, or a
 * secondary spinner under `spinner`. The caller keeps its own container.
 */
export function LoadingIndicator({
  text = 'Loading…',
}: {
  readonly text?: string;
}): JSX.Element {
  const style = useLoadingIndicatorStyle();
  if (style === 'spinner') {
    return <LoadingSpinner tone="secondary" sizePx={14} />;
  }
  return <>{text}</>;
}
