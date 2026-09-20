/**
 * Parses the colon-delimited account records used by bulk-account providers and
 * anti-detect browsers (AdsPower and similar), and extracts a usable session.
 *
 * The format seen in the wild is:
 *
 *   username:password:totpSecret:email:emailPassword:authToken:base64(cookiesJson)
 *
 * Trailing fields are often present, and the last is a base64-encoded JSON array
 * of cookie objects (the browser's exported jar). When a record carries live
 * cookies, prefer {@link accountSessionCookies} over logging in at all — it is
 * instant and avoids the device-assessment gauntlet entirely.
 */

export interface AccountRecord {
  username: string;
  password: string;
  /** Base32 TOTP secret for 2FA, if the record includes one. */
  totpSecret?: string;
  email?: string;
  emailPassword?: string;
  /** The `auth_token` value, if present as its own field. */
  authToken?: string;
  /** Every cookie from the exported jar, by name (all domains). */
  cookies?: Record<string, string>;
}

/** A 16+ char base32 string, i.e. a plausible TOTP secret. */
function looksLikeTotp(s: string): boolean {
  return /^[A-Z2-7]{16,}$/.test(s);
}

/** Decodes the base64 cookie-jar field into a name→value map, or undefined. */
function decodeCookieField(field: string): Record<string, string> | undefined {
  if (!field || field.length < 32) return undefined;
  try {
    const json = Buffer.from(field, 'base64').toString('utf-8');
    const arr = JSON.parse(json) as Array<{ name?: string; value?: string }>;
    if (!Array.isArray(arr)) return undefined;
    const out: Record<string, string> = {};
    for (const c of arr) if (c && typeof c.name === 'string') out[c.name] = String(c.value ?? '');
    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parses one account record line.
 *
 * Fields are positional (username, password come first), but the optional
 * middle fields vary between providers, so they are detected by shape: a base32
 * run is the TOTP secret, an `@` field is the email, a 40-hex field is the
 * auth token, and a long base64 field is the cookie jar.
 */
export function parseAccountRecord(line: string): AccountRecord {
  const parts = line.trim().split(':');
  if (parts.length < 2) throw new Error('Account record needs at least username:password.');

  const rec: AccountRecord = { username: parts[0], password: parts[1] };
  for (const field of parts.slice(2)) {
    if (!rec.totpSecret && looksLikeTotp(field)) rec.totpSecret = field;
    else if (!rec.email && field.includes('@')) rec.email = field;
    else if (!rec.authToken && /^[0-9a-f]{40}$/i.test(field)) rec.authToken = field;
    else if (!rec.cookies) {
      const cookies = decodeCookieField(field);
      if (cookies) rec.cookies = cookies;
      else if (!rec.emailPassword && rec.email) rec.emailPassword = field;
    } else if (!rec.emailPassword && rec.email) {
      rec.emailPassword = field;
    }
  }
  return rec;
}

/**
 * The session cookies from a record, ready for `Client.setCookies`, or
 * undefined if the record carries no live session.
 *
 * Only the cookies that authenticate the API are kept: `auth_token`, `ct0`,
 * `guest_id`, `twid` and `gt`. `cf_clearance` is deliberately dropped — it is
 * bound to the exporting browser's TLS fingerprint and makes Cloudflare reject
 * requests coming from anywhere else.
 */
export function accountSessionCookies(rec: AccountRecord): Record<string, string> | undefined {
  const jar = rec.cookies ?? {};
  const auth = jar.auth_token ?? rec.authToken;
  if (!auth) return undefined;
  const out: Record<string, string> = { auth_token: auth };
  for (const name of ['ct0', 'guest_id', 'twid', 'gt']) if (jar[name]) out[name] = jar[name];
  return out;
}
