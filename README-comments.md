# Receipt comments — setup

Reviewers can open any receipt, click a field, and leave a comment pinned to it.
Comments are shared through Supabase, so everyone looking at the same receipt sees the
same threads.

Printing and PDF export are unaffected — the panel and pins are removed entirely in
print, and the A4 page keeps its exact geometry.

## 1. Create the Supabase project

1. Sign up at [supabase.com](https://supabase.com) and create a project.

2. Open the **SQL Editor** and run the files from this repo **in this order**. Each one
   assumes the one before it has run, and each is safe to run twice.

   | Order | File | What it does |
   | --- | --- | --- |
   | 1 | `supabase-auth-setup.sql` | The `comments` table, the `members` roster, and every policy that makes the login real |
   | 2 | `supabase-signin-log.sql` | The `sign_ins` register — who got in and when |
   | 3 | `supabase-team-users.sql` | The reviewers, with passwords. Edit the list at the top first |

   Order is the whole of it. Running the second or third file first fails with
   `relation "public.members" does not exist`, and an older copy of the first file that
   did not create `comments` fails with `relation "public.comments" does not exist` —
   the missing thing is named, but several screens after the step that was skipped.

3. Live updates are switched on by the first file. If your plan has no realtime
   publication it skips that quietly and the feature still works — comments appear on
   reload instead of instantly. To check, **Database → Replication** should list
   `comments` under `supabase_realtime`.

## 2. Add your keys

Go to **Project Settings → API** and copy the **Project URL** and the **publishable**
key into the `CONFIG` block at the top of **`assets/auth.js`**. It is the only file that
holds them now; `comments.js` and `comments-badges.js` reuse its client.

```js
const CONFIG = {
  url: 'https://YOUR-PROJECT.supabase.co',
  anonKey: 'sb_publishable_…',
  ...
};
```

Both key formats work — `sb_publishable_…` is the current one, the older `eyJhbGciOi…`
anon JWT is still accepted. Never paste the **service_role** or `sb_secret_…` key here:
those bypass every policy, and this file is public.

The two must belong to the same project. A URL from one project and a key from another
fails every request with 401, which reads on screen as "could not reach the sign-in
service".

Changing them means changing `assets/auth.js`, so bump the `?v=` on both `auth.js` and
`auth.css` in `login.html` at the same time. A browser holding the previous copy will
otherwise keep talking to the old project.

## 3. Serve the files

Any static host works. GitHub Pages is the natural fit since the repo already lives
there — Settings → Pages → deploy from `main`.

It must be *served*, not opened from disk. Sign-in needs a real origin, so `file://`
no longer works — use the local server while editing:

```bash
python -m http.server 5599
```

## Using it

- **Comment mode** (top right) arms the page; every commentable field gets a dashed
  outline.
- Click a field to drop a pin and open the composer. Comments are signed with the name
  from your email address — there is nothing to type.
- Threads are listed top-to-bottom in the order the pins appear on the page. **Reply**
  adds to a thread, **Resolve** greys it out and turns its pin green.
- Click a pin to jump to its thread, or a thread to flash its field.
- **Esc** cancels comment mode. **Hide panel** collapses the rail.

On screens narrower than 1180px the rail starts collapsed so it never squeezes the page;
below 800px it becomes a bottom sheet.

## How pins survive edits

Receipts get edited constantly — rows reordered, labels renamed, fields deleted. Each
comment stores three anchors and resolves them in order:

1. **Label text** — survives reordering.
2. **CSS path** — survives renaming, but only accepted when the label at that position
   still resembles the original. A moved row leaves its old position to a different
   field, and pinning a comment to the wrong field is worse than losing the pin.
3. **x/y percentage** — always resolvable.

If the first two both fail, the thread is grouped under **"Field changed"** in the rail
and its pin is placed from the coordinates in amber. Feedback is never silently dropped
or silently mis-attached.

## Sign-in

Every page loads `assets/auth.js` first. Without a session it sends you to `login.html`,
which asks for your email and mails a code — eight digits, or however many
`codeLength` in `auth.js` says, which must match the OTP length set in Supabase. A
password is accepted as a second door when the mail cannot get through.
The commenter name is derived from the address (`mikias.dereje@safaricom.et` becomes
"Mikias Dereje"), so nobody types a name and nobody can post as someone else.

### The roster: who has access

**Table Editor → `members`** is the list of everyone who can get in. One row per person:

| Column | Meaning |
| --- | --- |
| `email` | Their address. This row is what grants access |
| `name` | Shown on their comments |
| `is_admin` | Tick to let them resolve and delete |
| `joined_at` | Their first sign-in |
| `last_seen_at` | The last time they opened a page |

A new `@safaricom.et` address is added automatically the first time it signs in, so
nobody needs onboarding. To let in an address outside the domain — a contractor, an
auditor — add the row yourself and they can sign in.

**To remove someone: delete their row in `members`.** They lose access on their very next
click; the page bounces them to the login screen saying their access was removed.

Delete the `members` row, **not** the user under *Authentication → Users*. Deleting the
auth user does not revoke anything — they would sign in again, be treated as new, and get
auto-enrolled straight back. Deleting the `members` row sticks precisely because
auto-enrolment only fires on a person's first-ever sign-in.

### The register: who has signed in

`members.last_seen_at` answers *is this person still around*. It cannot answer *who
signed in last Tuesday*, because every page load overwrites it — and neither can
`auth.users.last_sign_in_at`, which keeps one value for the same reason.
**Table Editor → `sign_ins`** keeps a row per sign-in instead:

| Column | Meaning |
| --- | --- |
| `email` | Taken from the verified session, never from the browser |
| `method` | `code`, `password`, or `backfill` for what existed before this table |
| `at` | When they got in |
| `user_agent` | Their browser. Cosmetic, and the only field the page supplies |

Run `supabase-signin-log.sql` once to create it. `login.html` then calls
`rc_log_sign_in()` the moment a session appears, down either door. The address is not a
parameter — the function reads it out of the JWT — so a browser cannot write a row under
someone else's name, and the call is wrapped so that a failure loses a log line, never a
sign-in.

Only admins can read it. The policy is `rc_is_admin()`, the same column that gates
resolve and delete, so a reviewer cannot see who else has been in.

The query worth keeping — the roster with each person's real last sign-in beside it:

```sql
select m.email, m.name, m.is_admin, m.joined_at,
       max(s.at)   as last_sign_in,
       count(s.id) as sign_ins
  from public.members m
  left join public.sign_ins s on s.email = m.email
 group by m.email, m.name, m.is_admin, m.joined_at
 order by last_sign_in desc nulls last;
```

A row with `sign_ins` at zero is someone you added who never actually arrived — usually a
password that was never passed on. `select method, count(*) from public.sign_ins group by
method` is the other one to watch: if nobody is signing in with `code`, the mail is down
and you will hear about it from the register before you hear about it from a colleague.

More queries are written out at the foot of `supabase-signin-log.sql`.

### Signing in once per computer

You are asked for a code **once per browser**, not once per visit. The session is kept in
`localStorage`, so it survives closing the tab, quitting the browser, and restarting the
machine; the hourly access token is renewed silently in the background.

You get sent back to the login page only when:

- you press **Sign out**, or
- the browser's site data is cleared (or you are in a private window), or
- you open the site in a different browser, profile, or computer.

Two dashboard settings can override this — **Authentication → Sessions**. Leave
**Time-box user sessions** and **Inactivity timeout** switched off, which is the default.
Turning either on forces everyone to re-enter a code on a schedule.

### Who can resolve and delete

**Reply** is open to everyone signed in. **Resolve** and **Delete** belong to rows with
`is_admin` ticked — today just `mikias.dereje@safaricom.et`. Everyone else does not see
the buttons, and could not use them anyway: the update and delete policies re-check the
same column.

Tick the box in the Table Editor, or:

```sql
update public.members set is_admin = true where email = 'someone@safaricom.et';
```

Deleting a comment removes its replies too, through the `parent_id` cascade.

### Sending the codes

Supabase's built-in mailer sends **2 emails per hour** for the whole project and is not
meant for production, so the codes go out through Gmail instead.

**Project Settings → Authentication → SMTP Settings**

| Field | Value |
| --- | --- |
| Host | `smtp.gmail.com` |
| Port | `465` |
| Username | `mikias.safaricom@gmail.com` |
| Password | a Google **App Password** for that account, 16 characters, no spaces |
| Sender email | `mikias.safaricom@gmail.com` |
| Sender name | `M-PESA Receipts` |

Gmail refuses your ordinary account password for SMTP — generate an app password at
myaccount.google.com → Security → 2-Step Verification → App passwords. The app password
must belong to the same account as the username, or authentication fails. Free Gmail
allows roughly 500 messages a day.

Once custom SMTP is set, raise **Authentication → Rate Limits → emails per hour** from 2
to about 50. The field stays locked until SMTP is configured.

Never put the app password in this repo. It belongs in the Supabase dashboard only.

### When the code only reaches one person

The symptom is unmistakable: one address gets codes and every other `@safaricom.et`
address gets nothing. It is never the code in this repo — `login.html` runs the same
single `signInWithOtp()` call for every address and special-cases nobody. It is the
mailer.

Supabase's **built-in** mailer refuses any recipient who is not a member of the project
team, and answers `Email address not authorized`. Whoever created the project is a team
member; the colleagues you are inviting are not. So until custom SMTP is switched on, the
project owner is the only person who can receive a code. Check in this order:

1. **Project Settings → Authentication → SMTP Settings** — is it actually enabled, with a
   current 16-character app password? A revoked app password fails with
   `Error sending confirmation email`.
2. **Authentication → Rate Limits → emails per hour** — if it is *locked at 2*, SMTP is
   definitively not on.
3. **Authentication → Logs**, filtered to the failing address — the reason is logged
   verbatim.
4. **Authentication → Email Templates → Confirm signup** must contain `{{ .Token }}`. A
   first-time reviewer gets that template, not Magic Link. Miss it and they receive a
   *link* rather than a code, which looks like "the code never came" too.

The login page now names each of these on screen rather than saying "that address is not
allowed to sign in", so the person who is stuck can read what is wrong and who fixes it.

### The second door: a password

So that a colleague is never blocked on the mail working, `login.html` also accepts a
password — **I have a password instead** on the first step, and **Use a password** while
waiting on a code. It grants nothing extra: `signInWithPassword` produces the same session
the code produces, and every policy still re-checks the `members` row. Access is the row,
never the way you signed in.

To give someone one, **Authentication → Users → Add user**:

| Field | Value |
| --- | --- |
| Email | their `@safaricom.et` address |
| Password | anything; they cannot change it themselves |
| Auto Confirm User | **ticked** — without it sign-in fails with `Email not confirmed`, and confirming needs the mail that does not work |

Creating the user fires `rc_enrol_member()`, so their `members` row appears on its own and
they have access immediately. Send the password over Teams, not email. Revoking is
unchanged: `delete from public.members where email = '…'` — deleting the auth user alone
does not revoke.

**Give yourself one before you need it.** The code email is the part of sign-in that can
fail outside your control: the built-in mailer only reaches project team members, and
Gmail SMTP stops the day an app password is revoked. When that happens nobody can get in
— including the person who would fix it. An admin holding a password always can.

`supabase-admin-user.sql` does it in one step: creates the auth user with the password
already confirmed, writes the `auth.identities` row the dashboard would have written, and
ticks `is_admin`. Re-running it with a new password rotates it. Paste the password into
`v_password`, run it, then put the placeholder back — the file is committed, the password
must not be.

Sessions already open elsewhere survive a rotation; changing a password does not
invalidate a token that has already been issued. To end those as well, *Authentication →
Users →* the row *→ Sign out user*.

Make the password long and random rather than memorable — you type it once per browser
and then not again for months, so it belongs in a password manager, not in your head.

**Making the whole team at once.** `supabase-team-users.sql` is the same thing for a list
of people instead of one: edit the four rows at the top — address, name, admin flag,
password — and run it. Each gets an account with the password already confirmed, the
`auth.identities` row the dashboard would have written, and a `members` row. Re-running it
rotates passwords rather than creating duplicates, so it doubles as the file you come back
to when someone needs a new one.

Nothing is emailed and nothing needs to be. That is the point: the reviewers can be
working before SMTP is sorted out, and the addresses only have to be *theirs*, not
*reachable*. Once mail does work, the same accounts accept a code as well — the password
is a second door, not a second account.

### Making Supabase send a code instead of a link

By default Supabase emails a magic link. Edit **both** templates under
**Authentication → Email Templates** and put `{{ .Token }}` where the
`{{ .ConfirmationURL }}` link was:

- **Magic Link** — used for an address that has signed in before.
- **Confirm signup** — used the very first time an address signs in.

Miss the second one and every reviewer's first login arrives as a link instead of a code.
Set **OTP expiry** to `600` seconds while you are there.

## Security

The publishable key is public by design — it ships in the page source. What protects the
comments is the policy set in `supabase-auth-setup.sql`: every read and write requires a
signed-in session **whose address is a row in `members`**, checked by Postgres on every
request. That is why deleting a row revokes access straight away rather than whenever a
token happens to expire.

Verify it rather than trusting it. With no session, this must return `[]`:

```
curl 'https://YOUR-PROJECT.supabase.co/rest/v1/comments?select=*' -H 'apikey: YOUR-PUBLISHABLE-KEY'
```

If it returns rows, the SQL file has not been run and the login page is decoration.

**The receipts themselves are not protected.** They are static files on a static host:
anyone with a URL can fetch a receipt's HTML directly, and `auth.js` never runs for them.
The login page is a front door, not a lock. Only the comment data is genuinely closed.

Closing the artwork too means a host that can check auth server-side — Cloudflare Pages
with Access is the cheapest route — which is a hosting change, not a code change.

## Files

| File | Role |
| --- | --- |
| `assets/auth.js` | Keys, the Supabase client, the session, the redirect to login, the admin lookup |
| `assets/auth.css` | Login page and the "signed in as" chip |
| `login.html` | The sign-in page — email, then the emailed code, or a password |
| `supabase-auth-setup.sql` | The policies that make any of it real. Run once |
| `supabase-signin-log.sql` | The `sign_ins` register and who may read it. Run once |
| `supabase-team-users.sql` | The review team — accounts and passwords in one list |
| `supabase-admin-user.sql` | Creates an admin with a password, or rotates one |
| `assets/comments.js` | The widget — rail, pins, anchoring, composer |
| `assets/comments.css` | Panel and pin styling, plus the print and small-screen rules |
| `assets/comments-badges.js` | Homepage only: open-comment count per receipt |

Every page carries one line in its `<head>`, deliberately not deferred so nothing paints
before the session is known:

```html
<script src="assets/auth.js"></script>
```

and each receipt keeps its single line before `</body>`:

```html
<script defer src="assets/comments.js"></script>
```

`window.receiptComments` is exposed for debugging — inspect `state`, call `reload()`, or
check `resolveAnchor()` against a stored anchor. `window.receiptAuth` exposes the session:
`email`, `displayName`, `isAdmin`, `signOut()`.
