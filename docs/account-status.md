# Suspension: detecting it, and appealing it

## Detecting a suspension

A suspended account answers the profile lookup with a tombstone instead of a
user:

```json
{"data":{"user":{"result":{
  "__typename": "UserUnavailable",
  "message": "User is suspended",
  "reason": "Suspended"
}}}}
```

`Client.getAccountStatus()` returns that as data and `Client.isSuspended()` as a
boolean. `reason` is the field that matters: `UserUnavailable` also covers
protected and withheld accounts, which are not suspensions.

### A suspended session cannot see this about itself

This is the part that surprises. Checked against a genuinely suspended account,
from its own cookies:

| what | what it says |
| --- | --- |
| `graphql/Viewer` | normal payload, no suspension anywhere |
| `1.1/account/settings.json` | normal, still reports the right `screen_name` |
| `UserByScreenName` on **its own** handle | an ordinary `User` |
| the home timeline | loads, returns tweets |
| `help-center/forms/api/prod/user_state.json` | `{"userState":"suspended"}` — **but it says that for healthy accounts too**, so it is not a signal |

Meanwhile the same handle, looked up from *another* logged-in session, returns
`UserUnavailable` / `Suspended` immediately. Guest (logged-out) lookups are
refused with `403`.

So an account cannot self-diagnose over the API. To check one of yours, ask
from a different session:

```ts
const checker = new Client();
await checker.loadCookies('some-other-account.json');
await checker.isSuspended('the_suspended_handle');   // true
```

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
