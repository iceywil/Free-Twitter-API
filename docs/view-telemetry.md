# How X logs a tweet "view"

Notes from capturing real, logged-in browser sessions opening a tweet permalink
and recording every request the page makes — including the ones shipped through
`sendBeacon`, which the plain network log misses. Reproduce with:

```sh
npx tsx scripts/dbg-view-capture.ts [session.json] [tweet-url] [out.json]
```

It loads a saved session into real Chrome, opens the tweet, dwells ~30s, forces a
visibility flush, and writes every in-page `fetch`/`XHR`/`sendBeacon` call (URL +
decoded body) to `scripts/.view-capture.json` (gitignored — the capture describes
a live session's activity).

## The headline finding

The web client no longer uses `jot/client_event.json`. All client telemetry —
impressions included — is POSTed to an endpoint that otherwise means "login":

```
POST https://x.com/i/api/1.1/flow/timeline.json
Content-Type: application/x-www-form-urlencoded

debug=true&log=<url-encoded JSON array of client_event objects>
```

Because the discriminator (`_category_: "client_event"`) lives in the **body**,
not the URL, filtering request URLs for `client_event`/`jot`/`scribe` finds
nothing. You have to decode the `log` array. There is **no dedicated
"register view" endpoint** — a view is one `client_event` among many in this
batched channel.

Constants seen on the web client: `client_app_id: "3033300"`, and
`event_namespace.client: "m5"`.

## The event that is the view

Opening one tweet permalink fires ~70 client events. The one that models the
public "views" counter is the **impression linger** event:

```json
{
  "_category_": "client_event",
  "format_version": 2,
  "triggered_on": 1790271056200,
  "items": [{
    "item_type": 0,
    "id": "<tweet_id>",
    "position": 0,
    "sort_index": "<snowflake>",
    "impression_details": {
      "visibility_start": 1790271020134,
      "visibility_end":   1790271056200
    },
    "first_impression": true,
    "author_id": "<author_id>",
    "engagement_metrics": { "reply_count": 0, "retweet_count": 0,
                            "favorite_count": 0, "quote_count": 0,
                            "view_count": 77 }
  }],
  "event_namespace": {
    "page": "tweet", "component": "stream",
    "element": "linger", "action": "results", "client": "m5"
  },
  "client_event_sequence_start_timestamp": 1790271018961,
  "client_event_sequence_number": 49,
  "client_app_id": "3033300"
}
```

The signal is `impression_details` — a **visibility window** (`visibility_start`
→ `visibility_end`, here ~36 s on screen) plus `first_impression: true`. The
backend aggregates these into the public view number; the dwell window is what
lets it weight or discard an impression. `engagement_metrics.view_count` in the
payload is the count the client *already read* from the tweet fetch, echoed back
— not a value the client sets.

### Every scribe carries the page-session clock

Every `client_event` the real client emits — not just the impression — carries
`client_event_sequence_start_timestamp` (fixed for the life of the page) and
`client_event_sequence_number` (counting up from `0` at page load, and resetting
to `0` on a client-side navigation). The endpoint accepts a batch without them,
but a real client never sends one.

### `stream/top/show` is not the impression

It is tempting to read `tweet//stream/top/show` as "the tweet entered the
viewport". It is not: in every capture it arrives with **`items: []`** and no
tweet id. It means "this stream is scrolled to its top", and it can fire several
times per page.

The per-tweet "this rendered" scribe is instead `tweet////show` — page `tweet`,
**no** component or element — which repeats the id in a top-level `tweet_id`
field beside a bare `items: [{ item_type: 0, id }]`:

```json
{
  "_category_": "client_event", "format_version": 2,
  "triggered_on": 1790271019208,
  "tweet_id": "<tweet_id>",
  "items": [{ "item_type": 0, "id": "<tweet_id>" }],
  "event_namespace": { "page": "tweet", "action": "show", "client": "m5" },
  "client_event_sequence_start_timestamp": 1790271018961,
  "client_event_sequence_number": 3,
  "client_app_id": "3033300"
}
```

That top-level `tweet_id` appears on every tweet-scoped scribe (`get_initial`,
`bottom`, `scroll`, all the video-player events) — but *not* on the `linger`
impression or on `stream/top/show`.

## The full event taxonomy for one permalink open

`page/section/component/element/action`, in fire order:

| when | namespace | meaning |
| --- | --- | --- |
| load | `app////partner_id_sync` | ad-partner id sync |
| load | `app//theme/.../launch`, `app//breakpoint/.../launch` | client boot state |
| load | **`tweet////show`** | **the focal tweet rendered** |
| load | `tweet////get_initial` | the conversation was fetched |
| load | `tweet//stream//results` | stream contents delivered |
| load | `tweet//stream/top/show` | stream is scrolled to its top (`items: []`) |
| load | `tweet////bottom` | reached bottom of the focal tweet |
| load | `tweet/sidebar/...` | trends/events in the right rail |
| scroll | `tweet////scroll` | scroll, with `event_value` (delta) |
| ~30 s | **`tweet//stream/linger/results`** | **impression + visibility window (the view)** |
| — | `ddg/.../experiment` | experiment bucket exposure |

A conversation page also emits one `tweet//tweet//impression` per reply on
screen, and a second `stream/linger/results` batch per visibility flush — the
replies' impressions ride the same event as the focal tweet's, distinguished by
`position` and `in_reply_to_tweet_id`.

For a **video** tweet the player adds its own lifecycle, under component
`tweet` (**not** `stream`), following the MRC (Media Rating Council) viewability
model. Observed, in order:

| namespace (`tweet//tweet/video_player/…`) | meaning |
| --- | --- |
| `intent_to_play`, `mute` | player set up |
| `play`, `playback_start` | autoplay started, first frame |
| **`video_mrc_view`** | **MRC-countable video view** |
| `view_threshold`, `video_view` | view thresholds crossed |
| `video_6sec_view`, `video_quality_view` | billable-view variants |
| `heartbeat` | periodic (every ~5 s) keep-alive |
| `playback_25` / `_50` / `_75` / `_95` / `playback_complete` | progress milestones |
| `video_short_form_complete`, `loop` | short-form finished, looped |
| `playback_lapse` | playback stopped/left |

Separately, `tweet//media_entity/unknown/video_resolution_<N>p` reports the
rendition picked.

### The video events carry `client_media_event`, not `impression_details`

A video-player scribe never uses `impression_details`. Its viewability proof is
a `client_media_event` blob naming the event type, the player session and the
media:

```json
"client_media_event": {
  "media_client_event_type": { "video_mrc_view": {} },
  "session_state": {
    "session_id": "<uuid, also sent as media_session_id>",
    "content_video_identifier": {
      "media_platform_identifier": { "media_category": 13, "media_id": "<media id>" }
    },
    "tweet_id": "<tweet id>"
  },
  "playing_media_state": { "video_type": 2, "media_asset_url": "<m3u8>", "...": "..." },
  "player_state": { "is_muted": true }
}
```

alongside `media_session_id`, `video_uuid`, `content_id`, `publisher_id`,
`video_type` and `video_visibility: 100` on the item. Reproducing a *credible*
video view therefore needs the media ids from the tweet fetch and a synthesized
player session — which is why `Client.viewTweet({ video: true })` sends the
`video_mrc_view` namespace as a marker only. It is not needed: the `linger`
impression alone moves the counter (measured below).

## Transport details

- **Batching.** Events queue and flush on a timer (~3 s cadence observed) and on
  visibility/page-hide. Do not expect an event the instant it triggers.
- **`sendBeacon`.** Flush-on-unload uses `navigator.sendBeacon`; error logs go to
  `app_context.json?keepalive=true`. Instrument these in-page (see the capture
  script) or they are easy to miss. Log bodies generously — a scribe batch on a
  video tweet runs well past 8 KB, and truncating it silently drops events.
- **Other channels seen, for contrast:**
  - `graphql/viewer_context.json` with `category=perftown` — performance timings
    (`rweb:ttft:*`, `rweb:ttfl:*`), not engagement.
  - `graphql/app_context.json?keepalive=true` — client error reporting.

## What the endpoint actually validates

Probed field-by-field against a live session, one event per POST. The endpoint
checks only the envelope:

| removed from a known-good event | result |
| --- | --- |
| `_category_` | **400** |
| `format_version` | **400** |
| `event_namespace` | **400** |
| `triggered_on`, `client_app_id`, `items`, the sequence fields | 200 |
| `event_namespace.action`, `event_namespace.client` | 200 |
| *empty batch* (`log=[]`) | **400** |
| a nonsense `action` or `page` | 200 |

So **a `200` proves only that the batch was well-formed** — not that the view
was counted. The only way to confirm counting is to watch `views.count` on the
tweet move.

**The route is rate-limited hard, per account, and it looks like a dead
endpoint.** A session lands roughly *one* scribe POST and then answers
`404 {"errors":[{"message":"Sorry, that page does not exist","code":34}]}` —
not `429` — for a long cooldown. Observed: a session returning `200`, then
`404` on the very next request three seconds later; and three sessions blocked
for 20+ minutes straight, 18 attempts at 60 s intervals, none getting through.
Retrying in a loop does not help and appears to extend the block. A real
browser is not limited this way, because its scribes belong to a genuine page
session.

This matters when measuring: a run whose POSTs all `404` transmits nothing, so
its "no effect" result is void rather than negative. Confirm each POST returned
`200` before believing a measurement.

## Does sending the scribe actually add a view?

**No — not from the API.** Measured against a live counter, with a real browser
visit as the positive control. One tweet, six sessions split into two disjoint
groups so per-(viewer, tweet) dedupe cannot mask either arm; two untouched
control tweets read at every point:

| phase | who | target | controls |
| --- | --- | --- | --- |
| baseline, 10 min | nobody | 55 → 55 | flat |
| `viewTweet()` over the API, 3 sessions, all `200` | this library | **55 → 55 (+0)** | flat |
| real Chrome, 3 sessions, 33 s dwell | the web client | **55 → 58 (+3)** | flat |

The real browser scores **exactly one view per session**, visible within
minutes. The API path, same sessions, same tweet, confirmed `200`s, scores
**zero**. So the counter is responsive, dedupe is not interfering, and there is
no aggregation-lag excuse — the scribe this library sends is simply not counted.

Variants tried, all `+0` with controls flat and every POST confirmed `200`:

- the original payload (`stream/top/show` carrying the item, no sequence fields)
- the corrected payload above, matching the capture field for field
- `Referer` set to the tweet permalink rather than `https://x.com/`

Earlier, uncontrolled runs suggested a large positive effect (+19 from 6
sessions). That did not survive a control tweet: it was organic traffic on an
actively promoted account. Treat any measurement without a simultaneous control
on a comparable tweet as worthless — view counts drift several per minute on
anything with an audience.

Also tried, and also `+0` with every POST confirmed `200` and controls flat:
fetching `TweetDetail` from the sending session first and echoing back the
server-issued `sortIndex` for the entry it was served (the real `sort_index` is
*not* the tweet id — it is a token minted at page load), sent alongside a
`get_initial` scribe and the permalink referer. The target sat unchanged for
over two hours.

At that point the payload has been reproduced field for field and still is not
counted, so the backend is validating something a bare POST cannot manufacture.
The rate limiting says the same thing from the other side: a Node session lands
about one scribe POST before the route blocks it for tens of minutes, while a
real browser sends dozens without complaint.

## What this library does instead

`Client.viewTweet()` drives a real browser: it opens the permalink, lets the
tweet sit on screen, and navigates away so the client flushes its own
impression. `Client.viewTweets()` shares one browser across a list. Both need
the optional `playwright` dependency, and both genuinely wait out the dwell
window — a view costs ~30 s of wall clock, which is the price of the only
method that works.

`Client.clientEvent()` remains as the raw escape hatch for sending scribes, for
telemetry this library does not model. Do not expect impressions sent that way
to be counted.

## Reading a view count

The view count is a field on the tweet fetch — no telemetry involved:

```
GET graphql/<id>/TweetResultByRestId   →   result.views.count
GET graphql/<id>/TweetDetail           →   (same, within the conversation)
```

On the captured tweet this read `77`, matching the `engagement_metrics.view_count`
echoed in the scribe above.
