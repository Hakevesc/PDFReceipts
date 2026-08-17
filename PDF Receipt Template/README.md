# M-PESA Receipt Template — Pay Utility EEU (Customer)

Standalone, editable version of `Pay Utility EEU_Customer - UHS7FDXDDX.html`.
Open `index.html` in a browser — no server, no build step, no internet needed.

```
PDF Receipt Template/
├─ index.html                 the receipt + toolbar
├─ styles.css                 all receipt styling (was inline in the source file)
├─ template.js                edit / update / print / download behaviour
├─ assets/
│  ├─ M-PESA-red-logo.svg     header logo
│  ├─ M-PESA-wordmark-white.svg  footer-bar logo (white, for the green bar)
│  ├─ M-PESA-official_stamp.png  stamp watermark
│  └─ assets-inline.js        generated base64 copies of the three files above
├─ vendor/html2pdf.bundle.min.js   html2canvas + jsPDF, vendored for offline use
└─ build-inline-assets.ps1    regenerates assets-inline.js
```

## Buttons

| Button | What it does |
| --- | --- |
| **Edit** | Turns every field on the receipt into an editable field (dashed green outline). |
| **Update** | Ends edit mode, applies the changes and saves them in the browser. Shows "Updated", or warns if fields still hold sample data. |
| **Print** | Browser print dialog, fitted to one A4 page. |
| **Download A4 PDF** | Saves `M-PESA-Receipt-<TRANSACTION ID>.pdf` — one page, exactly 210 × 297 mm. |
| **Reset** | Restores the original placeholder values. |

Editable: the title, every label and value under TRANSACTION INFORMATION, the
TRANSACTION DETAIL table and the additional info rows.

## Sample data and the "needs real data" warning

The template ships with placeholder values (`Payer Full Name`, `2517XXXXXXXX`,
`0.00 BIRR`, `XXXXXXXXXX`, `RCP-0000-SAMPLE`, `DD/MM/YY at 00:00 AM`, …) — no
real customer data. The 14 fields carrying them are tagged `data-required` in
`index.html`.

A required field counts as **not updated** while it is empty or still equal to
the value the template shipped with. Those fields carry an amber underline, and
a warning appears when you press **Update** and again when you press **Download
A4 PDF**, so a receipt full of placeholders can't go out unnoticed. Nothing is
blocked: the update is still applied and the PDF still downloads.

The amber marks are screen-only — they never appear in the printed page or the PDF.

Edge case: a field whose real value happens to match its placeholder (a service
fee genuinely of `0.00 BIRR`) will keep warning. Retype it or ignore the chip.

Deliberately locked, so they can't be disturbed:

* the company block at the top — name, TIN NO, VAT REG NO, Address, Tel
* the thank-you line at the bottom
* the diagonal "M-PESA" watermark

To change any of those, edit `index.html` directly.

Edits are kept in the browser's local storage (key `mpesa-receipt-eeu-customer-v1`),
so they survive a reload on the same machine and browser. **Reset** clears them.

## Swapping the logo or stamp

Replace the file in `assets/`, then regenerate the inlined copies:

```bash
powershell -ExecutionPolicy Bypass -File ./build-inline-assets.ps1
```

The inlined copies exist because a browser refuses to read a local image into a
canvas when the page is opened from disk (`file://`), which would otherwise
produce a blank PDF.

## Notes on the A4 output

* The receipt body is 793.7 × 1122.5 px = exactly A4 at 96 dpi, and the vertical
  rhythm is slightly tighter than the original receipt so the whole thing fits one
  sheet without being shrunk.
* If edits make the content taller than a page, it is scaled down uniformly (never
  stretched) so the result stays a single A4 page.
* The green footer bar sits in normal flow and the footer logo is a real white
  asset — an absolutely positioned bar and a CSS `filter: invert()` both render
  wrong through html2canvas.
