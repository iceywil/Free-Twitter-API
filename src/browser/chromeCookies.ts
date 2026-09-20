/**
 * Imports an existing x.com session out of the locally installed Google Chrome.
 *
 * If you are already logged into x.com in your normal browser, there is no
 * reason to drive a login form at all — the session cookies are sitting in
 * Chrome. This asks Chrome for them over the DevTools protocol rather than
 * reading its cookie database directly: on macOS and Windows that file is
 * encrypted with a key held in the OS keychain, and prying it open means
 * handling the user's credential store. Attaching to the browser makes Chrome
 * decrypt its own cookies, so nothing here touches the keychain.
 *
 * IMPORTANT: this cannot read your everyday Chrome profile. Since Chrome 136,
 * Chrome refuses `--remote-debugging-port` whenever the user-data directory is
 * the default one, precisely to block this kind of extraction; the flag is
 * ignored and no DevTools endpoint appears. It works only against a separate
 * profile, which you must start yourself and log into:
 *
 * ```sh
 * "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *   --remote-debugging-port=9222 --user-data-dir=/tmp/x-profile
 * ```
 *
 * For most uses `browserLogin` is simpler — it manages such a profile for you.
 */

import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

export interface ImportChromeCookiesOptions {
  /** DevTools port to attach to, or to start Chrome on. Defaults to 9222. */
  port?: number;
  /**
   * Chrome's user-data directory. Defaults to the standard per-OS location,
   * i.e. the profile you browse with every day.
   */
  userDataDir?: string;
  /** Profile inside that directory, e.g. `'Default'` or `'Profile 1'`. */
  profileDirectory?: string;
  /** Path to the Chrome binary. Defaults to the standard per-OS location. */
  executablePath?: string;
  /**
   * Start Chrome if nothing is listening on `port`. Defaults to true. With
   * `false`, a closed port is an error instead.
   */
  launch?: boolean;
  /** Leave the Chrome that this function started running. Defaults to false. */
  keepOpen?: boolean;
  /** Milliseconds to wait for Chrome to come up. Defaults to 30000. */
  timeout?: number;
}

export interface ImportedSession {
  /** Session cookies, ready for `Client.setCookies`. */
  cookies: Record<string, string>;
  authToken?: string;
  ct0?: string;
}

/** Standard Chrome user-data directory per platform. */
export function defaultChromeUserDataDir(): string {
  const home = homedir();
  switch (platform()) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Google', 'Chrome');
    case 'win32':
      return join(
        process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'),
        'Google',
        'Chrome',
        'User Data'
      );
    default:
      return join(home, '.config', 'google-chrome');
  }
}

/** Standard Chrome executable path per platform. */
export function defaultChromeExecutable(): string {
  switch (platform()) {
    case 'darwin':
      return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    case 'win32':
      return join(
        process.env.PROGRAMFILES ?? 'C:\\Program Files',
        'Google',
        'Chrome',
        'Application',
        'chrome.exe'
      );
    default:
      return '/usr/bin/google-chrome';
  }
}

/** True when a DevTools endpoint answers on `port`. */
async function devtoolsIsUp(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForDevtools(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await devtoolsIsUp(port)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(
    `Chrome's DevTools endpoint never came up on port ${port}. Since Chrome 136, ` +
      'Chrome ignores --remote-debugging-port for the default profile directory, ' +
      'so the everyday profile cannot be read this way. Pass a `userDataDir` of ' +
      'your own and log into x.com there, or use browserLogin() instead.'
  );
}

/**
 * Pulls the x.com/twitter.com cookies out of Chrome.
 *
 * @example
 * import { importChromeCookies } from 'free-twitter-api/browser';
 * import { Client } from 'free-twitter-api';
 *
 * const { cookies } = await importChromeCookies();
 * const client = new Client();
 * client.setCookies(cookies);
 * await client.saveCookies('cookies.json'); // reuse from Node, no browser
 */
export async function importChromeCookies(
  options: ImportChromeCookiesOptions = {}
): Promise<ImportedSession> {
  const port = options.port ?? 9222;
  const timeout = options.timeout ?? 30_000;
  const shouldLaunch = options.launch ?? true;

  let child: ChildProcess | undefined;

  if (!(await devtoolsIsUp(port))) {
    if (!shouldLaunch) {
      throw new Error(
        `Nothing is listening on port ${port}. Start Chrome with ` +
          `--remote-debugging-port=${port}, or leave \`launch\` enabled.`
      );
    }
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${options.userDataDir ?? defaultChromeUserDataDir()}`,
      ...(options.profileDirectory ? [`--profile-directory=${options.profileDirectory}`] : []),
      '--no-first-run',
      '--no-default-browser-check',
    ];
    child = spawn(options.executablePath ?? defaultChromeExecutable(), args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    await waitForDevtools(port, timeout);
  }

  const { chromium } = await import('playwright');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);

  try {
    const cookies: Record<string, string> = {};
    for (const context of browser.contexts()) {
      for (const cookie of await context.cookies(['https://x.com', 'https://twitter.com'])) {
        cookies[cookie.name] = cookie.value;
      }
    }

    if (!cookies.auth_token) {
      throw new Error(
        'Chrome holds no x.com auth_token cookie. Log into x.com in Chrome ' +
          'first, then run this again.'
      );
    }

    return { cookies, authToken: cookies.auth_token, ct0: cookies.ct0 };
  } finally {
    // Detach without closing: the browser may be the user's own window.
    await browser.close().catch(() => {});
    if (child && !options.keepOpen) child.kill();
  }
}
