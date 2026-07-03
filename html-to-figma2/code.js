/* ============================================================
   HTML → Figma Importer — main thread (runs in the Figma sandbox)

   Receives a serialised node tree from the UI (which renders the
   pasted HTML and measures it with the DOM), then rebuilds it as
   native Figma frames / text / images with Auto Layout.

   This is the importer half of ../figma-export.js (the serialiser).
   ============================================================ */

figma.showUI(__html__, { width: 460, height: 640, themeColors: true });

figma.ui.onmessage = async function (msg) {
  if (msg.type === 'build') {
    try {
      if (!msg.tree) throw new Error('Nothing to import — the HTML produced no visible layout.');
      var opts = msg.options || {};
      if (opts.autoLayout === undefined) opts.autoLayout = true;

      var root = await createNode(msg.tree, opts);
      if (!root) throw new Error('Nothing to import — the HTML produced no visible layout.');

      figma.currentPage.appendChild(root);
      root.x = Math.round(figma.viewport.center.x - root.width / 2);
      root.y = Math.round(figma.viewport.center.y - root.height / 2);
      figma.currentPage.selection = [root];
      figma.viewport.scrollAndZoomIntoView([root]);

      figma.ui.postMessage({ type: 'done', name: root.name });
      figma.notify('Imported “' + root.name + '” into Figma');
    } catch (e) {
      var m = (e && e.message) ? e.message : String(e);
      figma.ui.postMessage({ type: 'error', message: m });
      figma.notify('Import failed: ' + m, { error: true });
    }
  } else if (msg.type === 'close') {
    figma.closePlugin();
  }
};

// ── Fonts (load on demand, fall back gracefully) ────────────────────────────
var FONT_CACHE = {};
function weightToStyle(w) {
  var n = parseInt(w, 10) || 400;
  if (n <= 150) return 'Thin';
  if (n <= 250) return 'ExtraLight';
  if (n <= 350) return 'Light';
  if (n <= 450) return 'Regular';
  if (n <= 550) return 'Medium';
  if (n <= 650) return 'SemiBold';
  if (n <= 750) return 'Bold';
  if (n <= 850) return 'ExtraBold';
  return 'Black';
}
var ETHIOPIC_RE = /[ሀ-፿]/;
async function ensureFont(family, weight, text) {
  var style = weightToStyle(weight);
  var candidates = ETHIOPIC_RE.test(text || '')
    ? [
        { family: 'Noto Sans Ethiopic', style: style },
        { family: 'Noto Sans Ethiopic', style: 'Regular' },
        { family: 'Nyala', style: 'Regular' },
        { family: 'Inter', style: 'Regular' }
      ]
    : [
        { family: family, style: style },
        { family: family, style: 'Regular' },
        { family: 'Inter', style: style },
        { family: 'Inter', style: 'Regular' },
        { family: 'Roboto', style: 'Regular' }
      ];
  for (var i = 0; i < candidates.length; i++) {
    var f = candidates[i];
    var key = f.family + '|' + f.style;
    if (FONT_CACHE[key]) return f;
    try { await figma.loadFontAsync(f); FONT_CACHE[key] = true; return f; }
    catch (e) { /* try next */ }
  }
  var def = { family: 'Roboto', style: 'Regular' };
  await figma.loadFontAsync(def);
  return def;
}

// ── Paint / gradient / effect conversion ────────────────────────────────────
function convertPaint(p) {
  if (!p) return null;
  if (p.type === 'SOLID') {
    return { type: 'SOLID', color: { r: p.color.r, g: p.color.g, b: p.color.b }, opacity: p.color.a == null ? 1 : p.color.a };
  }
  if (p.type === 'GRADIENT_LINEAR' && p.gradientHandlePositions && p.gradientStops) {
    return {
      type: 'GRADIENT_LINEAR',
      gradientTransform: gradientTransform(p.gradientHandlePositions),
      gradientStops: p.gradientStops.map(function (s) {
        return { color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a == null ? 1 : s.color.a }, position: s.position };
      })
    };
  }
  return null;
}

// Build a Figma gradientTransform from two normalised handle points.
// Only the first matrix row drives a linear gradient's colour parameter; the
// second is any invertible perpendicular axis (kept tidy/centred here).
function gradientTransform(handles) {
  var h0 = handles[0], h1 = handles[1] || { x: handles[0].x, y: handles[0].y + 1 };
  var dx = h1.x - h0.x, dy = h1.y - h0.y;
  var L2 = dx * dx + dy * dy || 1;
  var a0 = dx / L2, a1 = dy / L2, a2 = -(h0.x * dx + h0.y * dy) / L2;
  var b0 = -dy / L2, b1 = dx / L2, b2 = (h0.x * dy - h0.y * dx) / L2 + 0.5;
  return [[a0, a1, a2], [b0, b1, b2]];
}

function convertEffects(effects) {
  if (!effects || !effects.length) return [];
  return effects.map(function (e) {
    return {
      type: e.type, color: e.color, offset: e.offset,
      radius: e.radius || 0, spread: e.spread || 0,
      visible: e.visible !== false, blendMode: 'NORMAL'
    };
  });
}

function b64ToBytes(dataUrl) {
  var b64 = dataUrl.indexOf(',') >= 0 ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var lookup = {};
  for (var i = 0; i < chars.length; i++) lookup[chars[i]] = i;
  b64 = b64.replace(/[^A-Za-z0-9+/]/g, '');
  var bytes = [], buffer = 0, bits = 0;
  for (var j = 0; j < b64.length; j++) {
    var c = lookup[b64[j]];
    if (c === undefined) continue;
    buffer = (buffer << 6) | c; bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 0xFF); }
  }
  return new Uint8Array(bytes);
}

// ── Apply visual styling to a frame ─────────────────────────────────────────
function applyVisuals(f, node) {
  var fills = [];
  if (node.imageData) {
    try {
      var img = figma.createImage(b64ToBytes(node.imageData));
      fills.push({ type: 'IMAGE', scaleMode: 'FILL', imageHash: img.hash });
    } catch (e) { /* skip broken image */ }
  } else if (node.fills && node.fills.length) {
    node.fills.forEach(function (p) { var cp = convertPaint(p); if (cp) fills.push(cp); });
  }
  f.fills = fills;

  if (node.strokes && node.strokes.length) {
    var s = node.strokes[0];
    f.strokes = [{ type: 'SOLID', color: { r: s.color.r, g: s.color.g, b: s.color.b }, opacity: s.color.a == null ? 1 : s.color.a }];
    f.strokeWeight = Math.max(0, s.weight || 1);
  }

  var cr = node.cornerRadius || [0, 0, 0, 0];
  if (cr[0] === cr[1] && cr[1] === cr[2] && cr[2] === cr[3]) {
    if (cr[0]) f.cornerRadius = cr[0];
  } else {
    try {
      f.topLeftRadius = cr[0]; f.topRightRadius = cr[1];
      f.bottomRightRadius = cr[2]; f.bottomLeftRadius = cr[3];
    } catch (e) { /* not all frames support per-corner radii */ }
  }

  var fx = convertEffects(node.effects);
  if (fx.length) f.effects = fx;
  if (typeof node.opacity === 'number' && node.opacity < 1) f.opacity = node.opacity;
  f.clipsContent = !!node.clipsContent;
}

function applyAutoLayout(f, al) {
  f.layoutMode = al.direction === 'HORIZONTAL' ? 'HORIZONTAL' : 'VERTICAL';
  f.itemSpacing = isFinite(al.itemSpacing) ? al.itemSpacing : 0;
  f.paddingTop = al.paddingTop || 0;
  f.paddingRight = al.paddingRight || 0;
  f.paddingBottom = al.paddingBottom || 0;
  f.paddingLeft = al.paddingLeft || 0;
  var prim = al.primaryAlign || 'MIN';
  f.primaryAxisAlignItems = (prim === 'SPACE_BETWEEN' || prim === 'CENTER' || prim === 'MAX') ? prim : 'MIN';
  var cnt = al.counterAlign || 'MIN';
  if (cnt === 'BASELINE' && f.layoutMode !== 'HORIZONTAL') cnt = 'MIN';
  f.counterAxisAlignItems = (cnt === 'CENTER' || cnt === 'MAX' || cnt === 'BASELINE') ? cnt : 'MIN';
  if (al.wrap) { try { f.layoutWrap = 'WRAP'; } catch (e) { } }
}

// ── Build a text node ───────────────────────────────────────────────────────
async function createText(node) {
  var font = await ensureFont(node.fontFamily, node.fontWeight, node.text);
  var t = figma.createText();
  t.fontName = font;
  t.fontSize = Math.max(1, node.fontSize || 14);
  t.characters = node.text || '';
  var col = node.color || { r: 0, g: 0, b: 0, a: 1 };
  t.fills = [{ type: 'SOLID', color: { r: col.r, g: col.g, b: col.b }, opacity: col.a == null ? 1 : col.a }];
  t.textAlignHorizontal = node.textAlign || 'LEFT';
  if (node.lineHeight) { try { t.lineHeight = { unit: 'PIXELS', value: node.lineHeight }; } catch (e) { } }
  if (node.letterSpacing) { try { t.letterSpacing = { unit: 'PIXELS', value: node.letterSpacing }; } catch (e) { } }
  t.name = node.text ? node.text.slice(0, 40) : 'text';
  // Chrome (where the width was measured) and Figma's own text engine don't
  // necessarily agree on exactly how wide a string renders. Forcing the
  // Chrome-measured box with textAutoResize='NONE' means a string that just
  // fit on one line in Chrome can silently wrap to a second line in Figma —
  // looks like duplicated/garbled text. Let Figma size the box itself instead.
  try { t.textAutoResize = 'WIDTH_AND_HEIGHT'; } catch (e) { }
  return t;
}

// ── Build any node (frame / text / image) ───────────────────────────────────
async function createNode(node, opts) {
  if (!node) return null;
  if (node.type === 'TEXT') return await createText(node);

  var f = figma.createFrame();
  f.name = node.name || 'frame';
  f.fills = [];

  var useAuto = opts.autoLayout && node.autoLayout && !node.imageData &&
                node.children && node.children.length > 0;
  if (useAuto) applyAutoLayout(f, node.autoLayout);

  if (!node.imageData && node.children && node.children.length) {
    for (var i = 0; i < node.children.length; i++) {
      var childNode = node.children[i];
      var child = await createNode(childNode, opts);
      if (!child) continue;
      f.appendChild(child);
      if (useAuto) {
        if (childNode.absolute) {
          try { child.layoutPositioning = 'ABSOLUTE'; child.x = childNode.x; child.y = childNode.y; } catch (e) { }
        } else {
          // appendChild into an auto-layout frame resets the child to "hug
          // content" sizing, discarding the exact size measured from the
          // rendered HTML — pin it back or rows/columns collapse and misalign.
          try { child.layoutSizingHorizontal = 'FIXED'; } catch (e) { }
          try { child.layoutSizingVertical = 'FIXED'; } catch (e) { }
          try { child.resize(Math.max(0.01, childNode.w || 1), Math.max(0.01, childNode.h || 1)); } catch (e) { }
        }
      } else {
        child.x = childNode.x; child.y = childNode.y;
      }
    }
  }

  if (useAuto) {
    try { f.primaryAxisSizingMode = 'FIXED'; f.counterAxisSizingMode = 'FIXED'; } catch (e) { }
  }
  try { f.resize(Math.max(0.01, node.w || 1), Math.max(0.01, node.h || 1)); } catch (e) { }
  // CSS rotation is clockwise-positive; Figma's `rotation` is counter-clockwise-positive.
  if (node.rotation) { try { f.rotation = -node.rotation; } catch (e) { } }

  applyVisuals(f, node);
  return f;
}
