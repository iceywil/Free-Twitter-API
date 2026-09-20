/**
 * Native login against x.com's current `/i/jfapi/onboarding/web/actions/*`
 * flow — no browser.
 *
 * x.com retired `1.1/onboarding/task.json`, the flow older clients drive. The
 * live flow is: `begin_login` (username + Castle token) → `login_enter_password`
 * (username + password + session token + Castle token), with optional 2FA. Each
 * request needs a valid `x-client-transaction-id` and a Castle device token,
 * both of which this library now generates natively.
 *
 * Verified: a natively-minted Castle token is accepted by `begin_login`
 * (the request reaches username validation). See {@link CastleSolver}.
 */

import { randomBytes } from 'node:crypto';
import * as cheerio from 'cheerio';
import { TOKEN } from '../constants.js';
import { AccountLocked, TwitterException, TooManyRequests } from '../errors.js';
import { CastleSolver, type CastleTokenSource } from '../internal/castleSolver.js';
import type { HttpSession } from '../internal/http.js';
import { resolveOndemandCastleUrl } from '../transaction/utils.js';

const JF_VERSION = 'JP-5';

export interface NativeLoginParams {
  authInfo1: string;
  authInfo2?: string;
  password: string;
  totpSecret?: string;
  timezone?: string;
  userAgent: string;
  guestToken: string;
  /** Generates an `x-client-transaction-id` for a method + path. */
  transactionId: (method: string, path: string) => string | Promise<string>;
  /** Supplies a verification/2FA code when x.com asks and no TOTP secret is set. */
  prompt: (message: string) => Promise<string>;
  /**
   * Overrides how `$castle_token` is minted. Defaults to the native sandbox
   * solver; pass a browser-backed oracle for full-strength tokens.
   */
  castleSource?: CastleTokenSource;
}

/** Extracts printable ASCII runs from a length-delimited jfapi response body. */
function readableStrings(body: string): string[] {
  // x.com writes user-facing messages with typographic punctuation, so "We've"
  // arrives with U+2019 rather than an ASCII apostrophe. That is outside the
  // printable-ASCII range kept below, so without folding it first the message
  // is split in two and any pattern spanning the apostrophe silently never
  // matches — which made a plain rate-limit surface as a missing session token.
  const normalised = body.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  return [...normalised.matchAll(/[\x20-\x7e]{4,}/g)].map((m) => m[0]);
}

function findError(strings: string[]): string | null {
  const joined = strings.join(' ');
  // Bounded to one sentence: the body repeats each message once per field, so
  // an unbounded run swallows the duplicate and reports it twice.
  const patterns = [
    /We(?:'|’)?ve temporarily limited your login[^".]*\.[^".]*\./i,
    /couldn(?:'|’)?t find an active X account[^".]*\./i,
    /(?:incorrect|wrong) (?:password|username)[^"]*/i,
    /your account is suspended[^"]*/i,
  ];
  for (const p of patterns) {
    const m = p.exec(joined);
    if (m) return m[0];
  }
  return null;
}

/**
 * The onboarding session token returned by `begin_login`.
 *
 * It is a plain UUID, but it does not arrive as a string of its own: the wire
 * format runs the field name straight into the value, so the printable run
 * reads `session_token$59f6a1a9-...`. Matching an *anchored* 36-character run
 * therefore never fires, even on a perfectly good response — search within the
 * strings instead of comparing whole ones.
 */
function findSessionToken(strings: string[]): string | null {
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  // Prefer the one actually labelled as the session token.
  for (const s of strings) {
    if (/session_token/i.test(s)) {
      const m = uuid.exec(s);
      if (m) return m[0];
    }
  }
  for (const s of strings) {
    const m = uuid.exec(s);
    if (m) return m[0];
  }
  return null;
}

/**
 * The onboarding action names referenced in a response, in order.
 *
 * Each jfapi response embeds the paths of the actions reachable from the
 * current step (e.g. `.../actions/login_enter_password`), which is how the flow
 * discovers the next step rather than hardcoding it. `begin_password_recovery`
 * is dropped — it is the "forgot password" branch, never the forward path.
 */
function actions(strings: string[]): string[] {
  const found: string[] = [];
  for (const s of strings) {
    for (const m of s.matchAll(/\/onboarding\/web\/actions\/([a-z_]+)/gi)) {
      const name = m[1];
      if (name !== 'begin_password_recovery' && !found.includes(name)) found.push(name);
    }
  }
  return found;
}

export class NativeLoginFlow {
  private constructor(
    private readonly session: HttpSession,
    private readonly params: NativeLoginParams,
    private readonly castle: CastleTokenSource
  ) {}

  /**
   * Prepares a login flow.
   *
   * The Castle token source is pluggable. By default it is the native
   * {@link CastleSolver}, which reads the publishable key from the login shell
   * and runs the SDK in a `node:vm` sandbox — no browser, but the token it mints
   * is currently refused. Pass `params.castleSource` (e.g. a browser-backed
   * oracle) to supply full-strength tokens while keeping every HTTP request
   * native.
   */
  static async create(
    session: HttpSession,
    params: NativeLoginParams
  ): Promise<NativeLoginFlow> {
    if (params.castleSource) {
      return new NativeLoginFlow(session, params, params.castleSource);
    }

    const shell = await session.request('GET', 'https://x.com/i/flow/login', {
      headers: { 'User-Agent': params.userAgent, 'Accept-Language': 'en-US,en;q=0.9' },
    });
    const html = shell.text;

    const pk = /"responsive_web_castle_public_key"\s*:\s*\{[^}]*?"value"\s*:\s*"([^"]+)"/.exec(html)?.[1];
    if (!pk) {
      throw new TwitterException('Could not read the Castle publishable key from the login page.');
    }

    const castleUrl = resolveOndemandCastleUrl(html);
    if (!castleUrl) {
      throw new TwitterException('Could not locate the Castle SDK bundle (ondemand.castle).');
    }
    const sdk = await session.request('GET', castleUrl, {
      headers: { 'User-Agent': params.userAgent },
    });
    if (sdk.status !== 200) {
      throw new TwitterException(`Failed to fetch the Castle SDK (status ${sdk.status}).`);
    }

    const castle = new CastleSolver(sdk.text, pk, {
      userAgent: params.userAgent,
      timezone: params.timezone,
    });
    return new NativeLoginFlow(session, params, castle);
  }

  /**
   * Headers matching a real browser's, byte for byte where it matters.
   *
   * Captured from Chrome driving this same flow (see docs/native-login.md). The
   * client hints and `sec-fetch-*` set were previously absent entirely, which
   * no browser request ever is; the client-hint values are derived from the
   * user agent so the two cannot disagree.
   */
  private async jfHeaders(method: 'GET' | 'POST', path: string): Promise<Record<string, string>> {
    const major = /Chrome\/(\d+)/.exec(this.params.userAgent)?.[1] ?? '153';
    const platform = /Macintosh/.test(this.params.userAgent)
      ? '"macOS"'
      : /Windows/.test(this.params.userAgent)
        ? '"Windows"'
        : '"Linux"';

    return {
      accept: '*/*',
      // Chrome always advertises these, and our HTTP layer can decode them.
      'accept-encoding': 'gzip, deflate, br',
      'accept-language': 'en',
      authorization: `Bearer ${TOKEN}`,
      ...(method === 'POST'
        ? { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://x.com' }
        : {}),
      priority: 'u=1, i',
      referer: 'https://x.com/i/jf/onboarding/web?mode=login',
      'sec-ch-ua': `"Google Chrome";v="${major}", "Not_A Brand";v="8", "Chromium";v="${major}"`,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': platform,
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'User-Agent': this.params.userAgent,
      'x-client-transaction-id': await this.params.transactionId(method, path),
      'x-guest-token': this.params.guestToken,
      'x-jf-client-theme': 'light',
      'x-jf-v': JF_VERSION,
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'en',
      ...(this.params.timezone ? { timezone: this.params.timezone } : {}),
    };
  }

  /**
   * Walks the GETs a browser performs before it ever posts.
   *
   * Chrome requests `landing`, `passkey_one_fa`, `web?mode=login` and
   * `passkey_one_fa` again on the way to the login form. Jumping straight to
   * `begin_login` skips all of it, which is both a behavioural difference and
   * the reason the session never accumulates the cookies a browser arrives
   * with. Failures are non-fatal: this is about arriving the way a browser
   * does, not about the payloads.
   */
  private async warmUp(): Promise<void> {
    const steps = [
      '/i/jfapi/onboarding/web/landing',
      '/i/jfapi/onboarding/web/remotes/passkey_one_fa?form_id=landing',
      '/i/jfapi/onboarding/web?mode=login',
      '/i/jfapi/onboarding/web/remotes/passkey_one_fa',
    ];
    for (const step of steps) {
      const path = step.split('?')[0];
      try {
        await this.session.request('GET', `https://x.com${step}`, {
          headers: await this.jfHeaders('GET', path),
        });
      } catch {
        // A warm-up step failing should not abort the login.
      }
      // Real navigation is not instantaneous, and these arrive as a person
      // moves through the form rather than all at once.
      await new Promise((r) => setTimeout(r, 120 + Math.random() * 380));
    }
  }

  private async post(path: string, fields: [string, string][]): Promise<string[]> {
    const body = new URLSearchParams();
    for (const [k, v] of fields) body.append(k, v);

    const res = await this.session.request('POST', `https://x.com${path}`, {
      headers: await this.jfHeaders('POST', path),
      data: body.toString(),
    });

    const strings = readableStrings(res.text);
    // The bodies are an opaque length-delimited format, so set FTAPI_DEBUG_JF
    // to see what a step actually returned when one misbehaves.
    if (process.env.FTAPI_DEBUG_JF) {
      console.error('[jf]', path, res.status, JSON.stringify(strings));
    }
    const error = findError(strings);
    if (error) {
      if (/temporarily limited/i.test(error)) throw new TooManyRequests(error);
      if (/suspended/i.test(error)) throw new AccountLocked(error);
      throw new TwitterException(error);
    }
    if (res.status >= 400) {
      throw new TwitterException(`${path} failed with status ${res.status}`);
    }
    return strings;
  }

  /** Runs the flow and returns the session cookies on success. */
  async run(): Promise<Record<string, string>> {
    // A browser carries the guest token as a `gt` cookie as well as the header;
    // we hold the value already, so seed it rather than arriving without it.
    this.session.setCookies({ gt: this.params.guestToken });

    // Arrive the way a browser does, rather than straight at the first POST.
    await this.warmUp();

    // Step 1: begin_login.
    const begin = await this.post('/i/jfapi/onboarding/web/actions/begin_login', [
      ['username_or_email', this.params.authInfo1],
      ['$castle_token', await this.castle.createRequestToken()],
    ]);

    const sessionToken = findSessionToken(begin);
    if (!sessionToken) {
      throw new TwitterException('begin_login did not return a session token.');
    }

    // A person takes seconds to read the next step and type a password; the
    // captured browser posted these ten seconds apart, and the Castle token it
    // sent had grown in the interval because the SDK keeps collecting.
    await new Promise((r) => setTimeout(r, 2500 + Math.random() * 2500));

    // Step 2: login_enter_password.
    const afterPassword = await this.post('/i/jfapi/onboarding/web/actions/login_enter_password', [
      ['username', this.params.authInfo1],
      ['password', this.params.password],
      ['session_token', sessionToken],
      ['$castle_token', await this.castle.createRequestToken()],
    ]);

    // Step 3: 2FA, if x.com asked for it. The action names are not guessed —
    // each response carries the path of the next action to POST (the same way
    // it carries the session token), and the flow is:
    //   login_enter_password -> begin_two_factor_auth -> finish_two_factor_auth
    // `begin_two_factor_auth` prepares the challenge and its response names the
    // finish action, the method (`Totp`) and the field the code goes in
    // (`challenge_response`, not `code`). Captured from a live 2FA login; see
    // docs/native-login.md.
    if (actions(afterPassword).includes('begin_two_factor_auth')) {
      const begun = await this.post('/i/jfapi/onboarding/web/actions/begin_two_factor_auth', [
        ['session_token', sessionToken],
        ['$castle_token', await this.castle.createRequestToken()],
      ]);

      const finish = actions(begun).find((a) => a.startsWith('finish')) ?? 'finish_two_factor_auth';
      // The method the account offers; only TOTP is handled here.
      const method = 'Totp';
      const code = this.params.totpSecret
        ? await totpNow(this.params.totpSecret)
        : await this.params.prompt('Enter your verification code');

      await this.post(`/i/jfapi/onboarding/web/actions/${finish}`, [
        ['session_token', sessionToken],
        ['challenge_response', code],
        ['two_factor_auth_method_type', method],
        ['$castle_token', await this.castle.createRequestToken()],
      ]);
    }

    const cookies = this.session.getCookies();
    if (!cookies.auth_token) {
      throw new TwitterException(
        'Login completed without an auth_token cookie; a challenge may be pending.'
      );
    }

    // x.com sets `ct0` (the CSRF token) on the password response for browser
    // clients, but does not always do so over this flow. Reads work without it,
    // writes do not. When it is absent, mint one: x.com uses a double-submit
    // CSRF scheme, so a client-generated `ct0` is accepted as long as the cookie
    // and the `x-csrf-token` header carry the same value. 160 hex chars matches
    // the token a browser is issued.
    if (!cookies.ct0) {
      const ct0 = randomHex(160);
      this.session.setCookies({ ct0 });
      cookies.ct0 = ct0;
    }
    return cookies;
  }
}

async function totpNow(secret: string): Promise<string> {
  const { TOTP } = await import('otpauth');
  return new TOTP({ secret }).generate();
}

export { cheerio };

/** Internals exposed for tests; not part of the public API. */
export const __testing = { readableStrings, findError, findSessionToken };

/** A lowercase hex string of the given length (for a synthesised `ct0`). */
function randomHex(chars: number): string {
  return randomBytes(Math.ceil(chars / 2)).toString('hex').slice(0, chars);
}
