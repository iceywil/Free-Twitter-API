import { describe, expect, it, vi } from 'vitest';
import { Client } from '../src/client/client.js';
import { appealAccount } from '../src/browser/appeal.js';

vi.mock('playwright', () => ({ chromium: { launchPersistentContext: vi.fn() } }));

describe('appealAccount validation', () => {
  it('requires the appeal text', async () => {
    await expect(appealAccount({ text: '   ', email: 'a@b.c' })).rejects.toThrow(/appeal text/);
  });

  it('requires a contact email', async () => {
    await expect(appealAccount({ text: 'please review', email: '' })).rejects.toThrow(/email/);
  });
});

describe('Client.appealAccount', () => {
  it('passes the text, the session cookies and the session handle', async () => {
    const mod = await import('../src/browser/appeal.js');
    const spy = vi
      .spyOn(mod, 'appealAccount')
      .mockResolvedValue({ submitted: false, dryRun: true, filled: [], challengePassed: true });

    const client = new Client();
    client.setCookies({ auth_token: 'tok', ct0: 'csrf' });
    (client as any).v11 = { settings: vi.fn().mockResolvedValue([{ screen_name: 'polarys_dev' }]) };

    await client.appealAccount({ text: 'not a violation', email: 'me@example.com', dryRun: true });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'not a violation',
        email: 'me@example.com',
        screenName: 'polarys_dev',
        dryRun: true,
        cookies: expect.objectContaining({ auth_token: 'tok' }),
      })
    );
    spy.mockRestore();
  });

  it('keeps an explicit handle instead of looking one up', async () => {
    const mod = await import('../src/browser/appeal.js');
    const spy = vi
      .spyOn(mod, 'appealAccount')
      .mockResolvedValue({ submitted: false, dryRun: true, filled: [], challengePassed: true });

    const client = new Client();
    client.setCookies({ auth_token: 'tok' });
    const settings = vi.fn();
    (client as any).v11 = { settings };

    await client.appealAccount({ text: 't', email: 'e@x.co', screenName: 'chosen' });

    expect(settings).not.toHaveBeenCalled();
    expect(spy.mock.calls[0][0].screenName).toBe('chosen');
    spy.mockRestore();
  });
});
