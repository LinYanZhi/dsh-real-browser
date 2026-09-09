# avatar-resize.ps1 — batch-resize avatar images to small square JPEGs (System.Drawing, built into Windows PowerShell 5.1).
# Usage: powershell.exe -NoProfile -ExecutionPolicy Bypass -File avatar-resize.ps1 -InputDir <dir> -OutputDir <dir> [-Size 64]
# Input:  every *.png / *.jpg in InputDir (file name = hash, no extension needed)
# Output: <base>.<size>px.jpg in OutputDir (base64 JPEG, small enough for RPC/UI)
param(
  [Parameter(Mandatory = $true)][string]$InputDir,
  [Parameter(Mandatory = $true)][string]$OutputDir,
  [int]$Size = 64
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$done = 0
foreach ($file in Get-ChildItem -Path $InputDir -File) {
  $ext = $file.Extension.ToLower()
  if ($ext -ne '.png' -and $ext -ne '.jpg' -and $ext -ne '.jpeg' -and $ext -ne '.webp' -and $ext -ne '.ico') { continue }
  $base = $file.BaseName
  $out = Join-Path $OutputDir "$base.${Size}px.jpg"
  if (Test-Path $out) { $done++; continue }
  try {
    $img = [System.Drawing.Image]::FromFile($file.FullName)
    $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.DrawImage($img, 0, 0, $Size, $Size)
    # 契约：输出文件是 base64 文本（env.js 以 utf8 读 + "data:image/jpeg;base64," 包装）。
    # 不能直接 Save($out)——那会写二进制 JPEG，JS 端按 base64 文本读就变乱码（09-09 回归 bug）。
    # 先存临时二进制，再转 base64 写文本。
    $tmpOut = "$out.tmp"
    $bmp.Save($tmpOut, [System.Drawing.Imaging.ImageFormat]::Jpeg)
    $bytes = [System.IO.File]::ReadAllBytes($tmpOut)
    [System.IO.File]::WriteAllText($out, [System.Convert]::ToBase64String($bytes))
    Remove-Item -Force -ErrorAction SilentlyContinue $tmpOut
    $g.Dispose(); $bmp.Dispose(); $img.Dispose()
    $done++
  } catch {
    Write-Warning "resize failed for $($file.Name): $_"
  }
}
Write-Output "resized=$done"
