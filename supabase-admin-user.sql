-- ===========================================================================
--  Make an admin by hand — an address and a password, no email involved.
--
--  This exists because the code email is the one part of sign-in that can be
--  outside your control. Supabase's built-in mailer only delivers to project
--  team members, and Gmail SMTP starts refusing the day an app password is
--  revoked. When that happens nobody can get in, including you. An admin who
--  holds a password can always get in and fix it.
--
--  The password is a second DOOR, not a second level of access. The session
--  signInWithPassword() hands back is the same session a code hands back, and
--  every policy still re-checks the members row. Access is the row. Deleting
--  the members row revokes this person exactly like anyone else.
--
--  THE PASSWORD DOES NOT BELONG IN THIS FILE. Paste it into v_password below,
--  run the script, then put the placeholder back before you save or commit.
--  Git keeps what you commit forever, and this repo is not the place for it.
-- ===========================================================================


-- =========================================================================
--  The easier way first
-- =========================================================================
--
--  If you can reach the dashboard, do it there and skip all the SQL below.
--  It is the supported path, and it cannot drift out of step with whatever
--  Supabase changes in the auth schema next:
--
--      Authentication -> Users -> Add user
--
--        Email               their @safaricom.et address
--        Password            the strong one you generated
--        Auto Confirm User   TICKED. Without it sign-in fails with
--                            "Email not confirmed", and confirming it needs
--                            the mail that does not work.
--
--  That fires rc_enrol_member(), so their members row appears on its own —
--  but as an ordinary member. One line makes them an admin:
--
--      update public.members set is_admin = true
--       where email = 'mikias.dereje@safaricom.et';
--
--  Use the script below when the dashboard is not to hand, when you want the
--  whole thing in one repeatable step, or to rotate a password later.


-- ------------------------------------------------------------- 0. crypto
-- bcrypt lives in pgcrypto. On Supabase it is installed into the extensions
-- schema, which is why every call below is qualified: the SQL editor does not
-- always carry that schema on its search_path.

create extension if not exists pgcrypto with schema extensions;


-- --------------------------------------------------------- 1. the person
-- Edit the three values. Everything after them is mechanical.
--
--  * The address must end in @safaricom.et. auth.js checks the domain before
--    it will even try, so any other address is refused by the login page long
--    before Postgres is asked.
--  * Re-running this with a new password ROTATES it. Sessions already open on
--    other computers survive — changing a password does not invalidate a
--    token that has already been issued. To end those too: Authentication ->
--    Users -> the row -> Sign out user.

do $$
declare
  v_email    text := lower('mikias.dereje@safaricom.et');
  v_name     text := 'Mikias Dereje';
  v_password text := 'PASTE-THE-PASSWORD-HERE';

  v_id       uuid;
  v_existing boolean;
begin
  if v_password = 'PASTE-THE-PASSWORD-HERE' or length(v_password) < 12 then
    raise exception
      'Set v_password to the real password first (12 characters minimum).';
  end if;

  if v_email not like '%@safaricom.et' then
    raise exception
      'The login page only accepts @safaricom.et addresses, so % could never sign in.',
      v_email;
  end if;

  select id into v_id from auth.users where lower(email) = v_email;
  v_existing := v_id is not null;

  -- ------------------------------------------------------- the auth user
  -- The empty strings at the end are not decoration. GoTrue reads those
  -- columns as Go strings, and a NULL where it expects one fails the sign-in
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
      extensions.crypt(v_password, extensions.gen_salt('bf', 10)),
      now(),                       -- confirmed on the spot: no mail required
      now(), now(),
      jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')),
      jsonb_build_object('name', v_name, 'email_verified', true),
      '', '', '', '', ''
    );
  else
    update auth.users
       set encrypted_password = extensions.crypt(v_password, extensions.gen_salt('bf', 10)),
           email_confirmed_at = coalesce(email_confirmed_at, now()),
           updated_at         = now()
     where id = v_id;
  end if;

  -- --------------------------------------------------------- the identity
  -- A user with no identity row can be created but cannot sign in: GoTrue
  -- finds the password through the email identity, not through the user. The
  -- dashboard writes this for you; by hand it is easy to miss, and the
  -- symptom is a correct password rejected as "Invalid login credentials".

  insert into auth.identities (
    id, user_id, provider_id, provider, identity_data,
    last_sign_in_at, created_at, updated_at
  ) values (
    gen_random_uuid(), v_id, v_id::text, 'email',
    jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
    null, now(), now()
  )
  on conflict (provider_id, provider) do nothing;

  -- ----------------------------------------------------------- the roster
  -- The insert above already fired rc_enrol_member(), which adds an ordinary
  -- member row. This is the line that makes them an admin, and it is an
  -- upsert so the script also works on somebody who has been signing in with
  -- codes for weeks.

  insert into public.members (email, name, is_admin)
  values (v_email, v_name, true)
  on conflict (email) do update
    set is_admin = true,
        name     = coalesce(excluded.name, public.members.name);

  raise notice '% is now an admin with a password (%).',
    v_email, case when v_existing then 'password rotated' else 'new user' end;
end $$;


-- ------------------------------------------------------------- 2. check it
-- Every column must come back true. A missing identity row is the failure
-- that looks exactly like a wrong password.

select u.email,
       u.email_confirmed_at is not null  as confirmed,
       u.encrypted_password is not null  as has_password,
       exists (select 1
                 from auth.identities i
                where i.user_id = u.id and i.provider = 'email')
                                         as can_sign_in,
       m.is_admin,
       u.last_sign_in_at
  from auth.users u
  left join public.members m on m.email = lower(u.email)
 where lower(u.email) = lower('mikias.dereje@safaricom.et');


-- =========================================================================
--  Afterwards
-- =========================================================================
--
--  Sign in at login.html -> "I have a password instead" -> the address, then
--  the password. If it is refused, read the row above before touching
--  anything: can_sign_in false means the identity row is missing, confirmed
--  false means Auto Confirm was skipped.
--
--  Rotate the password: change v_password and run the block again.
--
--  Take admin away but leave the account:
--      update public.members set is_admin = false where email = '…';
--
--  Revoke entirely — this is the one that matters, and it is the members row,
--  never the auth user:
--      delete from public.members where email = '…';
--
--  Keep the password in a password manager. Send it over Teams, never email:
--  emailing a password to the address it signs into puts both halves of the
--  login in the same inbox.
-- =========================================================================
