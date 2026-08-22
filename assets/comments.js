/* ==========================================================================
   Receipt comments — pinned review comments backed by Supabase.

   Drop one tag before </body> of any receipt:
       <script defer src="assets/comments.js"></script>

   Everything this file adds to the DOM lives outside .page (rail, toggle)
   or inside a pointer-transparent overlay (pins), and all of it is removed
   by the print block in comments.css. The A4 artwork is never restyled.
   ========================================================================== */

(function () {
  'use strict';

  /* ---------------------------------------------------------------- config */

  // The connection and the identity both come from assets/auth.js, which
  // every receipt loads first. Only the table name lives here now.
  const CONFIG = {
    table: 'comments'
  };

  const RAIL_WIDTH = 340;

  // What a reviewer is allowed to pin a comment to. Ordered most specific
  // first so the innermost match wins.
  const TARGETS = [
    '.info-row',
    '.info-group',
    '.detail-table td',
    '.detail-table th',
    '.section-header',
    '.title-box',
    '.footer',
    '.header'
  ];

  /* ----------------------------------------------------------------- state */

  const receipt = decodeURIComponent(
    location.pathname.split('/').pop() || 'unknown.html'
  );

  // Agency_Banking_Cashin_Receipt_Business_Merchant.html
  //   -> Agency Banking Cashin Business
  // Only a TRAILING Merchant/Consumer is dropped, so "Merchant to Bank"
  // keeps the word where it is part of the receipt's actual name.
  const receiptName = (() => {
    const parts = receipt.replace(/\.html$/i, '').split(/[_\s]+/).filter(Boolean);
    const last = (parts[parts.length - 1] || '').toLowerCase();
    if (last === 'merchant' || last === 'consumer') parts.pop();
    return parts.filter((w) => w.toLowerCase() !== 'receipt').join(' ');
  })();

  const state = {
    threads: [],          // [{root, replies:[], anchor:{...}, el, pin, n}]
    armed: false,
    railOpen: true,
    author: '',           // display name, derived from the signed-in email
    email: '',
    activeId: null,
    supabase: null,
    error: null,
    pending: null,        // anchor awaiting its first comment
    admin: false,         // mirrors the admins table; the policies re-check it
    notice: null          // transient message shown in the rail
  };

  let page, pinLayer, rail, railBody, railFoot, toggle, handle, nav, prevBtn, nextBtn;
  let navRail, navHandle, tip, tipTimer, tipCycle;

  const CHEV = {
    left: '15 18 9 12 15 6',
    right: '9 18 15 12 9 6',
    down: '6 9 12 15 18 9'
  };

  const chevron = (dir) =>
    '<svg class="rc-chev" viewBox="0 0 24 24" aria-hidden="true"><polyline points="' +
    (CHEV[dir] || CHEV.right) + '"/></svg>';
  let rawRows = [];   // last rows from the server, kept for re-layout on resize

  /* --------------------------------------------------------------- helpers */

  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  function timeAgo(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    const m = s / 60;
    if (m < 60) return Math.floor(m) + 'm ago';
    const h = m / 60;
    if (h < 24) return Math.floor(h) + 'h ago';
    const d = h / 24;
    if (d < 7) return Math.floor(d) + 'd ago';
    return new Date(iso).toLocaleDateString();
  }

  /* ------------------------------------------------------------- anchoring
     Three anchors are stored per comment and resolved in order. Receipts get
     edited a lot — rows are reordered, labels renamed, fields deleted — so a
     single selector would orphan comments constantly.
       1. label text  — survives reordering (the most common edit)
       2. css path    — survives renaming
       3. x/y percent — always resolvable, used to place orphans
     ------------------------------------------------------------------- */

  function labelOf(node) {
    const lbl = node.querySelector('.info-label, .label, .amharic');
    const text = (lbl ? lbl.textContent : node.textContent) || '';
    return text.replace(/\s+/g, ' ').trim().slice(0, 120);
  }

  function pathOf(node) {
    const parts = [];
    let cur = node;
    while (cur && cur !== page && parts.length < 12) {
      const parent = cur.parentElement;
      if (!parent) break;
      const tag = cur.tagName.toLowerCase();
      const sibs = Array.from(parent.children).filter(
        (c) => c.tagName === cur.tagName
      );
      parts.unshift(tag + ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')');
      cur = parent;
    }
    return parts.join('>');
  }

  function anchorFor(node) {
    const p = page.getBoundingClientRect();
    const r = node.getBoundingClientRect();
    return {
      anchor_label: labelOf(node),
      anchor_path: pathOf(node),
      anchor_x: ((r.left - p.left) / p.width) * 100,
      anchor_y: ((r.top - p.top + r.height / 2) / p.height) * 100
    };
  }

  // Latin tokens only — the Amharic half rarely survives a rename intact and
  // the English half is what actually identifies a field.
  function tokens(s) {
    return new Set(
      String(s || '').toUpperCase().match(/[A-Z0-9]+/g) || []
    );
  }

  // Jaccard overlap, used to sanity-check a css-path hit.
  function similarity(a, b) {
    const A = tokens(a), B = tokens(b);
    if (!A.size || !B.size) return 0;
    let shared = 0;
    A.forEach((t) => { if (B.has(t)) shared += 1; });
    return shared / (A.size + B.size - shared);
  }

  function resolveAnchor(a) {
    // 1. label text — survives reordering, the most common edit
    if (a.anchor_label) {
      const wanted = a.anchor_label.replace(/\s+/g, ' ').trim();
      const nodes = page.querySelectorAll(TARGETS.join(','));
      for (const n of nodes) {
        if (labelOf(n) === wanted) return { node: n, orphan: false };
      }
    }

    // 2. css path — survives renaming. :scope keeps the chain anchored to
    //    .page's own children rather than matching the shape anywhere.
    //
    //    A stale path often still resolves, just to a DIFFERENT field — if a
    //    row is moved, the old position is now someone else's. Pinning a
    //    comment to the wrong field is worse than losing the pin, so the hit
    //    only counts when the label still looks related.
    if (a.anchor_path) {
      try {
        const n = page.querySelector(':scope>' + a.anchor_path);
        if (n && similarity(a.anchor_label, labelOf(n)) >= 0.25) {
          return { node: n, orphan: false };
        }
      } catch (_) { /* stale selector, fall through */ }
    }

    // 3. coordinates — always resolvable, flagged so the rail can say so
    return { node: null, orphan: true };
  }

  /* ----------------------------------------------------------- the hint
     Shown on the switch rather than parked in the panel: a line of standing
     instructions gets read once and then becomes furniture. It surfaces on
     hover, and on its own every so often until comment mode has been used. */

  function showTip(on) {
    if (!tip) return;
    if (on && state.armed) return;               // nothing to explain mid-use
    tip.classList.toggle('rc-tip-on', on);
  }

  function startTipCycle() {
    if (localStorage.getItem('rc-tip-done') === '1') return;
    const pulse = () => {
      if (state.armed) return;
      showTip(true);
      tipTimer = setTimeout(() => { showTip(false); tipTimer = null; }, 5000);
    };
    setTimeout(pulse, 2500);
    tipCycle = setInterval(pulse, 30000);
  }

  function stopTipCycle() {
    clearInterval(tipCycle);
    clearTimeout(tipTimer);
    tipTimer = null;
    showTip(false);
    localStorage.setItem('rc-tip-done', '1');
  }

  /* ------------------------------------------------------ left nav sidebar
     A copy of the homepage list, so a reviewer can walk the whole set
     without going back to the index. Built from the same parsed array as
     Prev / Next, and like the rest of the furniture it is a sibling of
     .page and hidden in print. */

  function buildNavRail(list) {
    if (!list.length || navRail) return;

    navRail = el('aside');
    navRail.id = 'rc-nav-rail';
    navRail.style.position = 'fixed';

    const head = el('div', 'rc-nav-head');
    head.appendChild(el('div', 'rc-nav-title', 'Merchant Lite App Receipts'));
    navRail.appendChild(head);

    const body = el('div', 'rc-nav-body');

    // Exclusive accordion: only one section is open at a time. Opening one
    // folds the other away, and the state of the open section is remembered.
    const here = list.find((r) => r.file === receipt);
    const savedOpen = ['customer', 'business']
      .find((g) => localStorage.getItem('rc-nav-open-' + g) === 'true');
    const openGroup = here ? here.group : (savedOpen || 'customer');

    const groups = [['customer', 'Customer'], ['business', 'Merchant']];
    groups.forEach(([group, label]) => {
      const items = list.filter((r) => r.group === group);
      if (!items.length) return;

      const sec = el('div', 'rc-nav-sec');
      sec.dataset.group = group;
      const key = 'rc-nav-open-' + group;
      sec.dataset.open = String(group === openGroup);

      const btn = el('button', 'rc-nav-sec-head');
      btn.type = 'button';
      btn.innerHTML =
        '<span class="rc-nav-sec-name">' + esc(label) + '</span>' +
        '<span class="rc-nav-sec-count">' + items.length + '</span>' +
        chevron('down');
      btn.setAttribute('aria-expanded', sec.dataset.open);
      btn.addEventListener('click', () => {
        const open = sec.dataset.open !== 'true';
        // one at a time: opening a section folds the other away
        if (open) {
          navRail.querySelectorAll('.rc-nav-sec').forEach((other) => {
            if (other === sec) return;
            other.dataset.open = 'false';
            const ob = other.querySelector('.rc-nav-sec-head');
            if (ob) ob.setAttribute('aria-expanded', 'false');
            if (other.dataset.group) {
              localStorage.setItem('rc-nav-open-' + other.dataset.group, 'false');
            }
          });
        }
        sec.dataset.open = String(open);
        btn.setAttribute('aria-expanded', String(open));
        localStorage.setItem(key, String(open));
      });
      sec.appendChild(btn);

        const ul = el('div', 'rc-nav-list');
      items.forEach((r) => {
        const a = el('a', 'rc-nav-item');
        a.href = encodeURIComponent(r.file);
        a.title = r.file;
        if (r.file === receipt) {
          a.classList.add('rc-current');
          a.setAttribute('aria-current', 'page');
        }
        a.innerHTML = '<span class="rc-nav-item-name">' + esc(r.name) + '</span>' +
                      chevron('right');
        ul.appendChild(a);
      });
      sec.appendChild(ul);
      body.appendChild(sec);
    });

    navRail.appendChild(body);

    navHandle = el('button', null,
      chevron('left') + '<span class="rc-handle-label">Receipts</span>');
    navHandle.id = 'rc-nav-handle';
    navHandle.type = 'button';
    navHandle.style.position = 'fixed';
    navHandle.title = 'Hide or show the receipt list';
    navHandle.addEventListener('click', () => openNav(
      !document.documentElement.classList.contains('rc-has-nav')
    ));

    document.body.appendChild(navHandle);
    document.body.appendChild(navRail);

    // Both rails plus a 793.7px page need roughly 1480px; below that the
    // list starts tucked away rather than squeezing the receipt.
    openNav(window.innerWidth >= 1480);

    const current = navRail.querySelector('.rc-current');
    if (current) current.scrollIntoView({ block: 'nearest' });
  }

  function openNav(on) {
    document.documentElement.classList.toggle('rc-has-nav', on);
  }

  /* ------------------------------------------------------ prev / next nav
     The running order comes from index.html's own receipts array, so the
     panel walks the list in the same sequence the homepage shows. Disabled
     entries are skipped because they are not reachable from the homepage
     either. If the index cannot be read the two buttons simply stay off. */

  // The list used to come from a live fetch of index.html, which browsers
  // block when a receipt is opened straight from disk (file://). The
  // canonical list now lives in assets/receipts.js as a plain <script> —
  // loadable from file:// as well as http — so prefer it and keep the
  // fetch only as a fallback for deployments that predate the file.
  function receiptList() {
    return new Promise((resolve) => {
      if (Array.isArray(window.RECEIPTS)) { resolve(window.RECEIPTS); return; }
      const script = el('script');
      script.src = 'assets/receipts.js';
      script.onload = () => resolve(
        Array.isArray(window.RECEIPTS) ? window.RECEIPTS : null
      );
      script.onerror = () => resolve(null);
      document.head.appendChild(script);
    });
  }

  async function loadSiblings() {
    let list = (await receiptList()) || [];

    if (!list.length) {
      // Old deployment without assets/receipts.js: read the homepage's
      // inline array the way the feature originally did.
      let text;
      try {
        const res = await fetch('index.html', { cache: 'no-cache' });
        if (!res.ok) return;
        text = await res.text();
      } catch (_) { return; }
      const re = /\{\s*name:\s*'([^']+)',\s*file:\s*'([^']+)',\s*group:\s*'(\w+)'[^}]*\}/g;
      let m;
      while ((m = re.exec(text))) {
        if (/disabled:\s*true/.test(m[0])) continue;
        list.push({ name: m[1], file: m[2], group: m[3] });
      }
    }

    list = list.filter((r) => r && !r.disabled);
    if (!list.length) return;

    buildNavRail(list);

    const here = list.findIndex((r) => r.file === receipt);
    if (here === -1) return;

    const wire = (btn, target) => {
      if (!target) { btn.disabled = true; return; }
      btn.disabled = false;
      btn.title = target.name;
      const pre = el('link');
      pre.rel = 'prefetch';
      pre.href = encodeURIComponent(target.file);
      document.head.appendChild(pre);
      btn.addEventListener('click', () => {
        location.href = encodeURIComponent(target.file);
      });
    };
    wire(prevBtn, list[here - 1]);
    wire(nextBtn, list[here + 1]);
  }

  /* --------------------------------------------------------------- notices */

  function flash(msg) {
    state.notice = msg;
    render();
    clearTimeout(flash.t);
    flash.t = setTimeout(() => { state.notice = null; render(); }, 4000);
  }

  /* -------------------------------------------------------------- supabase

     assets/auth.js owns the client and the session. By the time its ready
     promise settles the visitor is either signed in or already being sent to
     login.html, so there is no anonymous path through here. */

  async function connect() {
    const auth = window.receiptAuth;
    if (!auth) {
      state.error =
        'Sign-in is not loaded. Add <script src="assets/auth.js"></script> to ' +
        'the head of this receipt.';
      return null;
    }

    await auth.ready;

    if (!auth.signedIn) {
      state.error = auth.error ||
        'Not signed in — comments are hidden until you sign in.';
      return null;
    }

    state.author = auth.displayName;
    state.email = auth.email;
    state.admin = auth.isAdmin;

    try {
      state.supabase = await auth.getClient();
      return state.supabase;
    } catch (e) {
      state.error = 'Could not reach Supabase: ' + (e && e.message ? e.message : e);
      return null;
    }
  }

  async function load() {
    if (!state.supabase) return;
    const { data, error } = await state.supabase
      .from(CONFIG.table)
      .select('*')
      .eq('receipt', receipt)
      .order('created_at', { ascending: true });

    if (error) { state.error = error.message; render(); return; }
    state.error = null;
    build(data || []);
    render();
  }

  async function insert(row) {
    if (!state.supabase) {
      state.error = 'Not connected — this comment was not saved.';
      render();
      return null;
    }
    const { data, error } = await state.supabase
      .from(CONFIG.table)
      .insert(row)
      .select()
      .single();
    if (error) { state.error = error.message; render(); return null; }
    return data;
  }

  function subscribe() {
    if (!state.supabase) return;
    state.supabase
      .channel('rc-' + receipt)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: CONFIG.table },
        (payload) => {
          const row = payload.new || payload.old;
          if (row && row.receipt === receipt) load();
        }
      )
      .subscribe();
  }

  /* ---------------------------------------------------------------- model */

  function build(rows) {
    rawRows = rows;
    const roots = rows.filter((r) => !r.parent_id);
    const byParent = new Map();
    rows.filter((r) => r.parent_id).forEach((r) => {
      if (!byParent.has(r.parent_id)) byParent.set(r.parent_id, []);
      byParent.get(r.parent_id).push(r);
    });

    state.threads = roots.map((root) => {
      const found = resolveAnchor(root);
      return {
        root,
        replies: byParent.get(root.id) || [],
        node: found.node,
        orphan: found.orphan
      };
    });

    // Order by where the pin actually sits on the page, top to bottom.
    const pRect = page.getBoundingClientRect();
    state.threads.forEach((t) => {
      if (t.node) {
        const r = t.node.getBoundingClientRect();
        t.y = ((r.top - pRect.top + r.height / 2) / pRect.height) * 100;
        t.x = ((r.left - pRect.left) / pRect.width) * 100;
      } else {
        t.y = t.root.anchor_y || 0;
        t.x = t.root.anchor_x || 0;
      }
    });
    state.threads.sort((a, b) => (a.orphan - b.orphan) || (a.y - b.y));
    state.threads.forEach((t, i) => { t.n = i + 1; });
  }

  /* ----------------------------------------------------------------- pins */

  function drawPins() {
    pinLayer.textContent = '';
    state.threads.forEach((t) => {
      const pin = el('button', 'rc-pin', String(t.n));
      pin.type = 'button';
      pin.style.left = t.x + '%';
      pin.style.top = t.y + '%';
      pin.title = t.root.anchor_label || 'comment';
      if (t.root.resolved) pin.classList.add('rc-resolved');
      if (t.orphan) pin.classList.add('rc-orphan');
      if (t.root.id === state.activeId) pin.classList.add('rc-active');
      pin.addEventListener('click', (e) => {
        e.stopPropagation();
        focusThread(t.root.id, true);
      });
      pinLayer.appendChild(pin);
    });
  }

  function focusThread(id, fromPin) {
    state.activeId = id;
    render();
    const card = railBody.querySelector('[data-thread="' + id + '"]');
    if (card && fromPin) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (!fromPin) {
      const t = state.threads.find((x) => x.root.id === id);
      if (t && t.node) {
        t.node.classList.add('rc-flash');
        setTimeout(() => t.node.classList.remove('rc-flash'), 1200);
        t.node.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }

  /* ----------------------------------------------------------------- rail */

  function render() {
    railBody.textContent = '';

    if (state.error) {
      railBody.appendChild(el('div', 'rc-status rc-error', esc(state.error)));
    }

    if (state.notice) {
      railBody.appendChild(el('div', 'rc-status rc-notice', esc(state.notice)));
    }

    if (state.pending) {
      railBody.appendChild(composer(state.pending, null));
    }

    const live = state.threads.filter((t) => !t.orphan);
    const lost = state.threads.filter((t) => t.orphan);

    if (!state.threads.length && !state.pending) {
      railBody.appendChild(el(
        'div', 'rc-empty',
        '<svg class="rc-empty-icon" viewBox="0 0 48 48" aria-hidden="true">' +
        '<path d="M9 10.5h30a4.5 4.5 0 0 1 4.5 4.5v15a4.5 4.5 0 0 1-4.5 4.5H22.8' +
        'L13.5 41v-6.5H9A4.5 4.5 0 0 1 4.5 30V15A4.5 4.5 0 0 1 9 10.5z"/>' +
        '<line x1="8" y1="41.5" x2="40" y2="7.5"/></svg>' +
        '<div class="rc-empty-title">No comments yet.</div>' +
        '<div class="rc-empty-sub">Click any field on the receipt to leave one.</div>'
      ));
    }

    live.forEach((t) => railBody.appendChild(threadCard(t)));

    if (lost.length) {
      railBody.appendChild(el('div', 'rc-group-label', 'Field changed'));
      lost.forEach((t) => railBody.appendChild(threadCard(t)));
    }

    const open = state.threads.filter((t) => !t.root.resolved).length;
    const badge = toggle.querySelector('.rc-toggle-count');
    badge.textContent = open ? String(open) : '';
    badge.setAttribute('data-n', String(open));

    renderFoot();
    drawPins();
  }

  // Who you are posting as, at the bottom of the rail. The homepage shows the
  // same thing as a chip in its header (see mountChip in assets/auth.js).
  function renderFoot() {
    if (!railFoot) return;
    railFoot.textContent = '';
    if (!state.author) return;

    const who = el('span', 'rc-foot-who',
      esc(state.author) +
      (state.admin ? '<span class="rc-foot-tag">admin</span>' : ''));
    who.title = state.email;

    const out = el('button', 'rc-foot-out', 'Sign out');
    out.type = 'button';
    out.addEventListener('click', () => {
      if (window.receiptAuth) window.receiptAuth.signOut();
    });

    railFoot.appendChild(who);
    railFoot.appendChild(out);
  }

  function threadCard(t) {
    const card = el('div', 'rc-thread');
    card.setAttribute('data-thread', t.root.id);
    if (t.root.resolved) card.classList.add('rc-resolved');
    if (t.root.id === state.activeId) card.classList.add('rc-active');

    const head = el('div', 'rc-thread-head');
    head.appendChild(el('span', 'rc-thread-num', String(t.n)));
    head.appendChild(el(
      'span', 'rc-thread-anchor',
      esc(t.root.anchor_label || 'On the page') +
      (t.orphan
        ? '<span class="rc-thread-orphan">this field has changed since the comment</span>'
        : '')
    ));
    head.addEventListener('click', () => focusThread(t.root.id, false));
    card.appendChild(head);

    [t.root].concat(t.replies).forEach((c, i) => {
      const box = el('div', 'rc-comment' + (i ? ' rc-reply' : ''));
      const meta = el('div', 'rc-meta');
      meta.appendChild(el('span', 'rc-author', esc(c.author)));
      meta.appendChild(el('span', 'rc-time', esc(timeAgo(c.created_at))));
      box.appendChild(meta);
      box.appendChild(el('div', 'rc-body', esc(c.body)));
      card.appendChild(box);
    });

    const foot = el('div', 'rc-thread-foot');
    const reply = el('button', 'rc-link', 'Reply');
    reply.type = 'button';
    reply.addEventListener('click', () => {
      if (card.querySelector('.rc-composer')) return;
      card.appendChild(composer(null, t.root.id));
      card.querySelector('textarea').focus();
    });
    foot.appendChild(reply);

    // Resolve and Delete belong to the admins listed in the database. Others
    // never see the buttons — and could not use them anyway, since the update
    // and delete policies check the same table.
    if (state.admin) {
      const label = t.root.resolved ? 'Reopen' : 'Resolve';
      const done = el('button', 'rc-link rc-done', label);
      done.type = 'button';
      done.addEventListener('click', () => toggleResolved(t.root));

      const del = el('button', 'rc-link rc-del', 'Delete');
      del.type = 'button';
      del.addEventListener('click', () => {
        const n = t.replies.length;
        const msg = n
          ? 'Delete this comment and its ' + n + (n === 1 ? ' reply?' : ' replies?')
          : 'Delete this comment?';
        if (window.confirm(msg)) removeThread(t.root);
      });

      foot.appendChild(done);
      foot.appendChild(del);
    }

    card.appendChild(foot);

    return card;
  }

  async function toggleResolved(root) {
    const next = !root.resolved;
    root.resolved = next;                 // optimistic
    render();
    if (!state.supabase) return;
    const { error } = await state.supabase
      .from(CONFIG.table)
      .update({ resolved: next })
      .eq('id', root.id);
    if (error) { state.error = error.message; render(); }
  }

  async function removeThread(root) {
    if (!state.supabase) { flash('Not connected — nothing was deleted.'); return; }
    // replies cascade via the parent_id foreign key
    const { error } = await state.supabase
      .from(CONFIG.table)
      .delete()
      .eq('id', root.id);
    if (error) { state.error = error.message; render(); return; }
    if (state.activeId === root.id) state.activeId = null;
    await load();
  }

  function composer(anchor, parentId) {
    const box = el('div', 'rc-composer');
    const ta = el('textarea');
    ta.placeholder = parentId ? 'Reply…' : 'Comment on this field…';
    box.appendChild(ta);

    const row = el('div', 'rc-composer-row');
    row.appendChild(el(
      'span', 'rc-composer-who',
      state.author ? 'as ' + esc(state.author) : 'not signed in'
    ));

    const actions = el('div');
    actions.style.display = 'flex';
    actions.style.gap = '6px';

    const cancel = el('button', 'rc-btn rc-btn-ghost', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      if (anchor) { state.pending = null; render(); } else { box.remove(); }
    });

    const send = el('button', 'rc-btn', parentId ? 'Reply' : 'Comment');
    send.type = 'button';
    send.addEventListener('click', async () => {
      const body = ta.value.trim();
      if (!body) return;
      const auth = window.receiptAuth;
      if (!auth || !auth.signedIn) {
        flash('You are not signed in — this comment was not saved.');
        return;
      }
      send.disabled = true;

      // user_id and author_email are not decoration: the insert policy
      // requires both to match the signed-in session, so a forged author
      // is rejected by Postgres rather than trusted.
      const row2 = Object.assign(
        {
          receipt,
          author: auth.displayName,
          author_email: auth.email,
          user_id: auth.user.id,
          body,
          parent_id: parentId || null
        },
        anchor || {}
      );
      const saved = await insert(row2);
      send.disabled = false;
      if (!saved) return;

      state.pending = null;
      if (state.supabase) await load();
      state.activeId = parentId || (saved && saved.id) || null;
      render();
    });

    actions.appendChild(cancel);
    actions.appendChild(send);
    row.appendChild(actions);
    box.appendChild(row);

    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send.click();
    });

    return box;
  }

  /* ------------------------------------------------------------ comment mode */

  function arm(on) {
    if (on) stopTipCycle();
    state.armed = on;
    document.documentElement.classList.toggle('rc-armed', on);
    toggle.setAttribute('data-armed', String(on));
    toggle.querySelector('.rc-toggle-label').textContent =
      on ? 'Comment Mode On' : 'Comment Mode Off';

    page.querySelectorAll('.rc-commentable').forEach(
      (n) => n.classList.remove('rc-commentable')
    );
    if (!on) return;

    page.querySelectorAll(TARGETS.join(',')).forEach((n) => {
      // Skip a container when one of its own descendants is also a target,
      // so the click lands on the most specific field.
      if (n.querySelector(TARGETS.join(','))) return;
      n.classList.add('rc-commentable');
    });
  }

  function onPageClick(e) {
    if (!state.armed) return;
    const node = e.target.closest('.rc-commentable');
    if (!node) return;
    e.preventDefault();
    e.stopPropagation();
    state.pending = anchorFor(node);
    openRail(true);
    render();
    const ta = railBody.querySelector('.rc-composer textarea');
    if (ta) ta.focus();
    arm(false);
  }

  function openRail(on) {
    state.railOpen = on;
    document.documentElement.classList.toggle('rc-has-rail', on);
  }

  /* ------------------------------------------------------------------ boot */

  function mount() {
    page = document.querySelector('.page');
    if (!page) return;                    // not a receipt page

    // The rail is built before comments.css can possibly have loaded, so it
    // would paint unstyled for a frame and then snap into place — the flash
    // seen when stepping between receipts. Keep the furniture invisible until
    // the stylesheet is in, then enable transitions one frame later so the
    // panel does not slide in from off-screen on every page load.
    const link = el('link');
    link.rel = 'stylesheet';
    link.href = 'assets/comments.css';
    const ready = () => {
      document.documentElement.classList.add('rc-css-ready');
      requestAnimationFrame(() => {
        requestAnimationFrame(
          () => document.documentElement.classList.add('rc-anim')
        );
      });
    };
    link.addEventListener('load', ready);
    link.addEventListener('error', ready);      // never leave the rail hidden
    setTimeout(ready, 1500);                    // and never wait forever
    document.head.appendChild(link);

    document.documentElement.style.setProperty('--rc-rail-w', RAIL_WIDTH + 'px');

    // .page is position:relative in every receipt, so the layer can sit inside
    // it — but .page is also a flex column, so these must be inline: an
    // in-flow child would consume space and push the footer's margin-top:auto.
    pinLayer = el('div', 'rc-pin-layer');
    pinLayer.style.position = 'absolute';
    pinLayer.style.inset = '0';
    pinLayer.style.pointerEvents = 'none';
    page.appendChild(pinLayer);

    toggle = el('button', null,
      '<span class="rc-toggle-label">Comment Mode Off</span>' +
      '<span class="rc-toggle-count" data-n="0"></span>');
    toggle.id = 'rc-toggle';
    toggle.type = 'button';
    // Inline, so these never join body's flex flow even if comments.css is
    // missing or blocked. 19 of the receipts make body a flex row, and an
    // in-flow rail would squeeze the A4 page — including in print.
    toggle.addEventListener('click', () => arm(!state.armed));

    tip = el('div', 'rc-tip',
      'Turn on <b>Comment Mode</b>, then click a field you want to comment.');
    tip.setAttribute('role', 'tooltip');

    toggle.addEventListener('mouseenter', () => showTip(true));
    toggle.addEventListener('mouseleave', () => { if (!tipTimer) showTip(false); });

    rail = el('aside');
    rail.id = 'rc-rail';
    rail.style.position = 'fixed';
    const head = el('div', 'rc-rail-head');
    // The receipt this panel belongs to, stated first as the big title.
    head.appendChild(el('div', 'rc-rail-name', esc(receiptName)));

    const toggleWrap = el('div', 'rc-toggle-wrap');
    toggleWrap.appendChild(toggle);
    toggleWrap.appendChild(tip);
    head.appendChild(toggleWrap);

    // previous / next receipt, filled in once the index has been read
    nav = el('div', 'rc-nav');
    prevBtn = el('button', 'rc-nav-btn', chevron('left') + '<span>Prev</span>');
    nextBtn = el('button', 'rc-nav-btn', '<span>Next</span>' + chevron('right'));
    prevBtn.type = nextBtn.type = 'button';
    prevBtn.disabled = nextBtn.disabled = true;
    nav.appendChild(prevBtn);
    nav.appendChild(nextBtn);
    head.appendChild(nav);

    // The big "Comments" heading, sitting below the navigations.
    head.appendChild(el('div', 'rc-rail-title', 'Comments'));

    railBody = el('div', 'rc-rail-body');
    railFoot = el('div', 'rc-rail-foot');
    rail.appendChild(head);
    rail.appendChild(railBody);
    rail.appendChild(railFoot);

    handle = el('button', null,
      chevron('right') + '<span class="rc-handle-label">Open Comments</span>');
    handle.id = 'rc-handle';
    handle.type = 'button';
    handle.style.position = 'fixed';
    handle.title = 'Hide or show the comments panel';
    handle.addEventListener('click', () => {
      const open = !document.documentElement.classList.contains('rc-has-rail');
      if (!open) arm(false);
      openRail(open);
    });

    document.body.appendChild(handle);
    document.body.appendChild(rail);

    // Open by default only when there is room for the page and the rail
    // side by side; on narrower screens it starts hidden behind the toggle.
    openRail(window.innerWidth >= 1180);
    document.addEventListener('click', onPageClick, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { arm(false); state.pending = null; render(); }
    });
    window.addEventListener('resize', () => { build(rawRows); render(); });

    // Small public handle for debugging: inspect state, force a reload, or
    // check how an anchor resolves after the receipt has been edited.
    window.receiptComments = {
      state, receipt, reload: load,
      anchorFor, resolveAnchor, targets: TARGETS.join(',')
    };

    render();
    startTipCycle();
    loadSiblings();
    connect().then((c) => { if (c) { load(); subscribe(); } else { render(); } });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
