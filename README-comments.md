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

create policy "anyone may read"    on public.comments for select using (true);
create policy "anyone may comment" on public.comments for insert with check (true);
create policy "anyone may resolve" on public.comments for update using (true) with check (true);
```

3. For live updates, go to **Database → Replication** and add `comments` to the
   `supabase_realtime` publication. Without this the feature still works; comments just
   appear on reload instead of instantly.

## 2. Add your keys

Go to **Project Settings → API** and copy the **Project URL** and the **anon public**
key into the `CONFIG` block at the top of **both** files:

- `assets/comments.js`
- `assets/comments-badges.js`

```js
const CONFIG = {
  url: 'https://YOUR-PROJECT.supabase.co',
  anonKey: 'eyJhbGciOi...',
  ...
};
```

Until these are filled in, receipts open normally and the panel shows a short "not
connected" note. Nothing breaks.

## 3. Serve the files

Any static host works. GitHub Pages is the natural fit since the repo already lives
there — Settings → Pages → deploy from `main`.

Opening the files directly from disk (`file://`) also works for reading and writing
comments, but a served copy is more reliable and is required if you later add Supabase
Auth.

## Using it

- **Comment mode** (top right) arms the page; every commentable field gets a dashed
  outline.
- Click a field to drop a pin and open the composer. The first comment asks for your
  name and remembers it.
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

## Who can resolve and delete

**Reply** is open to everyone. **Resolve** and **Delete** are admin-only: they
show a padlock, and using one prompts for the admin password. Entering it
correctly unlocks both for that browser from then on.

The default password is **`mpesa-admin`** — change it. The phrase is not stored
in the source, only its SHA-256 digest, as `adminHash` in `assets/comments.js`.
To set a new one, run this in any browser console and paste the result:

```js
crypto.subtle.digest('SHA-256', new TextEncoder().encode('YOUR NEW PHRASE'))
  .then(b => console.log([...new Uint8Array(b)]
    .map(x => x.toString(16).padStart(2, '0')).join('')))
```

Deleting a comment removes its replies too, through the `parent_id` cascade.

**This gates the interface, not the database.** The anon key is public and the
policies allow deletes, so someone who reads the page source could call the API
directly. It stops casual resolving and deleting; it is not access control. See
below for the real fix.

## Security

The anon key is public by design; access is governed entirely by the RLS policies above,
which allow **anyone who can load the page** to read and post comments. That is usually
fine for an internal review board, but if this repo and its Pages site are public, so is
the comment table.

To lock it down, either:

- **Shared passphrase** — simplest. Gate the rail behind a passphrase and require it in
  the policies.
- **Supabase Auth** — magic-link sign-in, with policies keyed to `auth.uid()`. Requires
  serving over http(s), not `file://`.

## Files

| File | Role |
| --- | --- |
| `assets/comments.js` | The whole widget — config, Supabase client, rail, pins, anchoring, admin gate |
| `assets/comments.css` | Panel and pin styling, plus the print and small-screen rules |
| `assets/comments-badges.js` | Homepage only: open-comment count per receipt |

Each receipt carries a single line before `</body>`:

```html
<script defer src="assets/comments.js"></script>
```

`window.receiptComments` is exposed for debugging — inspect `state`, call `reload()`, or
check `resolveAnchor()` against a stored anchor.
