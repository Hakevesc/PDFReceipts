# Regenerates assets/assets-inline.js from the real files in ./assets.
# Run this after you replace the logo or the stamp:
#   powershell -ExecutionPolicy Bypass -File .\build-inline-assets.ps1

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$assets = Join-Path $root 'assets'

$mime = @{ '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'; '.gif' = 'image/gif' }

$lines = @()
$lines += '/* Auto-generated: base64 copies of the files in ./assets so the receipt renders and'
$lines += '   exports to PDF even when the template is opened directly from disk (file://),'
$lines += '   where the browser refuses to read local images into a canvas.'
$lines += '   Regenerate with build-inline-assets.ps1 after replacing anything in ./assets. */'
$lines += 'window.RECEIPT_ASSETS = {'

$entries = @()
Get-ChildItem $assets -File | Where-Object { $mime.ContainsKey($_.Extension.ToLower()) } | ForEach-Object {
    $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($_.FullName))
    $entries += ('  "assets/' + $_.Name + '": "data:' + $mime[$_.Extension.ToLower()] + ';base64,' + $b64 + '"')
}

$lines += ($entries -join ",`r`n")
$lines += '};'

[IO.File]::WriteAllLines((Join-Path $assets 'assets-inline.js'), $lines)
Write-Host ("Wrote assets/assets-inline.js with {0} asset(s)." -f $entries.Count)
