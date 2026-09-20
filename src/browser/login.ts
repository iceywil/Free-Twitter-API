/**
 * Browser-driven login that harvests session cookies.
 *
 * Native login is not possible: x.com's `/i/jfapi/onboarding/web/*` flow
 * requires a `$castle_token`, a ~6 KB encrypted device-fingerprint blob
 * produced by the Castle.io SDK inside a real browser. It cannot be forged or
 * replayed from Node. This drives a real browser through the login form once
 * and returns the resulting cookies, after which the plain {@link Client} runs
 * the entire (ungated) API from Node with no browser.
 *
 * Castle scores the device, not just the credentials, so the browser has to
 * look like somebody's actual browser. See {@link stealthContextOptions} for
 * the measured differences this closes. Three things matter most:
 *
 * 1. The locally installed Chrome, not bundled Chromium — Chromium's WebGL
 *    vendor, `userAgentData` brands and plugin set are all visibly not Chrome.
 * 2. A persistent profile, one per account, so repeat logins come from a device
 *    Castle has seen before instead of a new one each time — while separate
 *    accounts stay on separate devices.
 * 3. A corrected headless mode, or headed. Plain headless is refused at
 *    `begin_login`; `headless: true` applies the fixes that make it pass. See
 *    docs/native-login.md for the controlled comparison.
 *
 * Playwright is an OPTIONAL peer dependency — install it only if you use this
 * module:
 *
 * ```sh
 * npm install playwright
 * ```
 *
 * Note that `npx playwright install chromium` is *not* wanted here: this drives
 * the Google Chrome already installed on the machine.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  PROFILE_ROOT,
  profileDirFor,
  stealthContextOptions,
  typeLikeHuman,
  pause,
} from './stealth.js';

export interface BrowserLoginOptions {
  /** Username, email, or phone number. */
  authInfo1: string;
  /** A second identifier (e.g. email when the first is a username). */
  authInfo2?: string;
  password: string;
  /** TOTP secret for 2FA, or a callback that supplies the code. */
  totpSecret?: string;
  /** Called when a verification code is needed and no `totpSecret` is set. */
  onVerificationCode?: (prompt: string) => Promise<string>;
  /**
   * Persistent Chrome profile directory. Reused across runs so the device stays
   * recognisable to Castle. Defaults to a directory of this account's own under
   * `~/.free-twitter-api/profiles/`, so separate accounts never share a device
   * identity.
   */
  profileDir?: string;
  /**
   * Reuse one profile for every account instead of one per account. Off by
   * default, and best left off: a shared profile means a shared device identity
   * and cookie jar, which is how separate accounts get correlated.
   */
  sharedProfile?: boolean;
  /**
   * Run the browser without a visible window. Defaults to false.
   *
   * Plain headless Chrome is refused at `begin_login` — it reports
   * `HeadlessChrome` in the user agent while its own `sec-ch-ua` hints say
   * `Google Chrome`, and it loses the Retina scale factor and real screen
   * size. Setting this corrects all three (see `headlessOverrides`), and a
   * cold-start headless login then succeeds. Headed remains the default as the
   * better-tested path.
   */
  headless?: boolean;
  /** Milliseconds to wait for each navigation/selector. Defaults to 60000. */
  timeout?: number;
  /** Proxy URL, forwarded to the browser. */
  proxy?: string;
  /** Path to a Chrome binary, when it is not in the standard location. */
  executablePath?: string;
}

export interface BrowserLoginResult {
  /** Session cookies, ready for {@link Client.setCookies}. */
  cookies: Record<string, string>;
  /** The `auth_token` cookie, if present. */
  authToken?: string;
  /** The `ct0` (CSRF) cookie, if present. */
  ct0?: string;
  /** True when the profile already held a session and no form was driven. */
  reusedSession: boolean;
}

// Loaded lazily so the package does not hard-depend on Playwright.
type PlaywrightModule = typeof import('playwright');

async function loadPlaywright(): Promise<PlaywrightModule> {
  try {
    return (await import('playwright')) as PlaywrightModule;
  } catch {
    throw new Error(
      "browserLogin requires the optional 'playwright' dependency. " +
        'Install it with: npm install playwright'
    );
  }
}

async function totpNow(secret: string): Promise<string> {
  const { TOTP } = await import('otpauth');
  return new TOTP({ secret }).generate();
}

/**
 * Logs in through a real browser and returns the session cookies.
 *
 * The browser profile persists, so the common case after the first run is that
 * the session is still valid and no login happens at all
 * (`reusedSession: true`).
 *
 * @example
 * import { browserLogin } from 'free-twitter-api/browser';
 * import { Client } from 'free-twitter-api';
 *
 * const { cookies } = await browserLogin({
 *   authInfo1: 'username',
 *   password: 'password',
 *   totpSecret: 'BASE32SECRET', // optional
 * });
 *
 * const client = new Client();
 * client.setCookies(cookies);
 * await client.saveCookies('cookies.json'); // reuse next time, no browser
 */
export async function browserLogin(options: BrowserLoginOptions): Promise<BrowserLoginResult> {
  const { chromium } = await loadPlaywright();
  const timeout = options.timeout ?? 60_000;
  // One profile per account unless told otherwise; see profileDirFor.
  const profileDir =
    options.profileDir ??
    (options.sharedProfile ? join(PROFILE_ROOT, '_shared') : profileDirFor(options.authInfo1));
  mkdirSync(profileDir, { recursive: true });

  // `headless` must go *through* stealthContextOptions, not be spread over the
  // top of it: the corrections that make headless survive login (user agent,
  // screen, device pixel ratio) are applied there, and setting the flag
  // afterwards would silently get the plain, detected variant.
  const context = await chromium.launchPersistentContext(profileDir, {
    ...stealthContextOptions({
      proxy: options.proxy,
      headless: options.headless,
      executablePath: options.executablePath,
    }),
    ...(options.executablePath ? { executablePath: options.executablePath } : {}),
  } as Parameters<typeof chromium.launchPersistentContext>[1]);

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(timeout);

    // The profile may still hold a valid session from a previous run.
    if (await readCookies(context).then((c) => Boolean(c.auth_token))) {
      const cookies = await readCookies(context);
      return {
        cookies,
        authToken: cookies.auth_token,
        ct0: cookies.ct0,
        reusedSession: true,
      };
    }

    // x.com's login errors arrive in the onboarding action responses rather
    // than the DOM, so capture them to report something actionable.
    const actionErrors: string[] = [];
    page.on('response', async (res: Response) => {
      if (!/jfapi\/onboarding\/web\/actions/.test(res.url())) return;
      const body = await res.text().catch(() => '');
      for (const m of body.matchAll(/[A-Z][^\u0000-\u001f]{15,160}?[.!]/g)) {
        const text = m[0].trim();
        if (/limit|incorrect|wrong|suspend|locked|unusual|try again|verify/i.test(text)) {
          if (!actionErrors.includes(text)) actionErrors.push(text);
        }
      }
    });

    await page.goto('https://x.com/i/flow/login', { waitUntil: 'domcontentloaded' });
    await pause(1800, 3200);
    await dismissCookieBanner(page);

    // The flow is two steps — username, then password — mirroring the
    // `begin_login` / `login_enter_password` actions it posts behind the
    // scenes. Both steps are in the DOM from the start, and the inactive one is
    // marked `inert`, so every field has to be checked for that: Playwright
    // considers an inert input visible, and clicking it hangs until the timeout
    // because the active step's field sits on top of it.
    const identifier = await firstInteractable(
      page,
      ['input[name="username_or_email"]', 'input[name="text"]', 'input[autocomplete~="username"]'],
      timeout
    );
    if (!identifier) throw new Error('Username field never appeared; the login flow may have changed.');
    await typeLikeHuman(identifier, options.authInfo1);
    await pause(300, 700);

    await clickContinue(page);
    await pause(2200, 3500);

    const pw = await firstInteractable(
      page,
      ['input[name="password"]', 'input[type="password"]'],
      timeout
    );
    if (!pw) {
      throw new Error(
        actionErrors.length > 0
          ? `x.com rejected the username: ${actionErrors.join(' | ')}`
          : 'The password step never became active; the login flow may have changed.'
      );
    }
    await typeLikeHuman(pw, options.password);
    await pause(300, 800);
    await clickContinue(page);
    await pause(2200, 3500);

    await handleChallenge(page, options);

    // Success: auth_token becomes available.
    await waitForCookie(context, 'auth_token', timeout);

    const cookies = await readCookies(context);

    if (!cookies.auth_token) {
      if (actionErrors.length > 0) {
        throw new Error(`x.com rejected the login: ${actionErrors.join(' | ')}`);
      }
      throw new Error(
        'Login did not yield an auth_token cookie. No error was reported, so the ' +
          'flow may have changed, or a challenge is pending — rerun with the window ' +
          'visible to watch it.'
      );
    }

    return { cookies, authToken: cookies.auth_token, ct0: cookies.ct0, reusedSession: false };
  } finally {
    await context.close();
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Page = any;
type BrowserContext = any;
type Locator = any;
type Response = any;

/** Every x.com/twitter.com cookie the context currently holds. */
async function readCookies(context: BrowserContext): Promise<Record<string, string>> {
  const cookies: Record<string, string> = {};
  for (const c of await context.cookies(['https://x.com', 'https://twitter.com'])) {
    cookies[c.name] = c.value;
  }
  return cookies;
}

/**
 * Submits the current step.
 *
 * The names are anchored deliberately: the login page also offers
 * "Continue with phone" / "Continue with Google" / "Continue with Apple", and a
 * loose /continue/i match hits one of those and derails into signup.
 */
async function clickContinue(page: Page): Promise<void> {
  // The page holds a form per step, the inactive one inert, so pick the first
  // submit button that is actually live rather than the first in the DOM.
  const submits = page.locator('form button[type="submit"]');
  const total = await submits.count();
  for (let i = 0; i < total; i += 1) {
    const candidate = submits.nth(i);
    if (await isInteractable(candidate)) {
      await clickLikeHuman(page, candidate);
      return;
    }
  }
  for (const name of [/^continue$/i, /^log in$/i, /^next$/i]) {
    const btn = page.getByRole('button', { name }).first();
    if (await isInteractable(btn)) {
      await clickLikeHuman(page, btn);
      return;
    }
  }
  throw new Error('No active submit button found on the current login step.');
}

/**
 * Clicks with a cursor that travels there first.
 *
 * `locator.click()` teleports the pointer to the target and fires, leaving no
 * `mousemove` trail. Castle collects pointer paths, so an otherwise clean
 * session still stands out if every click arrives from nowhere.
 */
async function clickLikeHuman(page: Page, locator: Locator): Promise<void> {
  const box = await locator.boundingBox().catch(() => null);
  if (!box) {
    await locator.click();
    return;
  }
  const x = box.x + box.width * (0.35 + Math.random() * 0.3);
  const y = box.y + box.height * (0.35 + Math.random() * 0.3);
  await page.mouse.move(x, y, { steps: 12 + Math.floor(Math.random() * 12) });
  await pause(60, 180);
  await page.mouse.click(x, y);
}

async function dismissCookieBanner(page: Page): Promise<void> {
  for (const name of [/refuse non-essential/i, /accept all cookies/i]) {
    const btn = page.getByRole('button', { name }).first();
    if ((await btn.count()) && (await btn.isVisible().catch(() => false))) {
      await btn.click().catch(() => {});
      await pause(400, 900);
      return;
    }
  }
}

/**
 * True when the element can actually receive input.
 *
 * Visibility alone is not enough on this page. Both login steps are present in
 * the DOM at once and the inactive one is marked `inert` — a subtree that
 * renders normally, and so reports as visible, but ignores pointer and keyboard
 * events. `closest` covers the element itself as well as any inert ancestor.
 */
async function isInteractable(locator: Locator): Promise<boolean> {
  if (!(await locator.count())) return false;
  if (!(await locator.isVisible().catch(() => false))) return false;
  // Typed loosely: the project's tsconfig has no DOM lib, and this runs in the
  // browser rather than in Node.
  return locator.evaluate((el: any) => !el.closest('[inert]')).catch(() => false);
}

async function firstInteractable(
  page: Page,
  selectors: string[],
  ms: number
): Promise<Locator | null> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if (await isInteractable(loc)) return loc;
    }
    await page.waitForTimeout(250);
  }
  return null;
}

async function handleChallenge(page: Page, options: BrowserLoginOptions): Promise<void> {
  const field = await firstInteractable(
    page,
    ['input[data-testid="ocfEnterTextTextInput"]', 'input[name="text"]', 'input[inputmode="numeric"]'],
    8000
  );
  if (!field) return; // no challenge

  let code: string;
  if (options.totpSecret) {
    code = await totpNow(options.totpSecret);
  } else if (options.onVerificationCode) {
    const label =
      (await page
        .locator('span, div')
        .filter({ hasText: /code|verification/i })
        .first()
        .textContent()
        .catch(() => null)) ?? 'Enter the verification code';
    code = await options.onVerificationCode(label.trim());
  } else {
    throw new Error(
      'A verification code is required. Provide `totpSecret` or an `onVerificationCode` callback.'
    );
  }

  await typeLikeHuman(field, code);
  await pause(300, 700);
  await clickContinue(page);
}

async function waitForCookie(context: BrowserContext, name: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const cookies = await context.cookies();
    if (cookies.some((c: any) => c.name === name && c.value)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
}
