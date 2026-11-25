import { useEffect, useState } from 'react';

/**
 * Personal AI gateways this computer opts out of (CAN-7644), re-read when
 * main reports a change. `null` until the first read; a failed read counts as
 * none, as main's own unreadable file does.
 */
export function useModelGatewayDeviceOptOuts(): ReadonlySet<string> | null {
  const [optOuts, setOptOuts] = useState<ReadonlySet<string> | null>(null);
  const [changes, setChanges] = useState(0);
  useEffect(
    () =>
      window.api.modelGatewayDeviceUse.onChanged(() =>
        setChanges((count) => count + 1),
      ),
    [],
  );
  useEffect(() => {
    let cancelled = false;
    void window.api.modelGatewayDeviceUse.read().then(
      (ids) => {
        if (!cancelled) setOptOuts(new Set(ids));
      },
      () => {
        if (!cancelled) setOptOuts(new Set());
      },
    );
    return (): void => {
      cancelled = true;
    };
  }, [changes]);
  return optOuts;
}
