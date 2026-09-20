# Free-Twitter-API

Free Twitter API for Twitter in Typescript. It speaks the same internal GraphQL
and v1.1 endpoints the web app does — no developer account, no API key. Once you
have a session, everything runs as plain HTTP from Node; obtaining that session
uses a real browser only to mint x.com's device token (see
[Login](#login)).

> **Legal / ToS note.** This uses private endpoints, against X's Terms of
> Service. Automating an account risks suspension. Use a throwaway account, keep
> request volume low, and don't rely on it for anything you can't afford to lose.

## Highlights

- No API key — the whole API runs as plain HTTP from Node once authenticated
- Three login strategies (`auto` / `hybrid` / `browser`), including 2FA/TOTP —
  the browser is used only to mint the Castle device token, then Node takes over
- Import a ready session from an exported cookie jar or a bulk-account record
  (`parseAccountRecord`) — no login flow at all
- Self-healing `x-client-transaction-id`
- Search, home and user timelines, tweet detail with replies, trends
- Guest client for read-only use with no account
- Post, delete, poll, chunked media upload, like, retweet, bookmark, follow, DM
- Full profile management — name, bio, location, URL, avatar, banner, @handle
- Cursor-based pagination on every listing
- Strict TypeScript, ESM + CJS, complete type declarations

## Install

```bash
npm install git+https://github.com/iceywil/Free-Twitter-API.git#v1.0.0
```

Node 20+. The package builds itself on install (`prepare`).

From source:

```bash
npm install && npm run build && npm test
```

## Quick start

```ts
import { Client } from 'free-twitter-api';

const client = new Client({ language: 'en-US' });

await client.login({
  authInfo1: 'your_username',
  authInfo2: 'your_email@example.com',
  password: 'your_password',
  cookiesFile: 'cookies.json', // reused on later runs, skipping the login flow
});

const me = await client.user();
console.log(`@${me.screenName}`);

const tweets = await client.searchTweet('typescript', 'Latest', 20);
for (const tweet of tweets) {
  console.log(tweet.user?.screenName, tweet.text);
}

const nextPage = await tweets.next();
```

### No account at all

The guest client reads public data using a guest token:

```ts
import { GuestClient } from 'free-twitter-api';

const client = new GuestClient();
await client.activate();

const user = await client.getUserByScreenName('jack');
const tweets = await client.getUserTweets(user.id);
```

### Posting, media, polls

```ts
const mediaIds = [
  await client.uploadMedia('image.png'),
  await client.uploadMedia('video.mp4', { waitForCompletion: true }),
];
await client.createTweet('Hello', { mediaIds });

const pollUri = await client.createPoll(['Red', 'Blue'], 60);
await client.createTweet('Pick one', { pollUri });
```

### Real-time streaming

```ts
import { Topic } from 'free-twitter-api';

const session = await client.getStreamingSession(
  new Set([Topic.tweetEngagement('1519480761749016577')])
);

for await (const [topic, payload] of session) {
  console.log(topic, payload.tweetEngagement?.likeCount);
}
```

### Pagination

Every paginated method returns a `Result<T>`, which **is** an array (index it, spread it, `for...of` it, `.map()` it) and additionally knows how to fetch adjacent pages:

```ts
const followers = await client.getUserFollowers(userId);
console.log(followers.length, followers[0].screenName);

const page2 = await followers.next();
const back = await page2.previous();
```

## Login

```ts
const client = new Client({ loginTimezone: 'Europe/Paris' });
await client.login({
  authInfo1: 'username',        // or email / phone
  password: 'password',
  totpSecret: 'BASE32SECRET',   // optional, for 2FA (authenticator app)
  cookiesFile: 'cookies.json',  // reused on later runs to skip login entirely
});
```

`login()` defaults to `strategy: 'auto'`, which mints x.com's Castle device
token in a real (headless) browser and then runs every request — `begin_login`,
`login_enter_password`, the 2FA challenge — natively from Node. A cached
`cookiesFile` skips the whole thing. See
[When login gets blocked](#when-login-gets-blocked) for the strategy details.

### Importing a ready session

The cheapest path is not to log in at all. If you already have a session — an
exported cookie jar, or a bulk-account record — load it directly:

```ts
import { Client, parseAccountRecord, accountSessionCookies } from 'free-twitter-api';

// From a saved cookie file:
await client.loadCookies('cookies.json');    // { "auth_token": "...", "ct0": "..." }

// Or from a provider record — username:password:totp:email:emailpw:authToken:base64(cookies)
const rec = parseAccountRecord(line);
const session = accountSessionCookies(rec);   // pulls auth_token/ct0/guest_id/twid/gt
if (session) {
  client.setCookies(session);                 // ready — no login, no 2FA, no browser
} else {
  await client.login({ authInfo1: rec.username, password: rec.password, totpSecret: rec.totpSecret });
}
```

`accountSessionCookies` deliberately drops `cf_clearance` from the imported jar:
it is bound to the exporting browser's TLS fingerprint and would make Cloudflare
reject requests coming from your machine.

### When login gets blocked

x.com scores the *device*, not just the credentials, through the Castle.io SDK.
A fully browserless login from Node is therefore usually refused: the device
token it mints in a sandbox is judged weaker than a real browser's.

`client.login({ strategy })` chooses how hard to try:

```ts
await client.login({
  authInfo1: 'username',
  password: 'password',
  strategy: 'auto',   // hybrid → browser, first that works (default)
});
```

- `'auto'` (default) — runs `hybrid`, then falls back to `browser`. It does not
  attempt `native`, which x.com reliably refuses. `playwright` is loaded only
  when login actually runs (a cached `cookiesFile` skips it entirely).
- `'hybrid'` — a headless browser mints only the Castle token; every request of
  the login and all API traffic afterwards run natively from Node. The browser
  is reduced to a few seconds of token-minting. The lightest path that works.
  Needs `playwright`.
- `'browser'` — drives the whole login form in a real browser (most proven).
- `'native'` — no browser at all. Currently refused by x.com: the token minted
  in Node carries fewer device signals than a real browser's. Kept for
  experimentation; see [docs/native-login.md](docs/native-login.md).

For a one-time cookie grab you can also call `browserLogin()` directly through
the `free-twitter-api/browser` entry point; you only need it once, after which
the plain `Client` runs from Node.

Log in once through a hardened browser:

```ts
import { browserLogin } from 'free-twitter-api/browser';

const { cookies, reusedSession } = await browserLogin({
  authInfo1: 'username',
  password: 'password',
  totpSecret: 'BASE32SECRET',   // optional
});
```

This needs `npm install playwright`, but **not** `npx playwright install` — it
drives the Google Chrome already on the machine, because bundled Chromium is
visibly not Chrome (its WebGL vendor, `userAgentData` brands and plugin set all
differ). It keeps a persistent profile at `~/.free-twitter-api/chrome-profile`,
so repeat runs look like a returning device rather than a new one each time —
and usually skip the form entirely (`reusedSession: true`). It runs headed by
default; headless Chrome is detectable as such.

`scripts/dbg-stealth.ts` prints the fingerprint the browser actually presents,
if you want to check what a given configuration leaks.

#### Importing a session from a Chrome you control

`importChromeCookies()` attaches to a running Chrome over the DevTools protocol
and reads its x.com cookies, letting Chrome decrypt its own cookie store so that
neither the encrypted database nor your OS keychain is touched.

It cannot read your **everyday** Chrome profile. Since Chrome 136, Chrome
refuses `--remote-debugging-port` whenever the profile is the default one —
specifically to stop this class of cookie extraction. It therefore only works
against a separate profile you started yourself:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --user-data-dir=/tmp/x-profile
```

Log into x.com in that window, then:

```ts
import { importChromeCookies } from 'free-twitter-api/browser';

const { cookies } = await importChromeCookies({ port: 9222, launch: false });
```

For most purposes `browserLogin()` above is simpler — it manages exactly such a
profile for you.

## Known limitations

- **"We've temporarily limited your login" is not a rate limit.** Despite the
  wording, it is x.com's refusal for a client that fails device assessment. A
  headed browser logs in successfully seconds after a headless one is refused
  from the same IP and account, so waiting does not help — the client has to
  change. See [docs/native-login.md](docs/native-login.md).
- **Headless needs its own corrections, which `browserLogin()` applies.** Plain
  headless Chrome is refused at login: it reports `HeadlessChrome` in the user
  agent while its own `sec-ch-ua` hints say `Google Chrome`, and it loses the
  Retina scale factor and real screen size. `headless: true` fixes all three and
  logs in from a cold start. Default is still headed, being the better-tested
  path. See [docs/native-login.md](docs/native-login.md).
- **`getTrends()` ignores `category` when it falls back.** v1.1 `guide.json` now
  answers with a cursor-only payload, so trends come from the GraphQL Explore
  endpoints, which take no category — `trending`, `news`, `sports` and
  `entertainment` return the same list. `guide.json` is still tried first.

## Configuration

```ts
new Client({
  language: 'en-US',
  proxy: 'http://user:pass@host:port',   // http, https and socks are supported
  userAgent: '...',
  timeout: 60_000,
  captchaSolver: new Capsolver({ apiKey: '...' }),
  prompt: async (message) => '123456',   // supply 2FA / email codes non-interactively
  requireTransactionId: false,
  silent: false,
});
```

Locked accounts can be unlocked automatically with [Capsolver](https://capsolver.com):

```ts
import { Capsolver, Client } from 'free-twitter-api';

const client = new Client({
  captchaSolver: new Capsolver({ apiKey: process.env.CAPSOLVER_API_KEY!, maxAttempts: 10 }),
});
```

## What's covered

- **Auth** — login (with 2FA/TOTP, email confirmation, Arkose unlock), logout, cookie save/load, delegate accounts
- **Tweets** — create (incl. long-form note tweets, polls, media, community, reply-control, edits), schedule, delete, fetch by id(s), replies and threads, like, retweet, bookmark, similar tweets, community notes
- **Timelines** — For You, Following, user tweets/replies/media/likes, highlights
- **Users** — by id or handle, follow, block, mute, followers, following, verified followers, followers-you-know, subscriptions, follower/friend id lists
- **Profile** — edit name, bio, location and URL (`updateProfile`), set profile picture (`updateProfileImage`) and banner (`updateProfileBanner` / `removeProfileBanner`), change @handle (`updateScreenName`)
- **Search** — tweets, users, lists, communities, community tweets, plus a typed `buildQuery` helper for X's search operators
- **DMs** — send, reply, delete, reactions, history, group DMs, group management
- **Lists** — create, edit, banner, members, subscribers, tweets
- **Communities** — search, join/leave/request, members, moderators, tweets, timeline
- **Bookmarks** — add, remove, folders, delete-all
- **Media** — chunked upload (parallel segments), status polling, metadata/alt text, download, video streams, HLS playlists, WebVTT subtitles
- **Trends** — trending/for-you/news/sports/entertainment, locations, per-place trends
- **Notifications** — all, verified, mentions
- **Streaming** — live sessions, subscription updates, auto-reconnect

## Examples

Runnable scripts in [`examples/`](./examples): `basic.ts`, `guest.ts`, `postTweet.ts`, `streaming.ts`.

```bash
npx tsx examples/basic.ts
```

They read `TWITTER_AUTH_INFO_1`, `TWITTER_PASSWORD` and optionally
`TWITTER_TOTP_SECRET` from the environment.

## Testing

```bash
npm test                    # unit tests, no network
npx tsx scripts/smoke.ts    # live check; runs the guest half with no credentials
```

Unit tests cover the parts most likely to drift: transaction-id maths, the
search-query builder, `Result` pagination, model field mapping, and the
hand-written m3u8 / WebVTT / media-type / ui_metrics parsers.

## License

MIT — see [LICENSE](./LICENSE).
