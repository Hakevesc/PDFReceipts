-- ===========================================================================
--  Receipt review — lock the comments to a list of people you control.
--
--  Run this ONCE in the Supabase SQL Editor. It is safe on a table that
--  already holds comments: the two new columns are nullable, so existing
--  rows keep their author text and simply have no user_id.
--
--  Until this runs, the comment table is readable and writable by anyone
--  holding the public anon key — which is everyone, since it ships in the
--  page source. The login page alone does not change that. This file does.
--
--  AFTERWARDS: Table Editor -> members is your roster. Everyone who has ever
--  signed in appears there, with when they joined and when they were last
--  seen. Delete a row and that person loses access on their very next click.
-- ===========================================================================


-- ------------------------------------------------------------ 0. the table
-- The comments themselves. This used to live only in the README, which made
-- this file quietly depend on somebody having read it first — and on a fresh
-- project the dependency announces itself as
--
--     ERROR: 42P01: relation "public.comments" does not exist
--
-- from section 4 below, several screens after the thing that was actually
-- missing. Creating it here makes "run this once" true.
--
-- if not exists, so running this against the project that already holds
-- months of comments changes nothing at all.

create table if not exists public.comments (
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

-- Every read the panel does is "this receipt, oldest first".
create index if not exists comments_receipt_idx
  on public.comments (receipt, created_at);

-- Live updates. Without this the feature still works — comments appear on
-- reload instead of instantly — so a project where it is already added, or a
-- plan without realtime, is not an error worth stopping for.
do $$
begin
  alter publication supabase_realtime add table public.comments;
exception
  when others then null;   -- already published, no such publication, or not
                           -- ours to alter. All three are survivable: this
                           -- block buys instant updates, not correctness, and
                           -- it must never be the reason setup stops.
end
$$;


-- ---------------------------------------------------------------- 1. roster
-- One table for everything: who may sign in, who is an admin, who was last
-- here. Presence of the row IS the access.

create table if not exists public.members (
  email        text primary key,
  name         text,
  is_admin     boolean     not null default false,
  joined_at    timestamptz not null default now(),
  last_seen_at timestamptz
);

comment on table public.members is
  'Access roster. Delete a row to revoke that person immediately. '
  'Tick is_admin to let them resolve and delete comments.';


-- ------------------------------------------------------------- 2. helpers
-- security definer so they can read the roster while it stays shut to
-- clients. search_path is pinned: a definer function without it can be
-- steered at attacker-supplied objects.

create or replace function public.rc_email() returns text
  language sql stable
  set search_path = public
  as $$ select lower(auth.jwt() ->> 'email') $$;

-- Access is membership. Not the domain, not the token — the row.
create or replace function public.rc_allowed() returns boolean
  language sql stable security definer
  set search_path = public
  as $$
    select exists (select 1 from public.members where email = public.rc_email())
  $$;

create or replace function public.rc_is_admin() returns boolean
  language sql stable security definer
  set search_path = public
  as $$
    select exists (
      select 1 from public.members
      where email = public.rc_email() and is_admin
    )
  $$;

-- Called by the page on every load so "last seen" stays meaningful.
create or replace function public.rc_touch() returns void
  language sql volatile security definer
  set search_path = public
  as $$
    update public.members
       set last_seen_at = now()
     where email = public.rc_email()
  $$;

grant execute on function public.rc_touch() to authenticated;


-- ------------------------------------------------------- 3. auto-enrolment
-- A new @safaricom.et address is added to the roster the first time it signs
-- in, so nobody has to be onboarded by hand.
--
-- The trigger fires on INSERT into auth.users — that is, only on a person's
-- very first sign-in ever. This is what makes deletion stick: remove someone
-- from members and signing in again will NOT put them back, because their
-- auth user already exists and no INSERT happens.

create or replace function public.rc_enrol_member()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if lower(new.email) like '%@safaricom.et' then
    insert into public.members (email, name)
    values (
      lower(new.email),
      initcap(replace(replace(split_part(lower(new.email), '@', 1), '.', ' '), '_', ' '))
    )
    on conflict (email) do nothing;
  end if;
  return new;
end
$$;

drop trigger if exists rc_enrol_member_trigger on auth.users;
create trigger rc_enrol_member_trigger
  after insert on auth.users
  for each row execute function public.rc_enrol_member();


-- ------------------------------------------------- 4. unforgeable attribution
-- The client sends these, but the insert policy below requires them to match
-- the session. A forged author is rejected by Postgres, not trusted.

alter table public.comments
  add column if not exists user_id uuid references auth.users(id) on delete set null;
alter table public.comments
  add column if not exists author_email text;


-- ------------------------------------------------------------- 5. policies

alter table public.comments enable row level security;

drop policy if exists "anyone may read"    on public.comments;
drop policy if exists "anyone may comment" on public.comments;
drop policy if exists "anyone may resolve" on public.comments;
drop policy if exists "staff read"         on public.comments;
drop policy if exists "staff write"        on public.comments;
drop policy if exists "admin update"       on public.comments;
drop policy if exists "admin delete"       on public.comments;

create policy "staff read" on public.comments
  for select to authenticated
  using (public.rc_allowed());

create policy "staff write" on public.comments
  for insert to authenticated
  with check (
    public.rc_allowed()
    and user_id = auth.uid()
    and author_email = public.rc_email()
  );

create policy "admin update" on public.comments
  for update to authenticated
  using (public.rc_is_admin())
  with check (public.rc_is_admin());

create policy "admin delete" on public.comments
  for delete to authenticated
  using (public.rc_is_admin());


-- --------------------------------------------------- 6. shut the roster
-- RLS on with no insert/update/delete policy means only the Table Editor,
-- the SQL editor and the service role can change it. Without this, anyone
-- with the anon key could add themselves and tick is_admin.

alter table public.members enable row level security;

drop policy if exists "read own membership" on public.members;
create policy "read own membership" on public.members
  for select to authenticated
  using (email = public.rc_email());

-- You may read your own row and nothing else. That is only so the page can
-- hide the admin buttons and notice when you have been removed; the real
-- checks are rc_allowed() and rc_is_admin() inside the policies above.


-- ------------------------------------------------------------------ 7. seed

-- Anyone who already signed in before this migration.
insert into public.members (email, name)
select lower(u.email),
       initcap(replace(replace(split_part(lower(u.email), '@', 1), '.', ' '), '_', ' '))
from auth.users u
where u.email is not null
on conflict (email) do nothing;

-- The one admin.
insert into public.members (email, name, is_admin)
values ('mikias.dereje@safaricom.et', 'Mikias Dereje', true)
on conflict (email) do update set is_admin = true;

-- mikias.safaricom@gmail.com is the SENDER of the code emails. It is not a
-- login and deliberately gets no row here.


-- =========================================================================
--  Running it
-- =========================================================================
--
--  See who has access:
--      select email, name, is_admin, joined_at, last_seen_at
--        from public.members order by last_seen_at desc nulls last;
--
--  Revoke someone — this is the one that matters. Delete the members row,
--  NOT the user under Authentication -> Users. Deleting the auth user alone
--  does not revoke: they would sign in again, the trigger would fire, and
--  they would be re-enrolled.
--      delete from public.members where email = 'someone@safaricom.et';
--
--  Make or unmake an admin:
--      update public.members set is_admin = true
--       where email = 'someone@safaricom.et';
--
--  Let a non-safaricom.et address in (contractor, auditor). The trigger will
--  not enrol them, so add the row by hand and they can sign in:
--      insert into public.members (email, name) values ('x@example.com', 'X');
--
--  Restore someone you removed:
--      insert into public.members (email, name) values ('someone@safaricom.et', 'Someone');
--
--  Check the policies landed:
--      select tablename, policyname from pg_policies
--       where tablename in ('comments','members');
-- =========================================================================
