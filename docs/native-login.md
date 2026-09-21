# Replicating the login natively

Notes from capturing a real browser login and diffing it against what
`NativeLoginFlow` sends. Reproduce with:

```sh
npx tsx scripts/dbg-login-capture.ts   # records a cold-start browser login
npx tsx scripts/dbg-native-diff.ts     # diffs native vs captured, costs no login
```

The capture lands in `scripts/.login-capture/` (gitignored — it holds a live
session and a Castle device token).

## What is established

### "We've temporarily limited your login" is not a rate limit

It reads like one, but it is x.com's generic refusal for a client that fails
device assessment. Three cold-start runs, same IP, same account, same few
minutes, each from an empty profile:

| # | mode | result |
| --- | --- | --- |
| 1 | headed | **SUCCESS** → `https://x.com/home` |
| 2 | headless | `We've temporarily limited your login. Please try again later.` |
| 3 | headed (control) | **SUCCESS** → `https://x.com/home` |

Run 3 succeeded immediately after run 2 was refused. A per-IP, time-based limit
cannot behave that way, so the message reflects a judgement about the *client*,
not a counter. Two consequences:

- Waiting it out does nothing. Change the client instead.
- The native flow receives this same message, so it is not queued behind a
  limit either — it is being judged and rejected, exactly as headless is.

Always keep a headed control in any experiment that reaches this endpoint:
without one, a refusal is indistinguishable from a limit, and it is easy to
attribute a detection to the wrong cause.

### Headless was detected, and now is not

Run 2 above used Chrome's new headless mode with everything else held constant,
and was refused. Diffing the two fingerprints (`dbg-headless-diff.ts`) found
only **eight** differing signals — and none of them were the CDP-level leaks
the stealth frameworks exist to patch. `navigator.webdriver`, WebGL vendor and
renderer, the canvas hash, the audio hash, plugins, mimeTypes and codecs were
already identical; headless even drives the real GPU.

Three corrections closed it, all in `headlessOverrides`:

| signal | before | after |
| --- | --- | --- |
| `navigator.userAgent` | `HeadlessChrome/153` | `Chrome/153` |
| `devicePixelRatio` | 1 | 2 |
| `screen` | collapsed onto the viewport | `1728x1117`, window smaller |

The user agent was the important one, and it was self-contradictory: Chrome's
own `sec-ch-ua` hints still report `"Google Chrome"` in headless, so the UA
disagreed with the hints sent alongside it. Correcting it removes an
inconsistency rather than introducing a lie — which is why the version is read
from the installed binary instead of hardcoded, so the two cannot drift apart.

With those, a cold-start headless login succeeds:

```
mode: HEADLESS
cookies before anything: 0
LOGIN FROM COLD START: SUCCESS  ->  https://x.com/home
```

Four cosmetic differences remain and are evidently not judged: font fallback
picks Menlo over Monaco, `screen.availHeight` does not reserve the macOS menu
bar, `outerHeight` omits window chrome, and `colorDepth` reads 24 against the
headed 30. `colorDepth` is deliberately not patched — 24 is the commonest value
in the world, so it is unremarkable on its own, and a patched getter is itself
detectable.

Reproduce with `npx tsx scripts/dbg-login-capture.ts --headless`, and re-measure
the gap any time with `npx tsx scripts/dbg-headless-diff.ts`.

### What this says about the stealth frameworks

`rebrowser-patches` and `patchright` fix CDP leaks (`Runtime.enable`, the main
world execution context). Those leak identically in headed mode, and headed was
never refused — so they address a problem this setup does not have.
`puppeteer-extra-plugin-stealth` mostly patches `navigator.webdriver`,
`chrome.runtime`, plugins and the WebGL vendor, all of which are already correct
here because the browser is real Chrome rather than bundled Chromium. Measuring
the gap and closing the three signals that actually differed was both smaller
and more durable than adopting a patch set aimed elsewhere.

## The full sequence a browser performs

```
GET  x.com/i/flow/login
GET  abs.twimg.com/responsive-web/client-web/ondemand.castle.<hash>.js
GET  x.com/i/jfapi/onboarding/web/landing
GET  x.com/i/jfapi/onboarding/web/remotes/passkey_one_fa?form_id=landing
GET  x.com/i/jfapi/onboarding/web?mode=login
GET  x.com/i/jfapi/onboarding/web/remotes/passkey_one_fa
POST x.com/i/jfapi/onboarding/web/actions/begin_login
POST x.com/i/jfapi/onboarding/web/actions/login_enter_password
```

`NativeLoginFlow` currently performs only the first, second and last two. The
four `landing` / `passkey_one_fa` / `web?mode=login` GETs are skipped. They are
also what lets the browser accumulate the cookies listed below before it ever
posts, so skipping them is not free.

## `begin_login` request

Headers the browser sends that the native flow does **not**:

| header | browser value |
| --- | --- |
| `accept-encoding` | `gzip, deflate, br, zstd` |
| `priority` | `u=1, i` |
| `sec-ch-ua` | `"Google Chrome";v="153", "Not_A Brand";v="8", "Chromium";v="153"` |
| `sec-ch-ua-mobile` | `?0` |
| `sec-ch-ua-platform` | `"macOS"` |
| `sec-fetch-dest` | `empty` |
| `sec-fetch-mode` | `cors` |
| `sec-fetch-site` | `same-origin` |

Everything else matches: `accept`, `accept-language: en`, `authorization`,
`content-type`, `origin`, `referer`, `timezone`, `user-agent`,
`x-client-transaction-id`, `x-guest-token`, `x-jf-client-theme`,
`x-jf-v: JP-5`, `x-twitter-active-user`, `x-twitter-client-language`.

The client-hint (`sec-ch-ua*`) values must agree with the `user-agent`. Sending
Chrome 153 hints beside a Safari UA is worse than sending none, which is why
`DEFAULT_USER_AGENT` is now defined once in `constants.ts`.

### Cookies

```
browser sends : __cf_bm, __cuid, __cuid, cf_clearance, g_state, gt, guest_id
native has    : __cf_bm, ct0, guest_id
missing       : __cuid (x2), cf_clearance, g_state, gt
```

Two of these matter:

- **`cf_clearance`** — Cloudflare's proof that the client passed a challenge.
  Absent, the request looks like one that never cleared Cloudflare.
- **`__cuid`** — set by Castle itself, and paired with the token. Sending a
  Castle token with no matching `__cuid` is an obvious inconsistency. Two are
  set, on different scopes.

### Body

```
username_or_email = <username>
$castle_token     = <6033 chars>
```

## The Castle token gap

This is the most likely cause, and the hardest part.

```
browser token : 6033 chars
native  token : 3653 chars   (60.6%)
browser prefix: e8bl5yQW|JABKdG9tM0NiZEpzSW0zU2JmSnRzbTN
native  prefix: e8bl5yQW|JABKdG9tM0NiZEpzSW0zU2JmSnRzbXd
segments      : 2 in both (8-char prefix, then payload)
```

The structure is right — same framing, same 8-char prefix, same base64 header,
diverging around character 31. So `CastleSolver` produces a *well-formed* token.
It is simply carrying about 40% less data, i.e. the sandbox is not supplying
whole groups of signals the real SDK collects (canvas, WebGL, audio, fonts,
plugins, screen geometry, pointer and timing telemetry are the usual ones).

A token cannot be replayed — it is bound to the device signals that produced it
and to the request it accompanies. The native flow has to *generate* an
equivalent one. Closing the size gap is the concrete target; `scripts/.castle.js`
and `src/internal/castleSolver.ts` are where that work goes.

## Two parser bugs found and fixed

Both would have broken native login even against a perfect request.

1. **The apostrophe.** x.com writes `We've` with U+2019. `readableStrings` kept
   only printable ASCII, so the message split in two and `findError`'s pattern
   could never match — a plain rate limit surfaced as
   `begin_login did not return a session token`. Typographic quotes are now
   folded before extraction.

2. **The session token.** It is a UUID, but the wire format runs the field name
   into the value, so the printable run reads
   `session_token$59f6a1a9-3ff4-4d06-8e49-ff107e3cc7bc`. `findSessionToken`
   compared *whole* strings against a 36-character pattern, so it never matched
   even on a successful response. It now searches within strings and prefers the
   run labelled `session_token`.

Both are covered by `tests/nativeLogin.test.ts`.

## Strategy: native first, browser as fallback

`Client.login` takes a `strategy`:

```ts
await client.login({
  authInfo1: 'username',
  password: '...',
  strategy: 'hybrid',  // default
  headless: true,      // forwarded to the browser leg
});
```

- `'hybrid'` (default) — mint the Castle token in a real headless browser, run
  every HTTP request natively. `playwright` is imported dynamically, so a caller
  who loads a cached session never loads it, and it stays optional.
- `'auto'` — hybrid, then fall back to a full browser login for flows hybrid
  cannot drive; does not attempt the fully-native flow.
- `'native'` — never launch a browser; throw if refused (currently refused).
- `'browser'` — drive the whole login form in a real browser.

Verified end to end today:

```
[free-twitter-api] Native login was refused (We've temporarily limited your
login. Please try again later.) — falling back to a real browser.
AUTO STRATEGY OK — @<account>
```

On fallback the HTTP cookie jar is cleared first: the refused native attempt
leaves half-built guest state behind, and the browser has to start from a device
the server has not already judged.

## Closing the Castle gap: one negative result so far

The sandbox in `castleSolver.ts` was missing whole probe surfaces — `getContext`
returned `null`, so there was no canvas and no WebGL at all; there was no
AudioContext; `navigator.plugins` and `mimeTypes` were empty against a real
Chrome's five and two; and the device values contradicted the machine
(`hardwareConcurrency` 8 vs 12, `deviceMemory` 8 vs 32, screen 1512x982 vs
1728x1117).

All of that is now supplied from a **measured** profile —
`scripts/dbg-harvest-profile.ts` records the real browser's canvas data URL, 25
WebGL parameters, 39 extensions, audio fingerprint, plugin and mime lists, screen
and media-query answers into `src/internal/deviceProfile.ts`. Regenerate it on
whatever machine you run from; do not hand-edit, since the values have to keep
describing one plausible device.

**It barely moved the token:**

| | token | ratio |
| --- | --- | --- |
| before | 3653 | 60.6% |
| after | 3741 | 61.5% |

So the missing ~2,400 characters are *not* the canvas/WebGL/audio/plugin groups.
That rules out the obvious hypothesis and is worth knowing before anyone spends
more time enriching surfaces. The enrichment is kept regardless: those values
were previously absent or contradictory, which is its own risk.

### What the SDK actually probes

`scripts/dbg-castle-probes.ts` wraps `navigator`, `document`, `screen`,
`performance`, `location` and the global in recording proxies and logs every
read, flagging those the sandbox answered with nothing. That replaced the
guesswork, and the answer was not canvas or WebGL.

**Castle fingerprints which globals exist.** It probes dozens of constructors
and methods by name. Real Chrome 153 has all of the following; the sandbox had
none of them:

```
getComputedStyle  CSS  HTMLCanvasElement  HTMLMediaElement  OffscreenCanvas
RTCPeerConnection  visualViewport  GPUAdapter  GPUCanvasContext  SerialPort
scheduler  PressureObserver  PerformanceLongAnimationFrameTiming  SharedWorker
ContentIndex  ContactsManager  NetworkInformation
performance.memory  screen.isExtended  navigator.gpu  navigator.bluetooth
navigator.setAppBadge  navigator.webkitTemporaryStorage
document.currentScript  document.scripts  document.styleSheets
document.wasDiscarded  document.onbeforematch  document.hasStorageAccess
document.caretPositionFromPoint  *.getClientRects
location.port  location.ancestorOrigins
```

Each absent name reads as a browser that cannot be Chrome, and together they are
the bulk of the missing payload — which is why adding canvas, WebGL and audio
moved it under 1%. These are presence markers: the SDK checks the name resolves
and sometimes reads `.name` or `.prototype`, but does not drive them.

**It also hunts for automation and for Node.** Observed probes include
`__playwright__binding__`, `__pwInitScripts`, `domAutomationController`,
`domAutomation`, `__nightmare`, `callPhantom`, `webdriver` — and
`process`, `Buffer`, `global`, `setImmediate`, `__dirname`, `spawn`, `emit`.
Castle explicitly fingerprints Node environments, so the sandbox must not leak
them; `buildSandbox` lists its globals explicitly rather than inheriting, which
is what keeps them out.

Equally, names Chrome does *not* have must stay absent — `safari`, `opr`,
`InstallTrigger`, `ietab`, `ethereum`, `navigator.brave`, `navigator.duckduckgo`,
`navigator.oscpu`, `navigator.buildID`, `screen.systemXDPI`. Claiming them would
swap a missing signal for a contradictory one.

Note one artifact when reading that script's output: its `has` trap returns
`true` for every `in` check so the SDK follows its browser paths, so the
"globals asked for" list records *what was probed*, not what the production
sandbox claims to have.

## Native vs browser, at the wire

The direct question: what does the native flow do differently from the browser
we captured? `scripts/dbg-wire-diff.ts` answers it by recording every native
request as it is sent and lining it up against the same request in the capture.
Three categories, and only one is genuinely hard.

### 1. Static request shape — replicable, and now replicated

Headers and the request sequence are just bytes; they were captured and simply
not applied. Now fixed in `nativeLogin.ts`:

- **Headers.** The client hints (`sec-ch-ua*`), `sec-fetch-*`, `priority` and
  `accept-encoding` were absent — no browser request ever is. Added, with the
  client-hint values derived from the user agent so they cannot disagree.
- **The warm-up GETs.** A browser fetches `landing`, `passkey_one_fa` (twice)
  and `web?mode=login` before it posts. `warmUp()` now walks them, so the
  session arrives the way a browser does instead of jumping to `begin_login`.
- **Timing.** The two POSTs are spaced by a human-length pause, matching the
  ~10s gap in the capture.

After this the wire diff is down to **one** header difference per request:
`accept-encoding` lists `zstd`, which we omit only because the HTTP layer does
not decode it. Everything else matches byte for byte.

### 2. Cookies the server hands out — mostly out of reach

At `begin_login` the browser carries `__cf_bm, __cuid, cf_clearance, g_state,
gt, guest_id`; native carries `__cf_bm, guest_id` (plus `gt`, now seeded). The
rest are set during the browser's page and script loads, not by us:

- **`gt`** — the guest token as a cookie. We hold the value, so it is now seeded.
- **`__cuid`** — set by the Castle SDK. In principle producible, since we run
  the SDK; not yet.
- **`g_state`** — Google one-tap state. Cosmetic.
- **`cf_clearance`** — Cloudflare's challenge clearance. This is the one that
  really wants a browser. **But it may not matter:** `begin_login` returns HTTP
  200, not a 403, so Cloudflare is not blocking the request at the edge — the
  refusal is Castle's device judgment at the application layer. A request
  lacking `cf_clearance` still reaches and is answered by x.com.

### 3. The Castle token — cannot be replayed, must be generated

This is the irreducible difference, and the reason "just replay what we
captured" does not work. The token is minted per request and bound to the
device signals gathered at that instant, so a captured one is dead on arrival.
Worse, it is not even static per session: the capture shows it growing 52 bytes
between the two POSTs, ten seconds apart, because the SDK keeps accumulating
behavioural telemetry (event timings, pointer paths, lifecycle) as the page
lives. A real browser runs that SDK for seconds against a real event loop; the
`node:vm` sandbox mints it cold and instantly.

This is why every static enrichment moved the token under 1% (and within
run-to-run noise): the gap is behavioural, not a matter of missing device
fields. Closing it means synthesising a plausible stream of timed events inside
the sandbox before minting — a materially larger and riskier task than answering
device probes, since a wrong timing distribution may read worse than less data.

## Suggested order of work

1. Add the missing `sec-ch-ua*`, `sec-fetch-*`, `priority` and `accept-encoding`
   headers. Cheap, and they are certainly fingerprinted.
2. Walk the four skipped GETs so `cf_clearance`, `gt`, `g_state` and `__cuid`
   are obtained the way a browser obtains them, rather than being synthesised.
3. Find where the token's missing 40% actually comes from. Enriching the
   obvious device surfaces gained under 1%, so the next move is to instrument
   the sandbox — wrap `navigator`, `document`, `screen` and the global in
   recording proxies and log every property the SDK reads, flagging the ones it
   asks for and does not get. `scripts/dbg-castle-probes.ts` does this;
   `castleSolver.__testing.buildSandbox` exists for it. Measure the size after
   each change with `dbg-native-diff.ts`, which posts nothing.

Since refusal is a judgement rather than a counter, there is no cooling-off
period to wait out — but each real attempt still exercises a live account, so
prefer `dbg-native-diff.ts` while iterating and keep a headed control run
alongside any experiment that does reach `begin_login`.

## Why black-box enrichment stalled: the token is encrypted

`scripts/dbg-token-decode.ts` decodes both tokens' payloads (`prefix|base64`)
and diffs their structure. The result ends the "enrich the sandbox until the
token matches" approach:

| | token chars | decoded bytes | printable runs | readable field names |
| --- | --- | --- | --- | --- |
| browser | 6085 | 4556 | 158 | 0 |
| native | 3665 | 2742 | 78 | 0 |

The decoded payload is opaque. String extraction yields only noise
(`,5'`, `qr&V`, `NAim`), the native bytes are not a subset of the browser's but
a different random set, and a nested base64 fragment decodes to yet another
layer of encoded bytes (`0x26xx` repeated). This is the signature of an
encrypted/obfuscated payload.

The consequence is what matters: **there is no field-level feedback signal.**
We can measure that the browser encodes ~1.66x more data, but not *what* the
extra ~1,800 bytes are. So enriching the sandbox and re-measuring only ever sees
gross byte count — which did not move with canvas, WebGL, audio, the full API
surface, or the device profile (all within run-to-run noise). We were adding
plausible signals blind and checking a number that cannot tell us whether they
landed.

Reaching parity would therefore require **deobfuscating the Castle SDK itself**
— reading its 685 KB of obfuscated collection code to learn what it gathers and
how it structures the payload, then reproducing that in the sandbox. That is a
large reverse-engineering project against a target that rotates its bundle hash,
not an incremental enrichment task.

## The hybrid path: browser mints the token, Node does everything else

The dead end above is only a dead end for minting the token *in Node*. It is not
a dead end for the login. The token turns out to be portable: a token minted in
a real browser is accepted by a native `begin_login` from Node.

`scripts/dbg-hybrid.ts` proved it — a 5,869-char token minted inside a headless
page (by pulling x.com's own Castle module out of the page's webpack runtime and
calling `createRequestToken`) was handed to a native HTTP `begin_login`, which
returned a session token with no error. So the token is a device attestation
that transfers, not a value bound to the browser's own request.

That gives a third strategy, `'hybrid'`, implemented in
`src/internal/castleOracle.ts` + `NativeLoginFlow`:

1. A headless browser loads the login page once and becomes a **token oracle** —
   it mints a fresh full-strength token on demand, and does nothing else.
2. Every HTTP request of the login (`begin_login`, `login_enter_password`, any
   2FA) goes out from Node, each carrying a freshly minted browser token.

Verified: the hybrid flow completes and returns `auth_token` from a native
`login_enter_password`. Two follow-on details it also handles:

- **`cf_clearance` must be dropped afterwards.** The oracle's `cf_clearance` is
  bound to the browser's TLS fingerprint; carried into Node's requests it earns
  a Cloudflare 403 on the first API call. Dropping the CF cookies after login
  (verified: the call then returns `@user`) lets the native client clear
  Cloudflare on its own.
- **`ct0` is synthesised when absent.** x.com sets the 160-hex CSRF token on the
  browser's password response but not reliably over this flow. Reads work
  without it; writes do not. The native flow now mints one (x.com's double-submit
  scheme accepts a client value when cookie and `x-csrf-token` match).

### What hybrid is and is not

It still needs a browser present — the token cannot be minted without one. So it
does not achieve "zero browser". What it achieves is a browser reduced to a
few seconds of page load and token minting, with the entire login and all
subsequent API traffic running natively from Node. Tokens can be minted ahead of
time or in batch. It is the lightest path that works end to end today.

Fully browserless login still requires closing the encrypted-token gap
(deobfuscating the SDK), which remains open.

## Bottom line

- **Static request shape** (headers, warm-up GETs, timing, `gt`): native and
  browser now differ by one cosmetic header (`accept-encoding: zstd`). Done.
- **Fully-native token** (`strategy: 'native'`): still refused — the sandbox
  token is encrypted, opaque and ~40% smaller, not closable by black-box means.
- **Hybrid** (`strategy: 'hybrid'`): browser mints the token, Node does the
  rest. Authenticates end to end. The lightest working path.
- **Browser** (`strategy: 'browser'`): the full-form fallback, most proven.

`strategy: 'hybrid'` is the default. `strategy: 'auto'` runs hybrid → browser
and stops at the first that works, for callers who want the full-browser
fallback. Both deliberately skip the fully-native step: x.com reliably refuses
the sandbox token, so attempting it first would spend a doomed request and erode
the IP's standing before every login. `strategy: 'native'` remains available for
anyone experimenting with the browserless path.

> Testing note: hitting `begin_login` / the API repeatedly from one IP earns a
> hard Cloudflare IP block (a "Sorry, you have been blocked" page, distinct from
> the device-assessment refusal). It is transient but real — throttle live login
> testing, and keep a headed control to tell the two apart.

## Can we replicate the token-minting itself? Measured, not guessed

The hybrid still needs a browser to mint the token. Closing that last gap means
making the `node:vm` sandbox produce a token x.com accepts. Until now the token
was opaque, so this was guesswork. It no longer is.

Hooking the serialisation inside the sandbox (`scripts/dbg-token-plaintext.ts`)
shows the token is assembled from per-signal tuples `[id, id*10, data, checksum]`
— each `id` is one collected signal. That is a **readable feedback channel**:
the signal-ID set can be diffed against a browser's (`scripts/dbg-browser-signals.ts`
hooks the same `JSON.stringify` inside a real page).

The diff:

| | token | signal tuples | distinct IDs |
| --- | --- | --- | --- |
| sandbox | 3665 | 90 | 87 |
| browser | 5869 | 382 | 101 |

Two concrete gaps, not a mystery:

1. **14 signal IDs the sandbox never emits**: `2,3,5,6,7,18,47,50,53,90,93,94,95,97`.
   Collectors that read something our environment cannot supply.
2. **~4x undersampling.** The browser emits each signal ~3.8 times, the sandbox
   ~once. The browser fired real events and completed real async over a page
   session; the sandbox mints cold.

What was ruled out by experiment:

- **"Mint later / repeatedly / after time"** does nothing — the sandbox token
  stays ~3665 across repeated calls and elapsed seconds
  (`scripts/dbg-token-time.ts`). It is not a timing problem.
- **Event-driven collection is real and helps a little.** The sandbox's
  `addEventListener` is a no-op that discards handlers, so the SDK's mouse /
  pointer / key / device-motion collectors never fire. Storing handlers and
  firing a realistic burst (`scripts/dbg-token-events.ts`) grew the token
  3665 → 3961 (+8%) — but unlocked none of the 14 missing IDs.

Also observed: the SDK registers a `__playwright_mark_target__` listener — it
carries **built-in Playwright detection**. The hybrid and browser paths pass
anyway (the stealth launch flags cover it today), but it is a moving target.

### Verdict on full-native

It is closeable in principle and now has a map — emit the 14 missing signals,
feed a continuous realistic event stream, keep every value mutually consistent —
but it is a high-fidelity browser-emulation effort against a dedicated anti-bot
SDK that updates and actively hunts automation, with an **unknown server
acceptance threshold** (we know 90 tuples is refused and 382 is accepted; not
where the line is, nor whether internal consistency is also checked). That is an
open-ended arms race.

The hybrid sidesteps all of it by minting the token where it is already correct —
a real browser — while keeping every HTTP request native. It is the recommended
path; full-native remains research with a now-well-characterised target.

## 2FA over the native/hybrid flow

The 2FA step was hardcoded to a non-existent action (`login_two_factor_auth_challenge`,
404). Captured live from a TOTP account (`scripts/dbg-2fa-chain.ts`), the real
chain is three actions, each naming the next in its response:

```
login_enter_password  -> next: begin_two_factor_auth
begin_two_factor_auth -> next: finish_two_factor_auth   (method: Totp)
finish_two_factor_auth-> auth_token
```

Two things the hardcoded version got wrong: the submit action is
`finish_two_factor_auth`, and the code field is **`challenge_response`** (not
`code`), sent with `two_factor_auth_method_type: Totp`. The flow now parses the
action names from each response (`actions()`), so it follows the chain rather
than guessing. Verified end to end: a full hybrid login on a TOTP account
returns `auth_token` + `ct0`.

The `"Verification is ready. Submission is suppressed in mock mode."` string in
those responses is a UI label in x.com's subtask config, not a block — the flow
completes past it.

## Account records and the fast path

Bulk-account providers ship a colon-delimited record:

```
username:password:totpSecret:email:emailPassword:authToken:base64(cookiesJson)
```

`parseAccountRecord()` reads it (detecting the optional fields by shape), and
`accountSessionCookies()` returns the live session from the embedded jar —
`auth_token`, `ct0`, `guest_id`, `twid`, `gt`, with the fingerprint-bound
`cf_clearance` dropped. When a record carries cookies, this is the reliable
path: no login, no 2FA, no token-minting.

```ts
import { Client, parseAccountRecord, accountSessionCookies } from 'free-twitter-api';

const rec = parseAccountRecord(line);
const client = new Client();
const session = accountSessionCookies(rec);
if (session) client.setCookies(session);          // ready session — no login
else await client.login({ authInfo1: rec.username, password: rec.password, totpSecret: rec.totpSecret });
```
