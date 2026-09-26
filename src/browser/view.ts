/**
 * Browser-driven tweet views.
 *
 * Posting the impression scribe from Node does not work. The wire format is
 * known exactly — see `docs/view-telemetry.md` — and reproducing it field for
 * field still does not move the counter: measured against a live tweet, three
 * sessions POSTing the batch scored `+0` (every POST confirmed `200`, control
 * tweets flat) while the same three sessions opening the tweet in real Chrome
 * scored `+3`, one each. Adding the permalink `Referer`, fetching `TweetDetail`
 * from the sending session first, and echoing back the server-issued
 * `sortIndex` for the entry it was served all changed nothing.
 *
 * So the backend is validating something a bare POST cannot manufacture, and
 * the only thing that registers a view is a genuine page session. That is what
 * this does: it opens the permalink in the browser, lets the tweet sit on
 * screen, and navigates away so the client flushes its own impression.
 *
 * The same rate limiting points at the same conclusion — a Node session lands
 * roughly one scribe POST before the route answers `404` for a long cooldown,
 * while a real browser sends dozens without complaint.
 *
 * Playwright is an OPTIONAL peer dependency:
 *
 * ```sh
 * npm install playwright
 * ```
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PROFILE_ROOT, profileDirFor, stealthContextOptions } from './stealth.js';

export interface BrowserViewOptions {
  /** Session cookies, as {@link Client.getCookies} returns them. */
  cookies: Record<string, string>;
  /**
   * Tweets to view, as ids or permalinks. Ids are opened through
   * `x.com/i/status/<id>`, which redirects to the canonical permalink.
   */
  tweets: string[];
  /**
   * How long each tweet stays on screen, in milliseconds. Defaults to 32000.
   *
   * Unlike the scribe path, this is a real wait: the page has to be open for
   * the client to report the dwell. The measured views used ~33 s; shorter
   * windows are untested, so treat a low value as unverified rather than safe.
   */
  dwellMs?: number;
  /** Run without a visible window. Defaults to true. */
  headless?: boolean;
  /**
   * Persistent Chrome profile directory. Defaults to a per-account directory
   * keyed on the session, so separate accounts keep separate device identities
   * — the same reasoning as {@link browserLogin}.
   */
  profileDir?: string;
  /** Reuse one profile for every account instead of one per account. */
  sharedProfile?: boolean;
  /** Milliseconds to wait for each navigation. Defaults to 45000. */
  timeout?: number;
  /** Proxy URL, forwarded to the browser. */
  proxy?: string;
  /** Path to a Chrome binary, when it is not in the standard location. */
  executablePath?: string;
}

export interface BrowserViewResult {
  /** The tweet id or permalink as it was passed in. */
  tweet: string;
  /** Whether the page loaded with the session logged in. */
  viewed: boolean;
  /** Why the view did not happen, when `viewed` is false. */
  error?: string;
}

type PlaywrightModule = typeof import('playwright');

async function loadPlaywright(): Promise<PlaywrightModule> {
  try {
    return (await import('playwright')) as PlaywrightModule;
  } catch {
    throw new Error(
      "Viewing tweets requires the optional 'playwright' dependency. " +
        'Install it with: npm install playwright'
    );
  }
}

function permalinkFor(tweet: string): string {
  if (/^https?:\/\//.test(tweet)) return tweet;
  return `https://x.com/i/status/${tweet}`;
}

/**
 * Opens each tweet in a real browser long enough to register a view.
 *
 * One browser serves the whole list: each tweet is opened, dwelt on, then left
 * by navigating to the next, which is what makes the client flush the previous
 * tweet's impression. Expect roughly `dwellMs` per tweet.
 *
 * @example
 * import { browserViewTweets } from 'free-twitter-api/browser';
 *
 * const results = await browserViewTweets({
 *   cookies: client.getCookies(),
 *   tweets: ['1234567890', '1234567891'],
 * });
 */
export async function browserViewTweets(
  options: BrowserViewOptions
): Promise<BrowserViewResult[]> {
  const { chromium } = await loadPlaywright();
  const {
    cookies,
    tweets,
    dwellMs = 32_000,
    headless = true,
    timeout = 45_000,
    proxy,
    executablePath,
  } = options;

  if (tweets.length === 0) return [];

  /*
   * Key the profile on the session itself: `twid` is the account id, so two
   * accounts never land on the same device identity, and the same account
   * reuses the device it logged in from.
   */
  const accountKey = cookies.twid ?? cookies.auth_token ?? '_views';
  const profileDir =
    options.profileDir ??
    (options.sharedProfile ? join(PROFILE_ROOT, '_shared') : profileDirFor(accountKey));
  mkdirSync(profileDir, { recursive: true });

  // `headless` goes through stealthContextOptions so the corrections that make
  // headless pass as real Chrome are applied. See browserLogin for why.
  const context = await chromium.launchPersistentContext(profileDir, {
    ...stealthContextOptions({ proxy, headless, executablePath }),
    ...(executablePath ? { executablePath } : {}),
  } as Parameters<typeof chromium.launchPersistentContext>[1]);

  const results: BrowserViewResult[] = [];
  try {
    const playwrightCookies = [];
    for (const domain of ['.x.com', '.twitter.com']) {
      for (const [name, value] of Object.entries(cookies)) {
        playwrightCookies.push({ name, value, domain, path: '/', secure: true, sameSite: 'Lax' as const });
      }
    }
    await context.addCookies(playwrightCookies);

    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(timeout);

    for (const tweet of tweets) {
      try {
        await page.goto(permalinkFor(tweet), { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(5000);

        const loggedIn = await page.evaluate(
          "!document.querySelector('a[href=\\'/login\\']')"
        );
        if (!loggedIn) {
          results.push({ tweet, viewed: false, error: 'session is not logged in' });
          continue;
        }

        // A little movement, as a reader would: the client reports scroll
        // alongside the impression.
        await page.mouse.wheel(0, 400);
        await page.waitForTimeout(1500);
        await page.mouse.wheel(0, -250);
        await page.waitForTimeout(Math.max(0, dwellMs - 6500));

        results.push({ tweet, viewed: true });
      } catch (error) {
        results.push({
          tweet,
          viewed: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    /*
     * Leaving the last tweet is what flushes its impression: the client batches
     * scribes and sends the dwell window on page-hide, through `sendBeacon`.
     * Without this the final tweet in the list would not be counted.
     */
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(4000);
  } finally {
    await context.close().catch(() => {});
  }

  return results;
}
