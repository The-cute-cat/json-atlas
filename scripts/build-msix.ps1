#Requires -Version 5.1
[CmdletBinding()]
param(
    [version]$PackageVersion,
    [string]$ExecutablePath
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$tauri = Join-Path $repo 'src-tauri'
$config = Get-Content -LiteralPath (Join-Path $tauri 'tauri.conf.json') -Raw | ConvertFrom-Json

if (-not $PackageVersion) {
    if ($config.version -notmatch '^\d+\.\d+\.\d+$') {
        throw 'Prerelease builds require an explicit -PackageVersion below the intended stable release.'
    }
    $appVersion = [version]$config.version
    $PackageVersion = [version]::new(($appVersion.Major + 1), $appVersion.Minor, $appVersion.Build, 0)
}
if ($PackageVersion.Revision -ne 0 -or $PackageVersion.Major -lt 1 -or $PackageVersion.Major -gt 65535 -or
    $PackageVersion.Minor -gt 65535 -or $PackageVersion.Build -gt 65535) {
    throw 'Store package versions require a major version from 1 to 65535 and revision 0.'
}

$makeAppx = Get-Command makeappx.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
if (-not $makeAppx) {
    $sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    $makeAppx = Get-ChildItem -LiteralPath $sdkRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
        Sort-Object { [version]$_.Name } -Descending |
        ForEach-Object { Join-Path $_.FullName 'x64\makeappx.exe' } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
        Select-Object -First 1
}
if (-not $makeAppx) {
    throw 'MakeAppx.exe was not found. Install the Windows SDK.'
}

if (-not $ExecutablePath) {
    Push-Location -LiteralPath $repo
    try {
        & npm.cmd run desktop:build -- --no-bundle -- --locked
        if ($LASTEXITCODE -ne 0) { throw 'Tauri release build failed.' }
    } finally {
        Pop-Location
    }
    $ExecutablePath = Join-Path $tauri 'target\release\json-atlas.exe'
}
$ExecutablePath = (Resolve-Path -LiteralPath $ExecutablePath).ProviderPath
$reader = [IO.BinaryReader]::new([IO.File]::OpenRead($ExecutablePath))
try {
    if ($reader.ReadUInt16() -ne 0x5A4D) { throw 'Expected a Windows executable.' }
    $reader.BaseStream.Position = 0x3c
    $reader.BaseStream.Position = $reader.ReadUInt32()
    if ($reader.ReadUInt32() -ne 0x4550 -or $reader.ReadUInt16() -ne 0x8664) {
        throw 'Expected an x64 Windows executable.'
    }
} finally {
    $reader.Dispose()
}

function Save-SquareLogo {
    param([System.Drawing.Image]$Image, [int]$Size, [string]$Path)

    $bitmap = [System.Drawing.Bitmap]::new($Size, $Size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.DrawImage($Image, 0, 0, $Size, $Size)
        $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

Add-Type -AssemblyName System.Drawing
$output = Join-Path $tauri 'target\msix'
$output = (New-Item -ItemType Directory -Path $output -Force).FullName
$package = Join-Path $output "JSON-Atlas-$PackageVersion-x64.msix"
$packed = Join-Path $output ("$([guid]::NewGuid()).msix")
$stage = (New-Item -ItemType Directory -Path (Join-Path $output ([guid]::NewGuid().ToString()))).FullName
try {
    $assets = (New-Item -ItemType Directory -Path (Join-Path $stage 'Assets')).FullName
    Copy-Item -LiteralPath $ExecutablePath -Destination (Join-Path $stage 'json-atlas.exe')
    $documentPath = Join-Path $tauri 'icons\document.ico'
    Copy-Item -LiteralPath $documentPath -Destination (Join-Path $stage 'document.ico')

    $appImage = [System.Drawing.Image]::FromFile((Join-Path $tauri 'icons\app.png'))
    try {
        Save-SquareLogo $appImage 50 (Join-Path $assets 'StoreLogo.png')
        Save-SquareLogo $appImage 44 (Join-Path $assets 'Square44x44Logo.png')
        Save-SquareLogo $appImage 150 (Join-Path $assets 'Square150x150Logo.png')
    } finally {
        $appImage.Dispose()
    }
    $documentIcon = [System.Drawing.Icon]::new($documentPath, 44, 44)
    $documentImage = $documentIcon.ToBitmap()
    try {
        Save-SquareLogo $documentImage 44 (Join-Path $assets 'DocumentLogo.png')
    } finally {
        $documentImage.Dispose()
        $documentIcon.Dispose()
    }

    $manifest = [xml](Get-Content -LiteralPath (Join-Path $tauri 'windows\AppxManifest.xml') -Raw)
    $manifest.Package.Identity.Version = $PackageVersion.ToString()
    $manifest.Save((Join-Path $stage 'AppxManifest.xml'))

    & $makeAppx pack /d $stage /p $packed
    if ($LASTEXITCODE -ne 0) { throw 'MakeAppx packaging or validation failed.' }
    Move-Item -LiteralPath $packed -Destination $package -Force
    Write-Output $package
} finally {
    if (Test-Path -LiteralPath $packed) {
        Remove-Item -LiteralPath $packed
    }
    if ((Split-Path -Parent $stage) -eq $output) {
        Remove-Item -LiteralPath $stage -Recurse
    }
}
