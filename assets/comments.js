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

  const CONFIG = {
    // Fill these in from your Supabase project: Settings → API.
    // The anon key is meant to be public; access is governed by the RLS
    // policies on the comments table (see README-comments.md).
    url: '',
    anonKey: '',
    table: 'comments',
    clientModule: 'https://esm.sh/@supabase/supabase-js@2'
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

  const state = {
    threads: [],          // [{root, replies:[], anchor:{...}, el, pin, n}]
    armed: false,
    railOpen: true,
    author: localStorage.getItem('rc-author') || '',
    activeId: null,
    supabase: null,
    error: null,
    pending: null         // anchor awaiting its first comment
  };

  let page, pinLayer, rail, railBody, toggle;
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

  /* -------------------------------------------------------------- supabase */

  async function connect() {
    if (!CONFIG.url || !CONFIG.anonKey) {
      state.error =
        'Not connected yet. Add your Supabase URL and anon key at the top of ' +
        'assets/comments.js to start collecting comments.';
      return null;
    }
    try {
      const mod = await import(CONFIG.clientModule);
      state.supabase = mod.createClient(CONFIG.url, CONFIG.anonKey, {
        auth: { persistSession: false }
      });
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

    if (state.pending) {
      railBody.appendChild(composer(state.pending, null));
    }

    const live = state.threads.filter((t) => !t.orphan);
    const lost = state.threads.filter((t) => t.orphan);

    if (!state.threads.length && !state.pending) {
      railBody.appendChild(el(
        'div', 'rc-empty',
        'No comments yet.<br>Turn on <b>Comment mode</b> and click any field ' +
        'on the receipt to leave one.'
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

    drawPins();
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
    const done = el('button', 'rc-link rc-done', t.root.resolved ? 'Reopen' : 'Resolve');
    done.type = 'button';
    done.addEventListener('click', () => toggleResolved(t.root));
    foot.appendChild(reply);
    foot.appendChild(done);
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

  function composer(anchor, parentId) {
    const box = el('div', 'rc-composer');
    const ta = el('textarea');
    ta.placeholder = parentId ? 'Reply…' : 'Comment on this field…';
    box.appendChild(ta);

    const row = el('div', 'rc-composer-row');
    row.appendChild(el(
      'span', 'rc-composer-who',
      state.author ? 'as ' + esc(state.author) : 'you will be asked for a name'
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
      const author = askAuthor();
      if (!author) return;
      send.disabled = true;

      const row2 = Object.assign(
        { receipt, author, body, parent_id: parentId || null },
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

  function askAuthor() {
    if (state.author) return state.author;
    const name = (window.prompt('Your name (shown on your comments):') || '').trim();
    if (!name) return null;
    state.author = name;
    localStorage.setItem('rc-author', name);
    return name;
  }

  /* ------------------------------------------------------------ comment mode */

  function arm(on) {
    state.armed = on;
    document.documentElement.classList.toggle('rc-armed', on);
    toggle.setAttribute('data-armed', String(on));
    toggle.querySelector('.rc-toggle-label').textContent =
      on ? 'Click a field…' : 'Comment mode';

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

    const link = el('link');
    link.rel = 'stylesheet';
    link.href = 'assets/comments.css';
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
      '<span class="rc-toggle-label">Comment mode</span>' +
      '<span class="rc-toggle-count" data-n="0"></span>');
    toggle.id = 'rc-toggle';
    toggle.type = 'button';
    // Inline, so these never join body's flex flow even if comments.css is
    // missing or blocked. 19 of the receipts make body a flex row, and an
    // in-flow rail would squeeze the A4 page — including in print.
    toggle.style.position = 'fixed';
    toggle.addEventListener('click', () => {
      if (!state.railOpen) { openRail(true); render(); return; }
      arm(!state.armed);
    });

    rail = el('aside');
    rail.id = 'rc-rail';
    rail.style.position = 'fixed';
    const head = el('div', 'rc-rail-head');
    head.appendChild(el('div', 'rc-rail-title', 'Comments'));
    head.appendChild(el('div', 'rc-rail-sub', esc(receipt)));
    head.appendChild(el(
      'div', 'rc-rail-hint',
      'Turn on <b>Comment mode</b>, then click a field to pin a note. ' +
      'Printing and PDF export are unaffected.'
    ));
    const close = el('button', 'rc-link', 'Hide panel');
    close.type = 'button';
    close.style.marginTop = '10px';
    close.addEventListener('click', () => { arm(false); openRail(false); });
    head.appendChild(close);

    railBody = el('div', 'rc-rail-body');
    rail.appendChild(head);
    rail.appendChild(railBody);

    document.body.appendChild(toggle);
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
    connect().then((c) => { if (c) { load(); subscribe(); } else { render(); } });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
