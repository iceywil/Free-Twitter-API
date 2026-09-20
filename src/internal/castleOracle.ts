/**
 * A Castle token source backed by a real (headless) browser.
 *
 * The native {@link CastleSolver} mints tokens in a `node:vm` sandbox, and x.com
 * currently refuses those — the sandbox cannot reproduce the encrypted device
 * signal a real browser collects. This oracle sidesteps that: it loads the login
 * page once in Chrome and mints each token by running x.com's own Castle SDK in
 * the page, where the GPU, canvas, audio and timing are genuine.
 *
 * It is the middle path between the fully-native flow (no browser, refused) and
 * a full browser login (browser drives the whole form). Here the browser does
 * nothing but mint tokens; every HTTP request of the login still goes out from
 * Node. A verified browser-minted token is accepted by a native `begin_login`.
 *
 * Playwright is an optional peer dependency, imported lazily so it is only
 * required when this oracle is actually used.
 */

import { mkdirSync } from 'node:fs';
import {
  PROFILE_ROOT,
  profileDirFor,
  stealthContextOptions,
} from '../browser/stealth.js';
import type { CastleTokenSource } from './castleSolver.js';

export interface BrowserCastleOracleOptions {
  /** Run the token-minting browser headless. Defaults to true. */
  headless?: boolean;
  /** Persistent profile directory; defaults to a per-account one. */
  profileDir?: string;
  /** Used to name the default profile directory. */
  account?: string;
  proxy?: string;
  executablePath?: string;
  timeout?: number;
}

// The token minter, run inside the page. It pulls the Castle module out of the
// app's own webpack runtime and mints a fresh token — the same module x.com uses,
// so no assumptions about a global being exposed.
const MINT_SCRIPT = `(async () => {
  const chunk = window.webpackChunk_twitter_responsive_web;
  if (!chunk) throw new Error('castle: no webpack chunk on page');
  let require;
  chunk.push([[Symbol('ftapi-castle')], {}, (r) => { require = r; }]);
  if (!require || !require.m) throw new Error('castle: webpack require unavailable');
  if (!window.__ftapiCastle) {
    let mod = null;
    for (const id of Object.keys(require.m)) {
      try {
        const m = require(id);
        const api = m && (m.default || m);
        if (api && typeof api.configure === 'function' && typeof api.createRequestToken !== 'undefined') {
          mod = api; break;
        }
        if (api && typeof api.configure === 'function') { mod = mod || api; }
      } catch (e) { /* skip modules that throw on load */ }
    }
    if (!mod) throw new Error('castle: module with configure() not found');
    const pk = (document.documentElement.innerHTML.match(/"responsive_web_castle_public_key"\\s*:\\s*\\{[^}]*?"value"\\s*:\\s*"([^"]+)"/) || [])[1];
    if (!pk) throw new Error('castle: publishable key not found on page');
    window.__ftapiCastle = await mod.configure({ pk });
  }
  return window.__ftapiCastle.createRequestToken();
})()`;

/* eslint-disable @typescript-eslint/no-explicit-any */
type BrowserContext = any;

export class BrowserCastleOracle implements CastleTokenSource {
  private context: BrowserContext | null = null;
  private page: any = null;
  private ready: Promise<void> | null = null;

  constructor(private readonly options: BrowserCastleOracleOptions = {}) {}

  /** The guest token cookie (`gt`) the browser was issued, once started. */
  guestToken = '';

  private async ensureReady(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const { chromium } = await import('playwright');
      const profileDir =
        this.options.profileDir ??
        (this.options.account
          ? profileDirFor(`${this.options.account}-castle`)
          : `${PROFILE_ROOT}/_castle-oracle`);
      mkdirSync(profileDir, { recursive: true });

      this.context = await chromium.launchPersistentContext(profileDir, {
        ...stealthContextOptions({
          headless: this.options.headless ?? true,
          proxy: this.options.proxy,
          executablePath: this.options.executablePath,
        }),
      } as any);
      this.page = this.context.pages()[0] ?? (await this.context.newPage());
      this.page.setDefaultTimeout(this.options.timeout ?? 45_000);
      await this.page.goto('https://x.com/i/flow/login', { waitUntil: 'domcontentloaded' });
      await this.page.waitForTimeout(2500);

      for (const c of await this.context.cookies()) {
        if (c.name === 'gt') this.guestToken = c.value;
      }
    })();
    return this.ready;
  }

  /** Mints a fresh token by running the page's own Castle SDK. */
  async createRequestToken(): Promise<string> {
    await this.ensureReady();
    const token = await this.page.evaluate(MINT_SCRIPT);
    if (typeof token !== 'string' || token.length < 1000) {
      throw new Error('Browser Castle oracle returned an implausible token.');
    }
    return token;
  }

  /** Cookies the browser holds, for seeding the native session. */
  async cookies(): Promise<Record<string, string>> {
    await this.ensureReady();
    const out: Record<string, string> = {};
    for (const c of await this.context.cookies(['https://x.com', 'https://twitter.com'])) {
      out[c.name] = c.value;
    }
    return out;
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => {});
    this.context = null;
    this.page = null;
    this.ready = null;
  }
}
