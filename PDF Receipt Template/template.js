/* ============================================================
   M-PESA receipt template - edit / update / download A4 PDF
   Standalone: no build step, no network needed.
   ============================================================ */
(function () {
  'use strict';

  var STORE_KEY = 'mpesa-receipt-eeu-customer-v1';
  var A4_W = 793.7;   // 210mm @ 96dpi
  var A4_H = 1122.5;  // 297mm @ 96dpi

  var receipt  = document.getElementById('receipt');
  var toast    = document.getElementById('toast');
  var btnEdit  = document.getElementById('btn-edit');
  var btnUpd   = document.getElementById('btn-update');
  var btnPrint = document.getElementById('btn-print');
  var btnDl    = document.getElementById('btn-download');
  var btnReset = document.getElementById('btn-reset');

  var fields = [].slice.call(receipt.querySelectorAll('[data-editable]'));
  var required = fields.filter(function (el) { return el.hasAttribute('data-required'); });
  var defaults = {};     // pristine template markup, per field
  var sampleText = {};   // pristine text, used to spot fields nobody filled in
  var editing = false;

  /* ---------- 1. use the inlined (base64) assets when available ----------
     Browsers refuse to read local images into a canvas when the page is
     opened straight from disk (file://), which would break the PDF export.
     assets/assets-inline.js carries base64 copies of everything in ./assets. */
  function inlineAssets() {
    var map = window.RECEIPT_ASSETS;
    if (!map) return;
    [].forEach.call(receipt.querySelectorAll('img[src]'), function (img) {
      var key = img.getAttribute('src');
      if (map[key]) img.src = map[key];
    });
  }

  /* ---------- 2. persistence ---------- */
  function key(el, i) { return el.getAttribute('data-field') || ('f' + i); }

  function snapshotDefaults() {
    fields.forEach(function (el, i) {
      defaults[key(el, i)] = el.innerHTML;
      sampleText[key(el, i)] = el.textContent.replace(/\s+/g, ' ').trim();
    });
  }

  function save() {
    var data = {};
    fields.forEach(function (el, i) { data[key(el, i)] = el.innerHTML; });
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(data));
      return true;
    } catch (e) {
      return false; // private mode / storage disabled - editing still works
    }
  }

  function load() {
    var raw;
    try { raw = localStorage.getItem(STORE_KEY); } catch (e) { return; }
    if (!raw) return;
    var data;
    try { data = JSON.parse(raw); } catch (e) { return; }
    fields.forEach(function (el, i) {
      var k = key(el, i);
      if (typeof data[k] === 'string') el.innerHTML = data[k];
    });
  }

  /* ---------- 3. edit mode ---------- */
  function setEditing(on) {
    editing = on;
    document.body.classList.toggle('editing', on);
    fields.forEach(function (el) {
      if (on) el.setAttribute('contenteditable', 'true');
      else el.removeAttribute('contenteditable');
    });
    btnEdit.textContent = on ? 'Editing…' : 'Edit';
    btnEdit.disabled = on;
    btnUpd.disabled = !on;
    if (on) {
      var first = receipt.querySelector('[data-field="payer-name"]') || fields[0];
      if (first) first.focus();
    }
  }

  // Clicking the padding/gaps of a block (e.g. between "TIN NO:" and its value,
  // or the empty part of the footer) should still start editing the nearest
  // field instead of doing nothing.
  receipt.addEventListener('mousedown', function (e) {
    if (!editing) return;
    if (e.target.closest('[data-editable]')) return;   // already on a field
    var host = e.target.closest('.info-row, .info-group, .title-box, .section-header, td, th');
    if (!host) return;
    var target = host.matches('[data-editable]') ? host : host.querySelector('[data-editable]');
    if (!target) return;
    e.preventDefault();
    target.focus();
  });

  // keep pasted content as plain text and keep fields single-line
  fields.forEach(function (el) {
    el.addEventListener('paste', function (e) {
      e.preventDefault();
      var text = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, text.replace(/\s*\n\s*/g, ' '));
    });
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    });
  });

  /* ---------- 3b. validation ----------
     A required field counts as "not updated" while it is empty or still holds
     the sample value the template shipped with. */
  function pending() {
    return required.filter(function (el, i) {
      var now = el.textContent.replace(/\s+/g, ' ').trim();
      var sample = sampleText[key(el, i)];
      return now === '' || now === sample;
    });
  }

  function markPending() {
    var bad = pending();
    fields.forEach(function (el) { el.classList.remove('needs-data'); });
    bad.forEach(function (el) { el.classList.add('needs-data'); });
    return bad;
  }

  // clear a field's warning as soon as it is actually changed
  fields.forEach(function (el) {
    el.addEventListener('input', function () {
      if (el.classList.contains('needs-data')) markPending();
    });
  });

  /* ---------- 4. toast ---------- */
  var toastTimer;
  function say(msg, isError) {
    toast.textContent = msg;
    toast.classList.toggle('error', !!isError);
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove('show'); }, 2600);
  }

  /* ---------- 5. PDF export ---------- */
  function fileName() {
    var idEl = receipt.querySelector('[data-field="transaction-id"]');
    var id = (idEl ? idEl.textContent : '').trim().replace(/[^\w.-]+/g, '-');
    return 'M-PESA-Receipt' + (id ? '-' + id : '') + '.pdf';
  }

  // The layout is tuned to fill exactly one A4 sheet. If someone types enough
  // text to push it past that, everything is scaled down uniformly (never
  // stretched) so the result is still a single page.
  function a4Scale() {
    var h = receipt.scrollHeight;
    return h > A4_H + 1 ? A4_H / h : 1;
  }

  function downloadPdf() {
    if (editing) setEditing(false);          // never capture the edit outlines

    if (typeof html2pdf === 'undefined') {   // library missing -> print dialog
      say('PDF library not found - opening the print dialog instead', true);
      setTimeout(function () { window.print(); }, 400);
      return;
    }

    var label = btnDl.textContent;
    btnDl.disabled = true;
    btnDl.textContent = 'Generating…';

    var leftover = markPending().length;
    document.body.classList.add('exporting');   // keeps warning marks out of the PDF
    var restore = fitToOnePage();               // pin to exact A4 pixels
    var name = fileName();

    var done = function (err) {
      restore();
      document.body.classList.remove('exporting');
      btnDl.disabled = false;
      btnDl.textContent = label;
      if (err) { console.error(err); say('Could not generate the PDF - see the console', true); }
      else if (leftover) {
        say('Downloaded ' + name + ' - warning: ' + leftover +
          (leftover === 1 ? ' field still holds' : ' fields still hold') + ' sample data', true);
      } else { say('Downloaded ' + name); }
      markPending();   // re-mark once the export styles are off
    };

    // The receipt is captured as it stands - no CSS transform, which html2canvas
    // renders shifted and clipped.
    html2pdf().set({
      margin: 0,
      filename: name,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: {
        scale: 3, useCORS: true, backgroundColor: '#FFFFFF', scrollX: 0, scrollY: 0,
        // html2canvas lays the clone out in a scrollbar-less window. Left at its
        // default, the sheet lands half a scrollbar off-centre and the footer bar
        // stops ~8px short of the left edge, so hand it the real content width.
        windowWidth: document.documentElement.clientWidth
      },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      // No page-break processing: html2pdf's avoid/legacy modes pad elements that
      // sit on the page boundary, which shoves the footer bar off the sheet.
      pagebreak: { mode: [], before: [], after: [], avoid: [] }
    }).from(receipt).toPdf().get('pdf').then(function (pdf) {
      // The sheet is a rounded pixel or two over 297mm, which jsPDF spills onto
      // a second, all but empty page. The receipt itself always fits page one.
      while (pdf.internal.getNumberOfPages() > 1) {
        pdf.deletePage(pdf.internal.getNumberOfPages());
      }
      pdf.save(name);
      done();
    }).catch(function (err) { done(err); });
  }

  // Pins the receipt to exactly one A4 sheet and returns an undo function.
  // Normally that is just the natural size; if edits have made the content
  // taller, `zoom` re-lays it out smaller (a real layout scale, so html2canvas
  // and the printer both see it) while the sheet keeps its A4 proportions.
  function fitToOnePage() {
    var prev = {
      w: receipt.style.width, h: receipt.style.height,
      mh: receipt.style.minHeight, of: receipt.style.overflow, z: receipt.style.zoom
    };
    var k = a4Scale();                       // measured before the box is clamped

    receipt.style.width = (A4_W / k) + 'px';
    receipt.style.height = (A4_H / k) + 'px';
    receipt.style.minHeight = '0';
    receipt.style.overflow = 'hidden';       // absorbs sub-pixel rounding only
    if (k < 1) receipt.style.zoom = k;

    return function () {
      receipt.style.width = prev.w;
      receipt.style.height = prev.h;
      receipt.style.minHeight = prev.mh;
      receipt.style.overflow = prev.of;
      receipt.style.zoom = prev.z;
    };
  }

  /* ---------- 5b. print: one A4 page as well ---------- */
  var undoPrintFit = null;
  window.addEventListener('beforeprint', function () {
    if (editing) setEditing(false);
    if (!undoPrintFit) undoPrintFit = fitToOnePage();
  });
  window.addEventListener('afterprint', function () {
    if (undoPrintFit) { undoPrintFit(); undoPrintFit = null; }
  });

  /* ---------- 6. wire up ---------- */
  btnEdit.addEventListener('click', function () { setEditing(true); });

  btnUpd.addEventListener('click', function () {
    setEditing(false);
    var stored = save();
    var bad = markPending();

    if (bad.length) {
      say('Updated - but ' + bad.length + (bad.length === 1 ? ' highlighted field' : ' highlighted fields') +
        ' still need real data', true);
    } else {
      say(stored ? 'Updated' : 'Updated (not saved - browser storage is unavailable)');
    }
  });

  btnPrint.addEventListener('click', function () {
    if (editing) setEditing(false);
    window.print();
  });

  btnDl.addEventListener('click', downloadPdf);

  btnReset.addEventListener('click', function () {
    if (!window.confirm('Restore the original template values? Your edits will be lost.')) return;
    fields.forEach(function (el, i) { el.innerHTML = defaults[key(el, i)]; });
    try { localStorage.removeItem(STORE_KEY); } catch (e) {}
    setEditing(false);
    markPending();
    say('Template reset');
  });

  /* ---------- 7. go ---------- */
  inlineAssets();
  snapshotDefaults();
  load();
  markPending();
})();
