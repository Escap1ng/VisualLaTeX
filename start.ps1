[CmdletBinding()]
param([ValidateRange(0, 65535)][int]$Port = 4173)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw 'Node.js 22 or newer is required: https://nodejs.org/en/download' }
$nodeVersion = & $nodeCommand.Source --version
$versionMatch = [regex]::Match([string]$nodeVersion, '^v(\d+)\.')
if ($LASTEXITCODE -ne 0 -or -not $versionMatch.Success -or [int]$versionMatch.Groups[1].Value -lt 22) { throw 'Please install Node.js 22 or newer.' }
$toolsRoot = Join-Path $PSScriptRoot '.tools'
$tectonicExe = Join-Path $toolsRoot 'tectonic\tectonic.exe'
$ghostscriptExe = Join-Path $toolsRoot 'ghostscript\bin\gswin64c.exe'
if (-not $env:VISUALLATEX_TECTONIC -and -not $env:VISUALLATEX_XELATEX -and (Test-Path -LiteralPath $tectonicExe -PathType Leaf)) { $env:VISUALLATEX_TECTONIC = $tectonicExe }
if (-not $env:VISUALLATEX_GHOSTSCRIPT -and (Test-Path -LiteralPath $ghostscriptExe -PathType Leaf)) { $env:VISUALLATEX_GHOSTSCRIPT = $ghostscriptExe }
if (-not $env:TECTONIC_CACHE_DIR) {
    $env:TECTONIC_CACHE_DIR = Join-Path $toolsRoot 'cache'
    New-Item -ItemType Directory -Path $env:TECTONIC_CACHE_DIR -Force | Out-Null
}
& $nodeCommand.Source (Join-Path $PSScriptRoot 'server.mjs') --port $Port
exit $LASTEXITCODE
