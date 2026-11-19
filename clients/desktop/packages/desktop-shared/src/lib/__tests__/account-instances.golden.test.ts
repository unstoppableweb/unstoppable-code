/**
 * Several accounts per connector on the desktop (CAN-6226). The desktop binds
 * account refs and plugin-brought servers with the same rule the cloud uses
 * (`@canopy/protocol/mcp-servers`), so a chat reaches the same account on
 * either host and adding a second account never drops the first from a
 * plugin that used it.
 */
import type { AccountMcpConnection } from '@canopy/protocol/mcp-servers';
import {
  accountMcpConnectionForRef,
  matchAccountMcpConnection,
} from '../effective-plugin-selections';

const account = (
  id: string,
  configId: string,
  isDefault?: boolean,
  kind: AccountMcpConnection['kind'] = 'CURATED',
  serverKey = 'slack',
): AccountMcpConnection => ({
  id,
  serverKey,
  configId,
  kind,
  displayName: 'Slack',
  status: 'CONNECTED',
  routeId: `route-${id}`,
  enabledTools: null,
  ...(isDefault === undefined ? {} : { isDefault }),
});

describe('desktop account binding (CAN-6226)', () => {
  it('keeps a plugin on the first account when a second is added', () => {
    const first = account('a', 'default');
    expect(matchAccountMcpConnection([first], { curatedKey: 'slack' })).toBe(
      first,
    );
    // A second account: the first stays the default (the cloud flags it, and
    // an older cloud falls back to the default config).
    const second = account('b', 'acct-b');
    expect(
      matchAccountMcpConnection([first, second], { curatedKey: 'slack' }),
    ).toBe(first);
    expect(
      matchAccountMcpConnection(
        [account('a', 'default', true), account('b', 'acct-b', false)],
        { curatedKey: 'slack' },
      )?.id,
    ).toBe('a');
  });

  it('follows the default the person picks', () => {
    const rows = [account('a', 'default', false), account('b', 'acct-b', true)];
    expect(matchAccountMcpConnection(rows, { curatedKey: 'slack' })?.id).toBe(
      'b',
    );
    // A locally generated config with no exact account reaches the default.
    expect(
      matchAccountMcpConnection(rows, {
        curatedKey: 'slack',
        configId: 'device-1',
      })?.id,
    ).toBe('b');
    // The exact config still wins.
    expect(
      matchAccountMcpConnection(rows, {
        curatedKey: 'slack',
        configId: 'default',
      })?.id,
    ).toBe('a');
  });

  it('never moves a ref to an added account onto another account', () => {
    const rows = [account('a', 'default', true)];
    expect(
      matchAccountMcpConnection(rows, {
        curatedKey: 'slack',
        configId: 'acct-gone',
      }),
    ).toBeUndefined();
    expect(
      accountMcpConnectionForRef(
        { serverId: 'slack', configId: 'acct-gone' },
        rows,
        'attended',
      ),
    ).toBeUndefined();
  });

  it('keeps today’s sole-connection match and fails closed when several have no default', () => {
    expect(
      matchAccountMcpConnection([account('a', 'device-1')], {
        curatedKey: 'slack',
        configId: 'device-2',
      })?.id,
    ).toBe('a');
    // An older cloud: two accounts, none flagged, no default config.
    expect(
      matchAccountMcpConnection(
        [account('a', 'acct-a'), account('b', 'acct-b')],
        { curatedKey: 'slack' },
      ),
    ).toBeUndefined();
  });

  it('resolves stored refs exactly unless a run asks for the account rule', () => {
    const rows = [account('a', 'default', false), account('b', 'acct-b', true)];
    const ref = { serverId: 'slack', configId: 'device-1' };
    expect(accountMcpConnectionForRef(ref, rows)).toBeUndefined();
    expect(accountMcpConnectionForRef(ref, rows, 'attended')?.id).toBe('b');
    // An unattended run never picks between several accounts.
    expect(accountMcpConnectionForRef(ref, rows, 'unattended')).toBeUndefined();
    expect(accountMcpConnectionForRef(ref, [rows[1]], 'unattended')?.id).toBe(
      'b',
    );
    // Custom servers always name exactly one connection.
    const custom = account('c', 'default', undefined, 'CUSTOM', 'custom:1');
    expect(
      accountMcpConnectionForRef(
        { serverId: 'custom:1', configId: 'other' },
        [custom],
        'attended',
      ),
    ).toBeUndefined();
  });
});
