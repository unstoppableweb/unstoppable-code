import type { JSX, SVGProps } from 'react';
import { RemoteControlIcon as AppCatalogRemoteControlIcon } from './AppIcons';

export function RemoteControlIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <AppCatalogRemoteControlIcon
      width="20"
      height="20"
      aria-hidden="true"
      {...props}
    />
  );
}
