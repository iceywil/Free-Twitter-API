import { describe, expect, it, vi } from 'vitest';
import { Client } from '../src/client/client.js';

/** A Client whose GraphQL user lookups return a canned payload. */
function clientReturning(result: unknown) {
  const client = new Client();
  (client as any).gql = {
    userByScreenName: vi.fn().mockResolvedValue([{ data: { user: result ? { result } : null } }]),
    userByRestId: vi.fn().mockResolvedValue([{ data: { user: result ? { result } : null } }]),
  };
  return client;
}

const SUSPENDED = {
  __typename: 'UserUnavailable',
  message: 'User is suspended',
  reason: 'Suspended',
};

describe('Client.getAccountStatus', () => {
  it('reports a suspension', async () => {
    const status = await clientReturning(SUSPENDED).getAccountStatus('polarys_dev');
    expect(status).toEqual({
      account: 'polarys_dev',
      exists: true,
      available: false,
      suspended: true,
      reason: 'Suspended',
      message: 'User is suspended',
    });
  });

  it('reports a healthy account', async () => {
    const status = await clientReturning({ __typename: 'User', rest_id: '1' }).getAccountStatus('jack');
    expect(status).toMatchObject({ exists: true, available: true, suspended: false, reason: null });
  });

  it('reports a missing account', async () => {
    const status = await clientReturning(null).getAccountStatus('nobody_at_all_xyz');
    expect(status).toMatchObject({ exists: false, available: false, suspended: false });
  });

  it('does not call an unavailable-but-unsuspended account suspended', async () => {
    // Protected/withheld accounts are UserUnavailable too, with another reason.
    const status = await clientReturning({
      __typename: 'UserUnavailable',
      reason: 'Protected',
      message: 'These posts are protected',
    }).getAccountStatus('someone');
    expect(status.available).toBe(false);
    expect(status.suspended).toBe(false);
    expect(status.reason).toBe('Protected');
  });

  it('looks up by id when given digits', async () => {
    const client = clientReturning(SUSPENDED);
    await client.getAccountStatus('2094078948829224960');
    expect((client as any).gql.userByRestId).toHaveBeenCalledWith('2094078948829224960');
    expect((client as any).gql.userByScreenName).not.toHaveBeenCalled();
  });

  it('isSuspended is a boolean shorthand', async () => {
    await expect(clientReturning(SUSPENDED).isSuspended('x')).resolves.toBe(true);
    await expect(clientReturning({ __typename: 'User' }).isSuspended('x')).resolves.toBe(false);
  });
});
