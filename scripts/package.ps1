#Requires -Version 7.0
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifestPath = Join-Path $repositoryRoot 'sound-fx-and-recorder/manifest.json'
$manifest = Get-Content -Raw -Encoding utf8 -LiteralPath $manifestPath | ConvertFrom-Json
$version = [string]$manifest.version
if ($version -notmatch '^\d+\.\d+\.\d+(\.\d+)?$') {
    throw "Unexpected extension version: $version"
}

# Only these reviewed files belong in the user-facing package.
$extensionFiles = @(
    'manifest.json'
    'service-worker.js'
    'offscreen.html'
    'offscreen.js'
    'opus-recorder.js'
    'pcm-recorder-worklet.js'
    'pcm-utils.js'
    'popup.html'
    'popup.js'
    'popup.css'
    'options.html'
    'options.js'
    'options.css'
    'icons/icon16.png'
    'icons/icon32.png'
    'icons/icon48.png'
    'icons/icon128.png'
)
$packageFiles = @($extensionFiles | ForEach-Object { "sound-fx-and-recorder/$_" })
$packageFiles += @('WebM_Opus_Converter.bat', 'README.md', 'CHANGELOG.md', 'PRIVACY.md', 'LICENSE')
foreach ($relativePath in $packageFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $repositoryRoot $relativePath) -PathType Leaf)) {
        throw "Required package file is missing: $relativePath"
    }
}

$outputDirectory = Join-Path $repositoryRoot 'output/releases'
[System.IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
$zipPath = Join-Path $outputDirectory "sound-fx-and-recorder-v$version.zip"
$temporaryPath = Join-Path $outputDirectory ('.package-' + [guid]::NewGuid().ToString('N') + '.zip')
try {
    $archive = [System.IO.Compression.ZipFile]::Open($temporaryPath, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($relativePath in $packageFiles) {
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive,
                (Join-Path $repositoryRoot $relativePath),
                $relativePath,
                [System.IO.Compression.CompressionLevel]::Optimal
            ) | Out-Null
        }
    } finally {
        $archive.Dispose()
    }

    $verification = [System.IO.Compression.ZipFile]::OpenRead($temporaryPath)
    try {
        $actualPaths = @($verification.Entries | ForEach-Object { $_.FullName })
        if ($actualPaths.Count -ne $packageFiles.Count -or
            @(Compare-Object $packageFiles $actualPaths).Count -ne 0) {
            throw 'Package contents do not match the explicit file list.'
        }
    } finally {
        $verification.Dispose()
    }

    # Both paths are fixed beneath this repository's output/releases directory.
    [System.IO.File]::Move($temporaryPath, $zipPath, $true)
} finally {
    if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
        Remove-Item -LiteralPath $temporaryPath
    }
}

Write-Output "Created: $zipPath"
Write-Output "Files: $($packageFiles.Count)"
Write-Output "SHA256: $((Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash)"
