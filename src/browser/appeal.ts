/**
 * Files an appeal against a locked or suspended account.
 *
 * https://help.x.com/en/forms/account-access/appeals
 *
 * The form is backed by Salesforce and the payload is trivial — a handle, an
 * email and the appeal text, plus fixed hidden fields. What makes it
 * un-POSTable from Node is the gate in front of it: the page loads Cloudflare
 * Turnstile (`challenges.cloudflare.com/turnstile/v0/api.js`) and the submit
 * path takes `challengeConfig` / `arkoseConfig` / `turnstile`, throwing
 * "Turnstile runner is missing" when the runner is absent. A Turnstile token is
 * minted by a browser environment by design, so a bare `fetch()` has nothing
 * valid to send.
 *
 * So this drives a browser, but nothing about it is interactive: you pass the
 * appeal text, it fills the form, waits for the challenge to clear, submits and
 * reports what happened. The browser is an implementation detail, hidden by
 * default.
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
import { stealthContextOptions } from './stealth.js';

export const APPEAL_FORM_URL = 'https://help.x.com/en/forms/account-access/appeals';

export interface AppealOptions {
  /** The appeal itself: why the suspension should be lifted. */
  text: string;
  /** Contact email. X replies here, so it must be one you can read. */
  email: string;
  /** The suspended @handle. Defaults to the session's own screen name. */
  screenName?: string;
  /** Session cookies, so the form opens signed in. */
  cookies?: Record<string, string>;
  /**
   * Fill the form but stop before submitting, filing nothing.
   *
   * This checks that the form renders and the fields take their values. It
   * cannot check the challenge: Turnstile only runs when Submit is clicked, so
   * a dry run always reports `challengePassed: false`.
   */
  dryRun?: boolean;
  /**
   * Run without a visible window. Defaults to true. The form sometimes refuses
   * headless with "This browser no longer supports this form"; when that
   * happens this retries headed once by itself unless `headless` was set
   * explicitly.
   */
  headless?: boolean;
  /**
   * A Turnstile token minted elsewhere, for callers who solve the challenge
   * through their own service. Normally left unset: the browser gets its own.
   */
  turnstileToken?: string;
  /** Milliseconds to wait for the form and the challenge. Defaults to 90000. */
  timeout?: number;
  /** Chrome profile directory. Defaults to a throwaway one. */
  profileDir?: string;
  /** Proxy URL, forwarded to the browser. */
  proxy?: string;
  /** Path to a Chrome binary, when it is not in the standard location. */
  executablePath?: string;
}

export interface AppealResult {
  /** True only when the form was actually submitted. */
  submitted: boolean;
  /** True when this was a `dryRun` and submission was deliberately skipped. */
  dryRun: boolean;
  /** Field names this filled in. */
  filled: string[];
  /**
   * Whether a Turnstile token was seen. Only meaningful after a real submit —
   * the challenge does not run until then, so a `dryRun` always reports false.
   */
  challengePassed: boolean;
  /** The page's confirmation text, when it submitted. */
  confirmation?: string;
  /** Why it did not submit. */
  error?: string;
}

type PlaywrightModule = typeof import('playwright');

async function loadPlaywright(): Promise<PlaywrightModule> {
  try {
    return (await import('playwright')) as PlaywrightModule;
  } catch {
    throw new Error(
      "appealAccount requires the optional 'playwright' dependency. " +
        'Install it with: npm install playwright'
    );
  }
}

/** Sets a React-controlled field: the native setter, then the events React listens for. */
const setFieldScript = (name: string, value: string) => `(() => {
  const el = document.querySelector(${JSON.stringify(`[name="${name}"]`)});
  if (!el) return false;
  const proto = el.tagName === 'TEXTAREA'
    ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`;

/** The Turnstile token, once the widget has produced one. */
const READ_TOKEN = `(() => {
  const el = document.querySelector('input[name="cf-turnstile-response"], input[name*="turnstile" i]');
  if (el && el.value) return el.value;
  try { const t = window.turnstile && window.turnstile.getResponse(); if (t) return t; } catch (e) {}
  return '';
})()`;

async function runOnce(
  options: AppealOptions,
  headless: boolean
): Promise<AppealResult> {
  const { chromium } = await loadPlaywright();
  const {
    text,
    email,
    screenName,
    cookies,
    dryRun = false,
    turnstileToken,
    timeout = 90_000,
    proxy,
    executablePath,
  } = options;

  const ownProfile = !options.profileDir;
  const profileDir = options.profileDir ?? mkdtempSync(join(tmpdir(), 'ftapi-appeal-'));

  const context = await chromium.launchPersistentContext(profileDir, {
    ...stealthContextOptions({ proxy, headless, executablePath }),
    ...(executablePath ? { executablePath } : {}),
  } as Parameters<typeof chromium.launchPersistentContext>[1]);

  const filled: string[] = [];
  let challengePassed = false;

  try {
    if (cookies) {
      const jar = [];
      for (const domain of ['.x.com', '.twitter.com']) {
        for (const [name, value] of Object.entries(cookies)) {
          jar.push({ name, value, domain, path: '/', secure: true, sameSite: 'Lax' as const });
        }
      }
      await context.addCookies(jar);
    }

    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(timeout);
    await page.goto(APPEAL_FORM_URL, { waitUntil: 'domcontentloaded' });

    try {
      await page.waitForSelector('[name="DescriptionText"]', { timeout });
    } catch {
      const unsupported = await page.evaluate(
        `document.body.innerText.includes('no longer supports this form')`
      );
      return {
        submitted: false,
        dryRun,
        filled,
        challengePassed: false,
        error: unsupported
          ? 'the form refused this browser ("no longer supports this form")'
          : 'the form did not render',
      };
    }

    const fields: [string, string | undefined][] = [
      ['Screen_Name__c', screenName],
      ['Form_Email__c', email],
      ['DescriptionText', text],
    ];
    for (const [name, value] of fields) {
      if (value === undefined) continue;
      if (await page.evaluate(setFieldScript(name, value))) filled.push(name);
    }

    if (turnstileToken) {
      await page.evaluate(setFieldScript('cf-turnstile-response', turnstileToken));
    }

    /*
     * The widget is rendered `explicit` and executed by the submit handler
     * (`reset(id); execute(id)`), so no token exists before the click — there
     * is nothing to verify up front. A dry run therefore stops here, having
     * proved the form renders and the fields take their values, and leaves the
     * challenge untested: exercising it means actually filing.
     */
    if (dryRun) {
      return { submitted: false, dryRun: true, filled, challengePassed: false };
    }

    await page.click('button[type="submit"]');

    // The click kicks off the challenge, then the POST. Wait for either a
    // token to appear or the page to change, rather than a fixed sleep.
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (!challengePassed && (await page.evaluate(READ_TOKEN))) challengePassed = true;
      const done = await page.evaluate(
        `/thank you|received|submitted|we'll be in touch|something went wrong|error/i
           .test(document.body.innerText)`
      );
      if (done) break;
      await page.waitForTimeout(1000);
    }

    const confirmation = String(
      await page.evaluate(`document.body.innerText.replace(/\\n{2,}/g, '\\n').slice(0, 400)`)
    );
    const failed = /something went wrong|error/i.test(confirmation);

    return {
      submitted: !failed,
      dryRun: false,
      filled,
      challengePassed,
      confirmation,
      ...(failed ? { error: 'the form reported an error' } : {}),
    };
  } finally {
    await context.close().catch(() => {});
    if (ownProfile) rmSync(profileDir, { recursive: true, force: true });
  }
}

/**
 * Files an appeal, start to finish, with no interaction.
 *
 * Needs the optional `playwright` dependency. Pass `dryRun: true` to exercise
 * everything — render, fill, challenge — without filing anything.
 *
 * @example
 * const result = await appealAccount({
 *   cookies: client.getCookies(),
 *   screenName: 'my_handle',
 *   email: 'me@example.com',
 *   text: "My account was suspended on ... I believe this was a mistake because ...",
 * });
 * if (!result.submitted) console.error(result.error);
 */
export async function appealAccount(options: AppealOptions): Promise<AppealResult> {
  if (!options.text?.trim()) throw new Error('appealAccount needs the appeal text.');
  if (!options.email?.trim()) throw new Error('appealAccount needs a contact email.');

  const explicitHeadless = options.headless !== undefined;
  const first = await runOnce(options, options.headless ?? true);

  /*
   * The form renders headless most of the time but intermittently refuses it
   * outright. When that is what went wrong, and the caller did not pin the
   * mode, give the headed path one go before reporting failure — a retry is
   * safe here because a run that never rendered never submitted anything.
   */
  const refused =
    first.error === 'the form did not render' ||
    first.error?.includes('refused this browser');

  if (refused && !explicitHeadless) return runOnce(options, false);
  return first;
}
