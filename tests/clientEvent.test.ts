import { describe, expect, it, vi } from 'vitest';
import { Client } from '../src/client/client.js';
import { V11Client, V11Endpoint } from '../src/client/v11.js';
import type { V11Base } from '../src/client/v11.js';

vi.mock('../src/browser/view.js', () => ({
  browserViewTweets: vi.fn(async (options: any) =>
    options.tweets.map((tweet: string) => ({ tweet, viewed: true }))
  ),
}));

/** Decodes the `log=` field of a scribe body back into the event array. */
const decodeLog = (body: string): any[] => {
  const params = new URLSearchParams(body);
  return JSON.parse(params.get('log') ?? '[]');
};

describe('V11Client.clientEvent', () => {
  it('posts the batch form-encoded to flow/timeline.json', async () => {
    const post = vi.fn().mockResolvedValue([{}, {}]);
    const base = { baseHeaders: {}, post } as unknown as V11Base;

    await new V11Client(base).clientEvent([
      { event_namespace: { action: 'show' }, items: [{ id: '1' }] },
    ]);

    const [url, options] = post.mock.calls[0];
    expect(url).toBe(V11Endpoint.CLIENT_EVENT);
    expect(options.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(options.data).toMatch(/^debug=true&log=/);
    expect(decodeLog(options.data)[0].event_namespace.action).toBe('show');
  });
});

/*
 * viewTweet drives a real browser, because the scribe route does not register
 * views however faithfully it is reproduced (see docs/view-telemetry.md). These
 * cover the wiring only; that it counts is verified by measurement, not tests.
 */
describe('Client.viewTweet', () => {
  const browserView = async () => (await import('../src/browser/view.js')).browserViewTweets;

  it('hands the session cookies and the tweet to the browser', async () => {
    const client = new Client();
    client.setCookies({ auth_token: 'tok', ct0: 'csrf', twid: 'u%3D42' });

    const result = await client.viewTweet('123');

    expect(result).toEqual({ tweet: '123', viewed: true });
    const [options] = vi.mocked(await browserView()).mock.calls.at(-1)!;
    expect(options.tweets).toEqual(['123']);
    expect(options.cookies.auth_token).toBe('tok');
  });

  it('views a batch through one browser and forwards the options', async () => {
    const client = new Client();
    client.setCookies({ auth_token: 'tok' });

    const results = await client.viewTweets(['1', '2', '3'], { dwellMs: 5000, headless: false });

    expect(results.map((r) => r.tweet)).toEqual(['1', '2', '3']);
    const [options] = vi.mocked(await browserView()).mock.calls.at(-1)!;
    expect(options.tweets).toEqual(['1', '2', '3']);
    expect(options.dwellMs).toBe(5000);
    expect(options.headless).toBe(false);
  });
});
