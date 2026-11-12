/**
 * Unlocks a locked account by driving `x.com/account/access` in a browser.
 *
 * The HTTP path already exists as {@link Client.unlock}, but it needs a paid
 * captcha service to solve the Arkose FunCaptcha. This drives the page instead,
 * so a challenge that clears on its own — which soft locks often do — needs no
 * solver.
 *
 * **Known blocker, and the reason this is hard to verify:** `/account/access`
 * sits behind a Cloudflare managed challenge that is far stricter than the rest
 * of the site. Measured from this project: `x.com/home` loads logged in with no
 * challenge at all, while `/account/access` shows "Performing security
 * verification" in the very same tab and never clears — real Chrome, headed,
 * a good session, two minutes of waiting, no Turnstile token issued. Plain
 * headless does not even reach the second phase.
 *
 * That gate is IP- and fingerprint-sensitive, so an address that has not been
 * hammering the API may well pass where this one did not. Route through a clean
 * address with `proxy` if the challenge blocks you. When it does block,
 * {@link browserUnlock} says so explicitly rather than timing out vaguely.
 *
 * Playwright is an OPTIONAL peer dependency:
 *
 * ```sh
 * npm install playwright
 * ```
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOMAIN } from '../constants.js';
import { stealthContextOptions } from './stealth.js';

export const ACCESS_URL = `https://${DOMAIN}/account/access`;

export interface BrowserUnlockOptions {
  /** Session cookies for the locked account. */
  cookies: Record<string, string>;
  /**
   * Run without a visible window. Defaults to false.
   *
   * Headed is the default here, unlike the rest of this module: headless does
   * not get past the Cloudflare gate on this page at all.
   */
  headless?: boolean;
  /**
   * Proxy URL. Worth setting: the challenge on this page is IP-sensitive, and
   * an address that has been running heavy automation tends to be refused.
   */
  proxy?: string;
  /** How long to wait for the Cloudflare gate, in ms. Defaults to 60000. */
  challengeTimeout?: number;
  /** How long to wait for the unlock flow itself, in ms. Defaults to 180000. */
  timeout?: number;
  /** Chrome profile directory. Defaults to a throwaway one. */
  profileDir?: string;
  /** Path to a Chrome binary, when it is not in the standard location. */
  executablePath?: string;
}

export interface BrowserUnlockResult {
  /** True only when the account came out unlocked. */
  unlocked: boolean;
  /** The steps that were clicked through, in order. */
  steps: string[];
  /**
   * Session cookies after the attempt. Unlocking rotates `ct0`, so feed these
   * back with `client.setCookies()` on success.
   */
  cookies: Record<string, string>;
  /** Why it did not finish. */
  error?: string;
}

type PlaywrightModule = typeof import('playwright');

async function loadPlaywright(): Promise<PlaywrightModule> {
  try {
    return (await import('playwright')) as PlaywrightModule;
  } catch {
    throw new Error(
      "browserUnlock requires the optional 'playwright' dependency. " +
        'Install it with: npm install playwright'
    );
  }
}

/**
 * Cloudflare's interstitial, across its phases. Structural first: the hidden
 * Turnstile input is on the page in every phase, whereas the wording changes
 * ("Performing security verification" becomes "Verifying you are human"), and
 * matching on wording alone reports the gate as gone while it is still there.
 */
const CF_PRESENT = `(!!document.querySelector('input[name="cf-turnstile-response"]')
  || /Performing security verification|Verifying you are human|Just a moment/i
       .test(document.body.innerText))`;

/** The unlock page proper, identified by the tokens its form carries. */
const FORM_PRESENT = `!!document.querySelector(
  'input[name="authenticity_token"], input[name="assignment_token"], #arkose_iframe'
)`;

/**
 * Drives the unlock flow and reports what happened.
 *
 * @example
 * import { browserUnlock } from 'free-twitter-api/browser';
 *
 * const result = await browserUnlock({ cookies: client.getCookies() });
 * if (result.unlocked) client.setCookies(result.cookies, true);
 * else console.error(result.error);
 */
export async function browserUnlock(
  options: BrowserUnlockOptions
): Promise<BrowserUnlockResult> {
  const { chromium } = await loadPlaywright();
  const {
    cookies,
    headless = false,
    proxy,
    challengeTimeout = 60_000,
    timeout = 180_000,
    executablePath,
  } = options;

  const ownProfile = !options.profileDir;
  const profileDir = options.profileDir ?? mkdtempSync(join(tmpdir(), 'ftapi-unlock-'));

  const context = await chromium.launchPersistentContext(profileDir, {
    ...stealthContextOptions({ proxy, headless, executablePath }),
    ...(executablePath ? { executablePath } : {}),
  } as Parameters<typeof chromium.launchPersistentContext>[1]);

  const steps: string[] = [];
  const readCookies = async (): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    for (const c of await context.cookies([`https://${DOMAIN}`, 'https://twitter.com'])) {
      out[c.name] = c.value;
    }
    return out;
  };

  try {
    const jar = [];
    for (const domain of [`.${DOMAIN}`, '.twitter.com']) {
      for (const [name, value] of Object.entries(cookies)) {
        jar.push({ name, value, domain, path: '/', secure: true, sameSite: 'Lax' as const });
      }
    }
    await context.addCookies(jar);

    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(timeout);

    /*
     * Land on the site first. The gate treats a cold jump to /account/access
     * more harshly than an in-site navigation, and this also proves the session
     * is actually good before blaming the challenge for a logged-out cookie
     * jar.
     */
    await page.goto(`https://${DOMAIN}/home`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    if (await page.evaluate(`!!document.querySelector("a[href='/login']")`)) {
      return { unlocked: false, steps, cookies: await readCookies(), error: 'the session is not logged in' };
    }

    await page.goto(ACCESS_URL, { waitUntil: 'domcontentloaded' });

    // Wait out the Cloudflare gate, and say so plainly if it never lifts.
    /*
     * Wait for a *positive* signal — the form, or having been sent elsewhere.
     * Treating "no Cloudflare text" as success is wrong: mid-redirect the
     * document is momentarily blank, which then reads as a cleared gate and
     * produces a nonsense diagnosis a moment later.
     */
    const deadline = Date.now() + challengeTimeout;
    let reached = false;
    while (Date.now() < deadline) {
      if (await page.evaluate(FORM_PRESENT)) {
        reached = true;
        break;
      }
      if (!page.url().includes('/account/access')) {
        reached = true;
        break;
      }
      await page.waitForTimeout(3000);
    }
    if (!reached) {
      const blocked = await page.evaluate(CF_PRESENT);
      return {
        unlocked: false,
        steps,
        cookies: await readCookies(),
        error: blocked
          ? 'blocked by the Cloudflare challenge on /account/access before the unlock form ' +
            '(it answers 403 and never clears). This gate is IP- and fingerprint-sensitive; ' +
            'try again from a different address via `proxy`.'
          : 'the unlock form never appeared, and no Cloudflare challenge was on screen either.',
      };
    }

    // Nothing to do: X sends an account that is not locked back to the timeline.
    const url = page.url();
    if (!url.includes('/account/access')) {
      return { unlocked: true, steps: ['already unlocked'], cookies: await readCookies() };
    }

    /*
     * The flow is a short state machine, the same one the HTTP path walks:
     * Start -> (challenge) -> Continue to X, with a Delete step on some
     * variants. Clicking by value rather than position, since the markup is
     * plain server-rendered HTML with stable button values.
     */
    const clickIfPresent = async (selector: string, label: string): Promise<boolean> => {
      const el = await page.$(selector);
      if (!el) return false;
      await el.click().catch(() => {});
      steps.push(label);
      await page.waitForTimeout(4000);
      return true;
    };

    const flowDeadline = Date.now() + timeout;
    while (Date.now() < flowDeadline) {
      if (await clickIfPresent('input[value="Delete"]', 'delete')) continue;
      if (await clickIfPresent('input[value="Start"]', 'start')) continue;
      if (await clickIfPresent('input[value="Continue to X"]', 'continue')) continue;

      // An Arkose challenge is in front of us; it may clear on its own.
      if (await page.$('#arkose_iframe')) {
        steps.push('arkose');
        await page.waitForTimeout(5000);
        if (Date.now() >= flowDeadline - 5000) {
          return {
            unlocked: false,
            steps,
            cookies: await readCookies(),
            error:
              'an Arkose challenge is in the way and did not clear on its own. ' +
              'Solve it with a headed run, or use `Client.unlock()` with a captcha solver.',
          };
        }
        continue;
      }

      // No buttons and no challenge: off the access flow means unlocked.
      if (!page.url().includes('/account/access')) {
        return { unlocked: true, steps, cookies: await readCookies() };
      }
      break;
    }

    const unlocked = !page.url().includes('/account/access');
    if (unlocked) return { unlocked, steps, cookies: await readCookies() };

    // Say what was actually on screen, so an unrecognised variant of the page
    // is diagnosable instead of just "did not complete".
    const onScreen = String(
      await page.evaluate(`document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 200)`)
    );
    return {
      unlocked: false,
      steps,
      cookies: await readCookies(),
      error: `the unlock flow did not complete; the page showed: ${onScreen || '(nothing)'}`,
    };
  } finally {
    await context.close().catch(() => {});
    if (ownProfile) rmSync(profileDir, { recursive: true, force: true });
  }
}
