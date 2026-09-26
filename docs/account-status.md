# Suspension: detecting it, and appealing it

## Detecting a suspension

There are **two** kinds, and they look different:

| | public profile | `user_state.json` |
| --- | --- | --- |
| full suspension | tombstoned (`UserUnavailable` / `Suspended`) | `suspended` |
| read-only / limited | still visible, looks ordinary | `suspended` |

So no single check covers both, and which one you want depends on whose account
you are asking about.

### Your own account — `isOwnAccountSuspended()`

Use this for "am I suspended?". It reads the help-center endpoint the web
client itself calls:

```
GET https://api.x.com/help-center/forms/api/prod/user_state.json
  -> {"userState":"normal"}  |  {"userState":"suspended"}
```

`Client.getOwnAccountState()` returns the raw value plus a boolean.

Measured across seven sessions, this was the only check that matched reality
for all of them — including one account reported `suspended` here whose profile
was still publicly visible, i.e. a read-only suspension that the public lookup
called healthy.

A suspended session also sees it in other places: a `403` with
`code: 64, "Your account is suspended and is not permitted to access this
feature"`, a `suspended-prompt` entry in the home timeline, and the banner
"Your account is suspended … permanently in read-only mode" on x.com. But
`user_state.json` is the cheap, unambiguous one.

Note what a suspended session can still do: `Viewer`, `settings.json` (still
reporting the right `screen_name`), the home timeline and a lookup of its own
handle all keep answering normally. Do not read those working as evidence of
health.

### Somebody else's account — `isSuspended(handle)`

A fully suspended account answers the profile lookup with a tombstone:

```json
{"data":{"user":{"result":{
  "__typename": "UserUnavailable",
  "message": "User is suspended",
  "reason": "Suspended"
}}}}
```

`Client.getAccountStatus()` returns that as data. `reason` is what matters:
`UserUnavailable` also covers protected and withheld accounts, which are not
suspensions.

Two limits worth knowing:

- **It misses read-only suspensions**, whose profiles stay public.
- **It cannot be pointed at yourself.** A session looking up its own handle
  gets an ordinary `User` back even while suspended. Guest (logged-out) lookups
  are refused with `403`. Ask from a different session, or use
  `isOwnAccountSuspended()`.

## Appealing

`Client.appealAccount({ text, email })` files
https://help.x.com/en/forms/account-access/appeals — fully automated, no
interaction. `screenName` defaults to the session's own handle, which
`settings.json` still reports while suspended.

### Why it drives a browser

The form itself is trivial: an AEM/Salesforce form whose fields are

| field | |
| --- | --- |
| `Screen_Name__c` | the handle |
| `Form_Email__c` | contact email |
| `DescriptionText` | the appeal text |
| `_FormPath`, `Subject`, `Source_Form__c`, `Type_of_Issue__c`, `Category__c` | hidden, fixed |

What cannot be reproduced from Node is the gate in front of it. The page loads
`challenges.cloudflare.com/turnstile/v0/api.js`, and the submit path takes
`challengeConfig` / `arkoseConfig` / `turnstile`, throwing
`"Turnstile runner is missing"` without it. Submission needs a Cloudflare
Turnstile token, which is minted by a browser environment by design — a bare
`fetch()` has nothing valid to send. The submit hook is `htc-servicedesk`; the
only `help-center/forms/api` routes the client exposes are `user_state`,
`masked_email`, `email_state` and `vo-enrolled`, none of which take a
submission.

Callers who mint a token through their own service can pass `turnstileToken`
and skip that part.

### The challenge runs on submit, not on load

The widget is rendered `explicit` and executed by the submit handler
(`reset(id); execute(id)`), so **no token exists before the button is clicked**.
There is nothing to verify up front, which is why `dryRun` always reports
`challengePassed: false`: it proves the form rendered and the fields took their
values, and stops. Exercising the challenge means actually filing an appeal.

### Headless

The form renders and fills headless — verified over repeated runs — but it
intermittently refuses a browser outright with "This browser no longer supports
this form". When that happens and `headless` was not set explicitly,
`appealAccount` retries headed once; a run that never rendered never submitted,
so the retry is safe.
