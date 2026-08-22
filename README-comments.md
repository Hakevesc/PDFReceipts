# Receipt comments — setup

Reviewers can open any receipt, click a field, and leave a comment pinned to it.
Comments are shared through Supabase, so everyone looking at the same receipt sees the
same threads.

Printing and PDF export are unaffected — the panel and pins are removed entirely in
print, and the A4 page keeps its exact geometry.

## 1. Create the Supabase project

1. Sign up at [supabase.com](https://supabase.com) and create a project.
2. Open **SQL Editor** and run:

```sql
create table public.comments (
  id           uuid primary key default gen_random_uuid(),
  receipt      text        not null,
  parent_id    uuid        references public.comments(id) on delete cascade,
  anchor_label text,
  anchor_path  text,
  anchor_x     real,
  anchor_y     real,
  author       text        not null,
  body         text        not null,
  resolved     boolean     not null default false,
  created_at   timestamptz not null default now()
);

create index comments_receipt_idx on public.comments (receipt, created_at);

alter table public.comments enable row level security;

-- policies come from supabase-auth-setup.sql, see "Sign-in" below
```

3. For live updates, go to **Database → Replication** and add `comments` to the
   `supabase_realtime` publication. Without this the feature still works; comments just
   appear on reload instead of instantly.

4. Run **`supabase-auth-setup.sql`** from this repo in the same SQL Editor. It replaces
   the open policies with ones keyed to a signed-in `@safaricom.et` session. Skipping it
   leaves the table readable and writable by anyone — see **Sign-in** below.

## 2. Add your keys

Go to **Project Settings → API** and copy the **Project URL** and the **anon public**
key into the `CONFIG` block at the top of **`assets/auth.js`**. It is the only file that
holds them now; `comments.js` and `comments-badges.js` reuse its client.

```js
const CONFIG = {
  url: 'https://YOUR-PROJECT.supabase.co',
  anonKey: 'eyJhbGciOi...',
  ...
};
```

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
which asks for your email, mails a 6-digit code, and takes the code — no password, ever.
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

### Making Supabase send a code instead of a link

By default Supabase emails a magic link. Edit **both** templates under
**Authentication → Email Templates** and put `{{ .Token }}` where the
`{{ .ConfirmationURL }}` link was:

- **Magic Link** — used for an address that has signed in before.
- **Confirm signup** — used the very first time an address signs in.

Miss the second one and every reviewer's first login arrives as a link instead of a code.
Set **OTP expiry** to `600` seconds while you are there.

## Security

The anon key is public by design — it ships in the page source. What protects the
comments is the policy set in `supabase-auth-setup.sql`: every read and write requires a
signed-in session **whose address is a row in `members`**, checked by Postgres on every
request. That is why deleting a row revokes access straight away rather than whenever a
token happens to expire.

Verify it rather than trusting it. With no session, this must return `[]`:

```
curl 'https://YOUR-PROJECT.supabase.co/rest/v1/comments?select=*' -H 'apikey: YOUR-ANON-KEY'
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
| `login.html` | The sign-in page — email, then the 6-digit code |
| `supabase-auth-setup.sql` | The policies that make any of it real. Run once |
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
