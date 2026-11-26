import type { ToastMeta } from '@/stores/toastStore';

/** Sample toasts for the development-only bench on the Notice states page. */
type ToastType = 'error' | 'info' | 'success' | 'warning';

export interface ToastSample {
  readonly id: string;
  readonly label: string;
  readonly type: ToastType;
  readonly message: string;
  readonly meta?: ToastMeta;
}

const LONG_MESSAGE =
  'The workflow stopped at the review step because two required checks did not report back in time. Open the run to see which checks are missing and start them again.';

export const TOAST_TEST_SAMPLES: readonly ToastSample[] = [
  { id: 'info', label: 'Info', type: 'info', message: 'Layout saved' },
  {
    id: 'success',
    label: 'Success',
    type: 'success',
    message: 'Pull request merged',
    meta: { category: 'GitHub' },
  },
  {
    id: 'warning',
    label: 'Warning',
    type: 'warning',
    message: 'Usage is close to this month’s limit',
  },
  {
    id: 'error',
    label: 'Error',
    type: 'error',
    message: "Couldn't switch layout mode",
  },
  {
    id: 'title',
    label: 'With title',
    type: 'success',
    message: 'You can close the browser tab.',
    meta: { category: 'Account', title: 'Signed in' },
  },
  {
    id: 'action',
    label: 'With action',
    type: 'warning',
    message: 'This site was blocked by “Only allow local sites”.',
    meta: {
      category: 'Privacy',
      action: { label: 'Turn off', onClick: (): void => undefined },
    },
  },
  {
    id: 'link',
    label: 'With link',
    type: 'success',
    message: 'Plan shared',
    meta: { link: { url: 'https://example.com/shared/plan' } },
  },
  {
    id: 'long',
    label: 'Long text',
    type: 'error',
    message: LONG_MESSAGE,
    meta: { category: 'Pipeline' },
  },
  {
    id: 'persistent',
    label: 'Stays 1 minute',
    type: 'info',
    message: 'This toast stays for one minute instead of 15 seconds',
    meta: { persistent: true },
  },
];
