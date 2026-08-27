/* ==========================================================================
   Sign-in guard.

   Load this FIRST in the <head> of every page — not deferred:
       <script src="assets/auth.js"></script>

   On any page but the login page it hides the body until a session is
   confirmed, and sends visitors without one to login.html. It is also the
   single owner of the Supabase client: comments.js and comments-badges.js
   both wait on window.receiptAuth.ready and reuse the client from here, so
   there is exactly one session in the browser.

   What this does and does not do
   ------------------------------
   The receipts are static files on a static host. Anyone can fetch a
   receipt's HTML directly and this script will never run for them. The gate
   is a front door, not a lock.

   What IS enforced is the comment data: every policy on the comments table
   requires an authenticated @safaricom.et session, checked by Postgres. No
   session, no comments — whatever the browser does.
   ========================================================================== */

(function () {
  'use strict';

  /* ---------------------------------------------------------------- config */

  const CONFIG = {
    url: 'https://igtcubuthdipvckbilqr.supabase.co',

    // The publishable key. Public by design — it ships in the page source and
    // is meant to. It identifies the project, it does not grant anything: the
    // policies decide that, on every request.
    //
    // sb_publishable_… is the current key format; the old anon key was a JWT
    // and both still work. Whichever you paste must belong to the project in
    // `url` above, or every request comes back 401.
    anonKey: 'sb_publishable_pN_8blmu8mU5weUK2kJggg_pDUYx8mo',

    clientModule: 'https://esm.sh/@supabase/supabase-js@2',

    // Who may sign in. Mirrored by rc_allowed() in Postgres — this copy only
    // saves a wasted email; the database copy is the one that matters.
    allowedDomains: ['safaricom.et'],

    loginPage: 'login.html',
    homePage: 'index.html',
    // Bumped when the project changed. A browser still holding a session from
    // the previous project would otherwise present a token the new one has
    // never issued: getSession() hands it back because it is only reading
    // localStorage, and the first real request fails in a way that reads as
    // "could not check your access". A new key orphans those quietly and
    // sends the person to the login page, which is the truth — the new
    // project has never seen them.
    storageKey: 'rc-auth-2',

    // How many digits the emailed code has. MUST match Supabase:
    // Authentication -> Sign In / Providers -> Email -> Email OTP Length.
    // The login page builds that many boxes from this number, so the two
    // only have to agree here.
    codeLength: 8,

    // The access roster. A row here is what grants access; deleting it in the
    // Supabase Table Editor revokes the person on their next request.
    memberTable: 'members'
  };

  /* ------------------------------------------------------------------ lock
     Added synchronously, before the Supabase SDK is even fetched, so a
     receipt never paints for a frame before the session check resolves. */

  const root = document.documentElement;
  const script = document.currentScript;
  const IS_LOGIN = !!(script && script.hasAttribute('data-login'));

  if (!IS_LOGIN) {
    root.classList.add('rc-locked');
    const lockStyle = document.createElement('style');
    lockStyle.id = 'rc-lock-style';
    lockStyle.textContent = 'html.rc-locked body { visibility: hidden !important; }';
    (document.head || root).appendChild(lockStyle);
  }

  const unlock = () => root.classList.remove('rc-locked');

  /* --------------------------------------------------------------- helpers */

  const msgOf = (e) => (e && e.message ? e.message : String(e || 'unknown error'));

  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(label + ' timed out')), ms))
    ]);
  }

  function isAllowedEmail(email) {
    const at = String(email || '').trim().toLowerCase().split('@');
    if (at.length !== 2 || !at[0]) return false;
    return CONFIG.allowedDomains.indexOf(at[1]) !== -1;
  }

  // "danile" -> "danile@safaricom.et". People think of themselves as having a
  // username; Supabase has only ever known addresses. This is the one place
  // the two are reconciled, and it takes the domain from allowedDomains so it
  // cannot drift away from the check that follows it.
  //
  // Anything already containing an @ is left alone, so a full address still
  // works and an address from the wrong domain is still refused rather than
  // quietly rewritten into the right one.
  function toEmail(value) {
    const v = String(value || '').trim().toLowerCase();
    if (!v || v.indexOf('@') !== -1) return v;
    return v + '@' + CONFIG.allowedDomains[0];
  }

  // mikias.dereje@safaricom.et -> "Mikias Dereje". Cosmetic only: the row's
  // author_email is the identity the database checks.
  function displayNameFor(email) {
    const local = String(email || '').split('@')[0];
    const words = local.split(/[._-]+/).filter(Boolean).map(
      (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
    );
    return words.join(' ') || local;
  }

  // Only ever a bare filename from this origin, so ?next= can never point
  // somewhere else. Anything with a slash, scheme or host is dropped.
  function safeNext(value) {
    const v = String(value || '');
    if (!v || !/^[A-Za-z0-9._%+-]+\.html(?:[?#][^\s]*)?$/.test(v)) return '';
    return v;
  }

  function currentPageRef() {
    const file = location.pathname.split('/').pop() || '';
    if (!file || file === CONFIG.loginPage) return '';
    return safeNext(file + location.search + location.hash);
  }

  // Is there a signed-in session saved on this computer? Only used to tell
  // "never signed in" apart from "signed in, but the network is down".
  function hasStoredSession() {
    try {
      return !!window.localStorage.getItem(CONFIG.storageKey);
    } catch (_) {
      return false;   // private mode with storage blocked
    }
  }

  function toLogin(reason) {
    const q = new URLSearchParams();
    const next = currentPageRef();
    if (next) q.set('next', next);
    if (reason) q.set('reason', reason);
    const qs = q.toString();
    location.replace(CONFIG.loginPage + (qs ? '?' + qs : ''));
  }

  /* ---------------------------------------------------------------- client */

  let client = null;
  let clientPromise = null;

  function getClient() {
    if (clientPromise) return clientPromise;
    clientPromise = import(CONFIG.clientModule).then((mod) => {
      client = mod.createClient(CONFIG.url, CONFIG.anonKey, {
        auth: {
          // Sign in once per computer and stay signed in. localStorage, not
          // sessionStorage, so the session outlives the tab and the browser
          // restart; autoRefreshToken renews the hourly access token in the
          // background from a refresh token that does not expire on its own.
          // The only ways back to the login page are Sign out, clearing site
          // data, or a different browser or profile.
          persistSession: true,
          autoRefreshToken: true,
          storage: window.localStorage,
          storageKey: CONFIG.storageKey,
          detectSessionInUrl: false  // codes are typed in, never in the URL
        }
      });
      return client;
    });
    return clientPromise;
  }

  /* ----------------------------------------------------------------- state */

  const api = {
    isLoginPage: IS_LOGIN,
    config: CONFIG,
    getClient,
    isAllowedEmail,
    toEmail,
    displayNameFor,
    safeNext,
    signedIn: false,
    user: null,
    email: '',
    displayName: '',
    isAdmin: false,
    error: null,
    signOut
  };

  // Returns 'ok', 'revoked', or 'unknown' (could not reach the database).
  //
  // Membership and admin rights are rows in the database, not flags in this
  // browser. Editing them here buys nothing: every policy re-checks the same
  // table server-side, so a removed person gets an empty page either way.
  // This lookup only exists so the page can say so plainly instead of
  // silently showing nothing.
  async function adopt(session) {
    api.user = session.user;
    api.email = String(session.user.email || '').toLowerCase();
    api.displayName = displayNameFor(api.email);

    let row = null;
    try {
      const { data, error } = await client
        .from(CONFIG.memberTable)
        .select('email,name,is_admin')
        .eq('email', api.email)
        .maybeSingle();

      // A failed request is not a revocation — the network drops, the roster
      // does not. Only an answered query with no row means removed.
      if (error) return 'unknown';
      row = data;
    } catch (_) {
      return 'unknown';
    }

    if (!row) return 'revoked';

    api.signedIn = true;
    api.isAdmin = !!row.is_admin;
    if (row.name) api.displayName = row.name;

    // Stamp last_seen_at so the roster shows who is actually still using it.
    try { await client.rpc('rc_touch'); } catch (_) { /* cosmetic */ }

    return 'ok';
  }

  async function signOut() {
    try {
      const c = await getClient();
      await c.auth.signOut();
    } catch (_) { /* leaving anyway */ }
    location.replace(CONFIG.loginPage);
  }

  /* ------------------------------------------------------------------ boot */

  async function start() {
    let c;
    try {
      c = await withTimeout(getClient(), 12000, 'Loading the sign-in library');
    } catch (e) {
      // The CDN is unreachable. Redirecting would only bounce to a login page
      // that cannot work either, so unlock and let the comment panel report
      // it. The receipt stays readable and printable; comments stay shut,
      // because the database still refuses an unauthenticated request.
      api.error = 'Could not load the sign-in library: ' + msgOf(e);
      unlock();
      return api;
    }

    let session = null;
    let lookupFailed = false;
    try {
      const { data } = await c.auth.getSession();
      session = (data && data.session) || null;
    } catch (e) {
      api.error = msgOf(e);
      lookupFailed = true;
    }

    // Offline, or Supabase briefly unreachable, while this computer still
    // holds a signed-in session. Bouncing to a login page that cannot send
    // an email either would just strand the reader, so let the receipt open
    // and let the comment panel report why it is empty. Nothing is exposed:
    // the stored token is never trusted by the database, only by this check.
    if (!session && lookupFailed && hasStoredSession()) {
      api.error = 'Offline — signed in, but comments cannot load right now.';
      unlock();
      return api;
    }

    if (session && !isAllowedEmail(session.user && session.user.email)) {
      await c.auth.signOut();          // signed up before the domain rule
      session = null;
      if (IS_LOGIN) {
        api.error = 'domain';
      } else {
        toLogin('domain');
        return api;
      }
    }

    if (!session) {
      if (!IS_LOGIN) {
        toLogin();
        return api;
      }
      unlock();
      return api;
    }

    const status = await adopt(session);

    // Removed from the roster while signed in. The database has already shut
    // them out; this just tells them why instead of showing an empty page.
    if (status === 'revoked') {
      await c.auth.signOut();
      if (IS_LOGIN) {
        api.error = 'revoked';
        unlock();
        return api;
      }
      toLogin('revoked');
      return api;
    }

    if (status === 'unknown') {
      api.error = 'Could not check your access right now.';
      unlock();
      return api;
    }

    unlock();

    c.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') toLogin('expired');
    });

    if (!IS_LOGIN) mountChip();
    document.dispatchEvent(new CustomEvent('rc-auth-ready', { detail: api }));
    return api;
  }

  /* -------------------------------------------------------- signed-in chip
     Only the homepage has a header to hang it on. On receipts the same
     information sits in the comments rail footer instead. */

  function mountChip() {
    const place = () => {
      const host = document.querySelector('.header-right');
      if (!host || host.querySelector('.rc-who')) return;

      if (!document.querySelector('link[href="assets/auth.css"]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'assets/auth.css';
        document.head.appendChild(link);
      }

      const chip = document.createElement('div');
      chip.className = 'rc-who';

      const name = document.createElement('span');
      name.className = 'rc-who-name';
      name.textContent = api.displayName;
      name.title = api.email + (api.isAdmin ? ' · admin' : '');

      const out = document.createElement('button');
      out.type = 'button';
      out.className = 'rc-who-out';
      out.textContent = 'Sign out';
      out.addEventListener('click', signOut);

      chip.appendChild(name);
      chip.appendChild(out);
      host.insertBefore(chip, host.firstChild);
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', place);
    } else {
      place();
    }
  }

  api.ready = start();
  window.receiptAuth = api;
})();
