# HTML → Figma Importer

A Figma plugin that turns **pasted HTML (or a loaded `.html` file) into native Figma
layers** — frames, text, images and Auto Layout. It's the importer half of
[`figma-export.js`](../figma-export.js): that script serialises a page's DOM, this
plugin rebuilds it inside Figma.

## How it works

A Figma plugin's main thread has no DOM, so it can't parse HTML or compute layout.
This plugin's **UI iframe does** have a DOM:

1. The UI renders your HTML inside an isolated **shadow root** (so the page's own
   CSS can't leak into the plugin panel).
2. It waits for webfonts/stylesheets, then walks the rendered tree with
   `getComputedStyle` — the **same serialiser logic as `figma-export.js`** — turning
   each element into `{ x, y, w, h, fills, strokes, effects, cornerRadius, autoLayout, … }`.
   Icons (`<i>` glyph fonts), inline `<svg>` and `<img>` are rasterised to PNG.
3. The serialised tree is sent to the main thread, which builds real Figma nodes.

## Install (local / development)

1. Open the Figma **desktop app** (local plugins don't run in the browser).
2. Menu → **Plugins → Development → Import plugin from manifest…**
3. Select `html-to-figma/manifest.json` from this project.
4. Run it from **Plugins → Development → HTML → Figma Importer**.

## Use

1. Paste HTML into the box, **or** click the file picker to load one of the project's
   `.html` screens.
2. Options:
   - **Root selector** — which element to import (defaults to auto-detect:
     `.phone-frame`, `.phone`, `.screen`, `main`, … then the single body child).
   - **Render width** — viewport width the HTML is laid out at before measuring
     (360 for the phone screens).
   - **Use Auto Layout** — rebuild flex containers as Figma Auto Layout (on), or place
     everything by absolute x/y for pixel-exact output (off).
3. **Build in Figma** — the result is dropped at the viewport centre and selected.

## What gets translated

| HTML / CSS | Figma |
| --- | --- |
| Element box | Frame (size + position) |
| `display:flex` | Auto Layout (direction, gap, padding, justify/align) |
| `background-color` / linear-gradient | Solid / linear gradient fill |
| `border` | Stroke + weight |
| `border-radius` | Corner radius (per-corner supported) |
| `box-shadow` | Drop / inner shadow effects |
| `opacity`, `overflow:hidden` | Opacity, clip content |
| Text nodes | Text layers (family, size, weight, colour, line-height, spacing, align) |
| `<i>` icon fonts, inline `<svg>`, `<img>` | Rasterised PNG image fills |

## Tips & limitations

- **Self-contained HTML imports best.** The project's screen files keep their CSS in
  an inline `<style>`, so they render fully. If your HTML links an *external*
  stylesheet by relative path (e.g. `styles/design-tokens.css`), inline it first or
  the layout will be unstyled.
- **Fonts:** if the page's font isn't installed in Figma, text falls back to the same
  weight in **Inter**, then Roboto.
- Gradients are linear-only; radial/conic and blend modes aren't translated.
- Icons/SVGs come in as flattened PNGs (not editable vectors) — same trade-off as the
  export direction.
- Auto Layout reproduces structure but may differ by a pixel or two from the source;
  turn it off for pixel-exact absolute positioning.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | Plugin manifest (`networkAccess` allows CDNs so webfonts/images load). |
| `ui.html` | Renders + serialises the pasted HTML (DOM lives here). |
| `code.js` | Main thread — rebuilds the tree as Figma nodes, loads fonts, decodes images. |
