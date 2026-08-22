/* ==========================================================================
   Homepage comment badges.

   Adds an open-comment count to each receipt row on index.html. Reads the
   same Supabase table as assets/comments.js and decorates rows after they
   are rendered, so index.html's own list logic (disabled rows, not-applicable
   rows, counts) is untouched.
   ========================================================================== */

(function () {
  'use strict';

  // The connection and the session come from assets/auth.js, which index.html
  // loads first. Only the table name lives here now.
  const CONFIG = {
    table: 'comments'
  };

  const CSS = `
    .rc-count {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-left: 8px;
      padding: 2px 7px;
      border-radius: 999px;
      background: #FFF1F2;
      color: #C41520;
      font-family: 'Switzer', 'Inter', sans-serif;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.3px;
      white-space: nowrap;
      vertical-align: middle;
    }
    .rc-count.rc-count-none { background: #F1F1F4; color: #7C7C87; }
    .receipt-item.missing .rc-count,
    .receipt-item.disabled .rc-count { display: none; }
  `;

  function style() {
    const s = document.createElement('style');
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function paint(tally) {
    document.querySelectorAll('a.receipt-item[href]').forEach((row) => {
      const file = decodeURIComponent(row.getAttribute('href'));
      const t = tally.get(file);
      if (!t || !t.open) return;               // only flag rows with open feedback

      const name = row.querySelector('.receipt-name');
      if (!name || name.querySelector('.rc-count')) return;

      const badge = document.createElement('span');
      badge.className = 'rc-count';
      badge.textContent = t.open + (t.open === 1 ? ' comment' : ' comments');
      badge.title =
        t.total + ' total, ' + t.open + ' open, ' + (t.total - t.open) + ' resolved';
      name.appendChild(badge);
    });
  }

  async function run() {
    const auth = window.receiptAuth;
    if (!auth) return;                            // sign-in not loaded: stay silent

    // No session means no counts — the select policy would return nothing
    // anyway, so there is no point asking.
    const who = await auth.ready;
    if (!who.signedIn) return;

    let client;
    try {
      client = await auth.getClient();
    } catch (_) { return; }

    const { data, error } = await client
      .from(CONFIG.table)
      .select('receipt,resolved,parent_id');
    if (error || !data) return;

    const tally = new Map();
    data.forEach((r) => {
      if (r.parent_id) return;                    // count threads, not replies
      if (!tally.has(r.receipt)) tally.set(r.receipt, { total: 0, open: 0 });
      const t = tally.get(r.receipt);
      t.total += 1;
      if (!r.resolved) t.open += 1;
    });

    style();
    paint(tally);
  }

  // index.html renders its lists from an inline script, so wait for that.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
