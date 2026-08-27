-- ===========================================================================
--  The sign-in register — who got in, when, and through which door.
--
--  Run this ONCE in the Supabase SQL Editor, after supabase-auth-setup.sql.
--  It is additive: nothing existing is dropped or rewritten.
--
--  members.last_seen_at already answers "is this person still around". It
--  cannot answer "who signed in last Tuesday", because every page load
--  overwrites it. This file adds a row per sign-in instead of a column that
--  keeps being replaced.
--
--  auth.users.last_sign_in_at has the same flaw — one value, overwritten —
--  and Authentication -> Logs keeps its history for a few days only, on the
--  free plan. This table is yours and keeps everything.
-- ===========================================================================


-- ------------------------------------------------------------ 1. the table

create table if not exists public.sign_ins (
  id         bigint generated always as identity primary key,
  email      text        not null,
  method     text        not null default 'unknown',   -- code | password | backfill
  at         timestamptz not null default now(),
  user_agent text
);

comment on table public.sign_ins is
  'One row per successful sign-in. Written only by rc_log_sign_in(), which '
  'takes the address from the session rather than from the browser.';

create index if not exists sign_ins_at_idx    on public.sign_ins (at desc);
create index if not exists sign_ins_email_idx on public.sign_ins (email, at desc);


-- ---------------------------------------------------------- 2. the writer
-- The page calls this once, straight after a session appears.
--
-- security definer, because the table is shut to clients — see section 3.
-- The address is NOT a parameter: it is read out of the verified JWT by
-- rc_email(), so a browser cannot write a row claiming to be somebody else.
-- The only things the caller supplies are the door they came through, which
-- is checked against a list of two, and the user agent, which is cosmetic and
-- truncated.

create or replace function public.rc_log_sign_in(
  p_method     text default 'unknown',
  p_user_agent text default null
) returns void
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_email text := public.rc_email();
begin
  if v_email is null then
    return;                       -- no session; nothing to record
  end if;

  -- Somebody who has been removed from the roster still holds a token until
  -- it expires. They get no row: the register is a list of people who were
  -- let in, not of people who tried.
  if not exists (select 1 from public.members where email = v_email) then
    return;
  end if;

  insert into public.sign_ins (email, method, user_agent)
  values (
    v_email,
    case when p_method in ('code', 'password') then p_method else 'unknown' end,
    left(coalesce(p_user_agent, ''), 400)
  );

  update public.members set last_seen_at = now() where email = v_email;
end
$$;

grant execute on function public.rc_log_sign_in(text, text) to authenticated;


-- --------------------------------------------------------- 3. who may read
-- RLS on with a single select policy: admins read the whole register, and
-- nobody writes directly — every insert goes through rc_log_sign_in() above,
-- which is the only reason the email column can be trusted.

alter table public.sign_ins enable row level security;

drop policy if exists "admin read sign ins" on public.sign_ins;
create policy "admin read sign ins" on public.sign_ins
  for select to authenticated
  using (public.rc_is_admin());


-- ------------------------------------------------------- 4. reading it back
-- The register joined to the roster, newest first, for an admin. Exposed as a
-- function so the page can call it over RPC without needing select rights on
-- members — which stays shut to everyone but their own row.

create or replace function public.rc_sign_in_history(p_limit int default 200)
returns table (
  email     text,
  name      text,
  is_admin  boolean,
  method    text,
  at        timestamptz
)
language sql stable security definer
set search_path = public
as $$
  select s.email, m.name, m.is_admin, s.method, s.at
    from public.sign_ins s
    left join public.members m on m.email = s.email
   where public.rc_is_admin()          -- not an admin, not a row
   order by s.at desc
   limit greatest(1, least(coalesce(p_limit, 200), 1000))
$$;

grant execute on function public.rc_sign_in_history(int) to authenticated;


-- --------------------------------------------------------- 5. the backfill
-- So the register is not empty on its first day. Supabase remembers the most
-- recent sign-in per user and nothing before it, so this recovers exactly one
-- row each — marked 'backfill' to be honest about where it came from.

insert into public.sign_ins (email, method, at)
select lower(u.email), 'backfill', u.last_sign_in_at
  from auth.users u
 where u.email is not null
   and u.last_sign_in_at is not null
   and not exists (
     select 1 from public.sign_ins s
      where s.email = lower(u.email) and s.at = u.last_sign_in_at
   );


-- =========================================================================
--  Reading the register
-- =========================================================================
--
--  Everything, newest first — Table Editor -> sign_ins does the same:
--      select email, method, at from public.sign_ins order by at desc;
--
--  Who has been in this week, and how often:
--      select email,
--             count(*)  as sign_ins,
--             max(at)   as last_one
--        from public.sign_ins
--       where at > now() - interval '7 days'
--       group by email
--       order by last_one desc;
--
--  The roster with each person's real last sign-in beside it — the one view
--  that answers "who is actually using this":
--      select m.email, m.name, m.is_admin, m.joined_at,
--             max(s.at)                        as last_sign_in,
--             count(s.id)                      as sign_ins
--        from public.members m
--        left join public.sign_ins s on s.email = m.email
--       group by m.email, m.name, m.is_admin, m.joined_at
--       order by last_sign_in desc nulls last;
--
--  On the roster but has never once signed in — an address added by hand that
--  never arrived, usually because the password was never passed on:
--      select m.email, m.name, m.joined_at
--        from public.members m
--       where not exists (select 1 from public.sign_ins s where s.email = m.email);
--
--  Who is getting in without the mail working — if this is everyone, the SMTP
--  settings need attention:
--      select method, count(*) from public.sign_ins group by method;
--
--  Trim the register (it is a log; it only grows):
--      delete from public.sign_ins where at < now() - interval '1 year';
--
--  Check it landed:
--      select tablename, policyname from pg_policies where tablename = 'sign_ins';
-- =========================================================================
