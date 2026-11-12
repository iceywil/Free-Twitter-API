import { describe, expect, it, vi } from 'vitest';
import { Client } from '../src/client/client.js';

describe('Client.unlockWithBrowser', () => {
  it('passes the session cookies through', async () => {
    const mod = await import('../src/browser/unlock.js');
    const spy = vi.spyOn(mod, 'browserUnlock').mockResolvedValue({
      unlocked: false, steps: [], cookies: {}, error: 'blocked by the Cloudflare challenge',
    });

    const client = new Client();
    client.setCookies({ auth_token: 'tok', ct0: 'old' });
    const result = await client.unlockWithBrowser({ proxy: 'http://p:1' });

    expect(result.unlocked).toBe(false);
    expect(spy.mock.calls[0][0]).toMatchObject({
      proxy: 'http://p:1',
      cookies: expect.objectContaining({ auth_token: 'tok' }),
    });
    spy.mockRestore();
  });

  it('adopts the rotated cookies when it unlocks', async () => {
    const mod = await import('../src/browser/unlock.js');
    const spy = vi.spyOn(mod, 'browserUnlock').mockResolvedValue({
      unlocked: true, steps: ['start', 'continue'], cookies: { auth_token: 'tok', ct0: 'rotated' },
    });

    const client = new Client();
    client.setCookies({ auth_token: 'tok', ct0: 'old' });
    await client.unlockWithBrowser();

    // Unlocking rotates ct0; the client must end up on the working session.
    expect(client.getCookies().ct0).toBe('rotated');
    spy.mockRestore();
  });

  it('leaves the session alone when it fails', async () => {
    const mod = await import('../src/browser/unlock.js');
    const spy = vi.spyOn(mod, 'browserUnlock').mockResolvedValue({
      unlocked: false, steps: [], cookies: { ct0: 'junk' }, error: 'nope',
    });

    const client = new Client();
    client.setCookies({ auth_token: 'tok', ct0: 'old' });
    await client.unlockWithBrowser();

    expect(client.getCookies().ct0).toBe('old');
    spy.mockRestore();
  });
});
