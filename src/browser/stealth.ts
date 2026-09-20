/**
 * Launch configuration that keeps an automated Chrome indistinguishable from a
 * hand-driven one.
 *
 * x.com fingerprints the device through the Castle.io SDK before it will accept
 * a login. Measured against a real Chrome on the same machine, a default
 * Playwright launch differs on exactly two signals that matter:
 *
 * | signal     | default Playwright  | real Chrome      |
 * | ---------- | ------------------- | ---------------- |
 * | `navigator.webdriver` | `true`   | `false`          |
 * | `screen`   | `1280x720` (viewport) | the real display |
 *
 * Everything else — `userAgentData` brands, `deviceMemory`, the WebGL vendor
 * string, plugins, `Notification.permission` — already matches, *provided* the
 * browser is the locally installed Chrome (`channel: 'chrome'`) rather than
 * bundled Chromium. So this module fixes the two real tells with launch flags
 * and injects no JavaScript shims: a patched getter is itself detectable, and
 * the flags remove the signals at the Blink level instead.
 */

import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_USER_AGENT } from '../constants.js';

/** Root holding one browser profile per account. */
export const PROFILE_ROOT = join(homedir(), '.free-twitter-api', 'profiles');

/**
 * Where the persistent browser profile for one account lives.
 *
 * Deliberately one directory *per account*. A profile is a device identity —
 * Castle's device id, the cookie jar, localStorage and the whole storage
 * partition all live in it. Pointing two accounts at one profile makes them
 * share every one of those, which is precisely how a platform concludes that
 * two accounts are the same person. Keeping them apart is what lets this method
 * be used more than once.
 *
 * Note this isolates everything the *browser* carries, not the network path:
 * accounts used from one IP remain correlatable by IP. Pass `proxy` per account
 * to separate that too.
 */
export function profileDirFor(account: string): string {
  // Keep it filesystem-safe without collapsing distinct names together.
  const slug = account.toLowerCase().replace(/[^a-z0-9._-]/g, '_');
  return join(PROFILE_ROOT, slug);
}

/**
 * Flags that strip Chrome's automation markers.
 *
 * `--disable-blink-features=AutomationControlled` is what turns
 * `navigator.webdriver` off; dropping `--enable-automation` also removes the
 * "Chrome is being controlled by automated test software" infobar, which shifts
 * the viewport and is visible to the page through the window dimensions.
 */
export const STEALTH_ARGS = ['--disable-blink-features=AutomationControlled'];

export const STEALTH_IGNORED_DEFAULT_ARGS = ['--enable-automation'];

export interface StealthLaunchOptions {
  headed?: boolean;
  proxy?: string;
  locale?: string;
  /** Extra Chrome flags, appended after the stealth ones. */
  args?: string[];
  /** Apply the headless corrections from {@link headlessOverrides}. */
  headless?: boolean;
  /** Chrome binary, when it is not in the standard location. */
  executablePath?: string;
}

/**
 * The real Chrome UA, with no "Headless" in it.
 *
 * Read from the installed binary rather than hardcoded, because it has to agree
 * with the `sec-ch-ua` client hints Chrome sends, and those carry the true
 * version. A stale constant here would swap one inconsistency for another.
 */
export function realChromeUserAgent(executablePath?: string): string {
  const binary =
    executablePath ??
    (platform() === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : platform() === 'win32'
        ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
        : '/usr/bin/google-chrome');

  let major = '';
  try {
    const out = spawnSync(binary, ['--version'], { encoding: 'utf-8', timeout: 5000 }).stdout ?? '';
    major = /(\d+)\./.exec(out)?.[1] ?? '';
  } catch {
    /* fall through to the bundled default */
  }
  if (!major) return DEFAULT_USER_AGENT;

  const osPart =
    platform() === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : platform() === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${osPart}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/**
 * Corrections that close the measured gap between headless and headed Chrome.
 *
 * Under the stealth config the two differ on only a handful of signals — WebGL,
 * canvas, audio, plugins, codecs and `navigator.webdriver` already match, and
 * headless even uses the real GPU. What is left:
 *
 * - **`HeadlessChrome` in the UA.** The giveaway, and self-contradictory:
 *   Chrome's own `sec-ch-ua` hints still say "Google Chrome" in headless, so
 *   the UA disagrees with the hints beside it. Overriding it removes an
 *   inconsistency rather than adding one.
 * - **`devicePixelRatio` 1, `screen` equal to the viewport.** Headless has no
 *   window, so the screen collapses onto the viewport and the display stops
 *   looking like the Retina panel the GPU string implies.
 *
 * `colorDepth` still reads 24 against the headed 30. It is left alone: 24 is
 * the commonest value in the world, so it is unremarkable on its own, and
 * patching a getter is itself detectable.
 */
export function headlessOverrides(executablePath?: string): Record<string, unknown> {
  return {
    headless: true,
    userAgent: realChromeUserAgent(executablePath),
    // A window smaller than the screen, as a real one is — and the Retina
    // scale factor the Apple GPU string implies.
    screen: { width: 1728, height: 1117 },
    viewport: { width: 1200, height: 816 },
    deviceScaleFactor: 2,
    args: [...STEALTH_ARGS, '--window-size=1200,880'],
  };
}

/**
 * Builds the options for `chromium.launchPersistentContext`.
 *
 * A persistent profile is not a convenience here: Castle derives a device
 * identity from browser-local state, so a fresh profile on every attempt looks
 * like a new device logging into the same account each time — which is the
 * pattern that gets challenged. Reusing one profile makes the second login look
 * like a returning device, and usually means no login is needed at all because
 * the session cookies are still in the profile.
 *
 * `viewport: null` is what lets `screen` report the real display; setting any
 * explicit viewport makes Chrome report that size as the screen.
 */
export function stealthContextOptions(options: StealthLaunchOptions = {}): Record<string, unknown> {
  const base = {
    headless: false,
    channel: 'chrome',
    viewport: null,
    locale: options.locale ?? 'en-US',
    args: [...STEALTH_ARGS, ...(options.args ?? [])],
    ignoreDefaultArgs: STEALTH_IGNORED_DEFAULT_ARGS,
    ...(options.proxy ? { proxy: { server: options.proxy } } : {}),
  };
  if (!options.headless) return base;
  const over = headlessOverrides(options.executablePath);
  return {
    ...base,
    ...over,
    args: [...(over.args as string[]), ...(options.args ?? [])],
  };
}

/**
 * Types into a field the way a person does.
 *
 * `locator.fill()` sets `value` in one assignment and emits a single `input`
 * event. Castle watches per-keystroke timing, so a field that goes from empty
 * to a full password with no `keydown` sequence is a strong bot signal. This
 * clicks the field first (producing the focus and mouse events a real entry
 * has) and then types with a varying per-character delay.
 */
export async function typeLikeHuman(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  locator: any,
  text: string,
  meanDelayMs = 90
): Promise<void> {
  // Focusing by click is what a person does, but never let it hang: a covered
  // or inert field would otherwise burn the full default timeout before saying
  // so. Falling back to focus() still gets the keystrokes delivered.
  await locator.click({ timeout: 10_000 }).catch(() => locator.focus());
  await pause(120, 320);
  for (const char of text) {
    await locator.press(keyFor(char));
    // Humans are not metronomes; jitter around the mean rather than repeating it.
    await pause(meanDelayMs * 0.45, meanDelayMs * 1.8);
  }
}

/** Playwright's `press` wants key names, so map the characters that differ. */
function keyFor(char: string): string {
  if (char === ' ') return 'Space';
  return char;
}

/** Waits a random duration in `[minMs, maxMs]`. */
export function pause(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise((resolve) => setTimeout(resolve, ms));
}
