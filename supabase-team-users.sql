-- ===========================================================================
--  The review team — four accounts, created here rather than invited by mail.
--
--  Run this ONCE in the Supabase SQL Editor, after supabase-auth-setup.sql.
--  Re-running it is safe: an address that already exists has its password
--  rotated and its roster row refreshed, not duplicated.
--
--  Why by hand instead of an invite: the code email is the one part of
--  sign-in that can fail outside your control, and until custom SMTP is on,
--  Supabase's own mailer delivers to project team members and nobody else.
--  An account made here needs no mail at all — the address is only a name to
--  sign in under and to hang comments on. It never has to receive anything.
--
--  They can still use a code later. Once SMTP works, any of them can ask for
--  one at the login page and it will land on the same account. The password
--  is a second door, not a second account.
--
--  THE PASSWORDS DO NOT BELONG IN THIS FILE. Paste them in, run it, then put
--  the placeholders back before you save or commit. Git keeps what you commit
--  forever.
-- ===========================================================================


create extension if not exists pgcrypto with schema extensions;


-- --------------------------------------------------------- 1. the four
--  EDIT THE ADDRESSES. The names below are the ones you gave me; the local
--  parts are a guess. Every address must be the person's real @safaricom.et
--  one, because it is what they type to sign in and what appears on their
--  comments — and because a code sent to a made-up address goes nowhere the
--  day you switch mail on.
--
--  is_admin is the right-hand flag: it grants Resolve and Delete on any
--  comment, not just your own. Reply is open to everyone in the list.
--
--  A password with a single quote in it would end the literal early and break
--  the script. The generated ones deliberately contain none.

do $do$
declare
  r          record;
  v_email    text;
  v_id       uuid;
  v_existing boolean;
  v_made     int := 0;
  v_rotated  int := 0;
begin
  for r in
    select *
      from (values
        --  address                        name       admin   password
        ('danile@safaricom.et',            'Danile',  false,  'PASTE-DANILE-PASSWORD'),
        ('melat@safaricom.et',             'Melat',   false,  'PASTE-MELAT-PASSWORD'),
        ('maedot@safaricom.et',            'Maedot',  false,  'PASTE-MAEDOT-PASSWORD'),
        ('qa.safaricom@safaricom.et',      'QA',      false,  'PASTE-QA-PASSWORD'),
        ('mikias.dereje@safaricom.et',     'Mikias',  true,   'PASTE-MIKIAS-PASSWORD')
      ) as t(email, name, is_admin, password)
  loop
    v_email := lower(trim(r.email));

    if r.password like 'PASTE-%' or length(r.password) < 12 then
      raise exception 'Set a real password for % (12 characters minimum).', v_email;
    end if;

    if v_email not like '%@safaricom.et' then
      raise exception
        'The login page only accepts @safaricom.et addresses, so % could never sign in.',
        v_email;
    end if;

    select id into v_id from auth.users where lower(email) = v_email;
    v_existing := v_id is not null;

    -- ----------------------------------------------------- the auth user
    -- The empty strings at the end are not decoration. GoTrue reads those
    -- columns as Go strings, and a NULL where it expects one fails sign-in
    -- with "converting NULL to string is unsupported" — a baffling error to
    -- meet weeks later, so they are written explicitly.

    if not v_existing then
      v_id := gen_random_uuid();

      insert into auth.users (
        instance_id, id, aud, role,
        email, encrypted_password, email_confirmed_at,
        created_at, updated_at,
        raw_app_meta_data, raw_user_meta_data,
        confirmation_token, recovery_token,
        email_change, email_change_token_new, email_change_token_current
      ) values (
        '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated',
        v_email,
        extensions.crypt(r.password, extensions.gen_salt('bf', 10)),
        now(),                     -- confirmed on the spot: no mail required
        now(), now(),
        jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')),
        jsonb_build_object('name', r.name, 'email_verified', true),
        '', '', '', '', ''
      );
      v_made := v_made + 1;
    else
      update auth.users
         set encrypted_password = extensions.crypt(r.password, extensions.gen_salt('bf', 10)),
             email_confirmed_at = coalesce(email_confirmed_at, now()),
             updated_at         = now()
       where id = v_id;
      v_rotated := v_rotated + 1;
    end if;

    -- ------------------------------------------------------ the identity
    -- A user with no identity row can be created but cannot sign in: GoTrue
    -- finds the password through the email identity, not through the user.
    -- Miss it and a correct password comes back "Invalid login credentials".

    insert into auth.identities (
      id, user_id, provider_id, provider, identity_data,
      last_sign_in_at, created_at, updated_at
    ) values (
      gen_random_uuid(), v_id, v_id::text, 'email',
      jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
      null, now(), now()
    )
    on conflict (provider_id, provider) do nothing;

    -- -------------------------------------------------------- the roster
    -- The insert above already fired rc_enrol_member(), which adds an
    -- ordinary member row. This sets the name and the admin flag, and is an
    -- upsert so the script also works on somebody already signing in.

    insert into public.members (email, name, is_admin)
    values (v_email, r.name, r.is_admin)
    on conflict (email) do update
      set name     = excluded.name,
          is_admin = excluded.is_admin;
  end loop;

  raise notice '% created, % password(s) rotated.', v_made, v_rotated;
end
$do$;


-- ------------------------------------------------------------- 2. check it
-- Four rows, every flag true. can_sign_in false is the missing identity row,
-- which is the failure that looks exactly like a wrong password.

select m.name,
       m.email,
       m.is_admin,
       u.email_confirmed_at is not null  as confirmed,
       u.encrypted_password is not null  as has_password,
       exists (select 1
                 from auth.identities i
                where i.user_id = u.id and i.provider = 'email')
                                         as can_sign_in
  from public.members m
  join auth.users u on lower(u.email) = m.email
 order by m.is_admin desc, m.name;


-- =========================================================================
--  Handing them out
-- =========================================================================
--
--  Each person goes to login.html, types their address, clicks
--  "I have a password instead", and types their password. Nothing is emailed
--  and nothing needs to be. After that the browser stays signed in until they
--  press Sign out.
--
--  Send passwords over Teams, one to each person. Never email a password to
--  the address it signs into — that puts both halves of the login in the same
--  inbox.
--
--  Rotate one: change that row's password and run the script again. Sessions
--  already open elsewhere survive; to end those too, Authentication -> Users
--  -> the row -> Sign out user.
--
--  Promote or demote — this is Resolve and Delete on anyone's comment:
--      update public.members set is_admin = true  where email = '…';
--      update public.members set is_admin = false where email = '…';
--
--  Revoke. The members row, never the auth user: deleting the auth user lets
--  them straight back in through auto-enrolment.
--      delete from public.members where email = '…';
--
--  Who has actually been in, once supabase-signin-log.sql is running:
--      select m.name, m.email, max(s.at) as last_sign_in, count(s.id) as sign_ins
--        from public.members m
--        left join public.sign_ins s on s.email = m.email
--       group by m.name, m.email
--       order by last_sign_in desc nulls last;
-- =========================================================================
