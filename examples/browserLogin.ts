/**
 * Get session cookies through a real browser, then run everything from Node.
 *
 * Use this when a native `client.login()` is rejected: x.com scores the device
 * through Castle.io, so correct credentials alone are not always enough.
 *
 * Needs the optional peer dependency and the Google Chrome already installed on
 * the machine (do NOT run `npx playwright install` — bundled Chromium is
 * visibly not Chrome):
 *
 *   npm install playwright
 *
 * Run with: npx tsx examples/browserLogin.ts
 */

import 'dotenv/config';
import { existsSync } from 'node:fs';
import { Client } from '../src/index.js';
import { browserLogin, importChromeCookies } from '../src/browser/index.js';

const COOKIES_FILE = process.env.TWITTER_COOKIES_FILE || 'cookies.json';

const client = new Client({ language: 'en-US' });

if (existsSync(COOKIES_FILE)) {
  // The whole point: after the first run, no browser is involved at all.
  await client.loadCookies(COOKIES_FILE);
  console.log('Loaded cached cookies.');
} else if (process.env.TWITTER_CHROME_CDP_PORT) {
  // Attach to a Chrome you started yourself and logged into, e.g.
  //   chrome --remote-debugging-port=9222 --user-data-dir=/tmp/x-profile
  // Note this cannot read the everyday Chrome profile: since Chrome 136 the
  // debugging port is refused for the default user-data directory.
  const { cookies } = await importChromeCookies({
    port: Number(process.env.TWITTER_CHROME_CDP_PORT),
    launch: false,
  });
  client.setCookies(cookies);
  await client.saveCookies(COOKIES_FILE);
  console.log('Imported the session from Chrome.');
} else {
  const { cookies, reusedSession } = await browserLogin({
    authInfo1: process.env.TWITTER_AUTH_INFO_1!,
    authInfo2: process.env.TWITTER_AUTH_INFO_2,
    password: process.env.TWITTER_PASSWORD!,
    totpSecret: process.env.TWITTER_TOTP_SECRET || undefined,
    proxy: process.env.TWITTER_PROXY || undefined,
  });
  client.setCookies(cookies);
  await client.saveCookies(COOKIES_FILE);
  console.log(reusedSession ? 'Reused the browser profile session.' : 'Logged in.');
}

const me = await client.user();
console.log(`Logged in as @${me.screenName} (${me.followersCount} followers)`);
