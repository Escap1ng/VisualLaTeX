# Download pinned official tools into this checkout; never run an installer.
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not [Environment]::Is64BitOperatingSystem) { throw 'The portable compilers require 64-bit Windows.' }
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$toolsRoot = Join-Path $PSScriptRoot '.tools'
$downloads = Join-Path $toolsRoot 'downloads'
foreach ($directory in @($toolsRoot, $downloads)) {
    if ((Test-Path -LiteralPath $directory) -and ((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Tool directories cannot be symbolic links or junctions: $directory"
    }
}
New-Item -ItemType Directory -Path $downloads -Force | Out-Null

function Get-VerifiedDownload([string]$Name, [string]$Url, [string]$Sha256) {
    $destination = Join-Path $downloads $Name
    if (Test-Path -LiteralPath $destination -PathType Leaf) {
        if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -eq $Sha256) { return $destination }
        throw "Existing download failed verification: $destination. Remove that download and retry."
    }
    $partial = $destination + '.' + [Guid]::NewGuid().ToString('N') + '.partial'
    Write-Host "Downloading $Name from $Url"
    Invoke-WebRequest -Uri $Url -OutFile $partial -UseBasicParsing -TimeoutSec 180
    if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ne $Sha256) {
        throw "SHA-256 verification failed. The unused download remains at $partial."
    }
    Move-Item -LiteralPath $partial -Destination $destination
    return $destination
}

function New-StagingDirectory([string]$Tool) {
    $directory = Join-Path $toolsRoot ($Tool + '-staging-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $directory | Out-Null
    return $directory
}

function Move-ToolDirectory([string]$Source, [string]$Destination) {
    $resolvedRoot = (Resolve-Path -LiteralPath $toolsRoot).ProviderPath.TrimEnd([IO.Path]::DirectorySeparatorChar)
    $resolvedSource = (Resolve-Path -LiteralPath $Source).ProviderPath
    $resolvedDestination = [IO.Path]::GetFullPath($Destination)
    $prefix = $resolvedRoot + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedSource.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or
        -not $resolvedDestination.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or
        ((Get-Item -LiteralPath $resolvedSource).Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        (Test-Path -LiteralPath $resolvedDestination)) {
        throw 'Refusing to move a tool directory outside .tools or replace an existing directory.'
    }
    Move-Item -LiteralPath $resolvedSource -Destination $resolvedDestination
}

# SHA-256 digests are published on these exact GitHub release assets.
$tectonicRoot = Join-Path $toolsRoot 'tectonic'
$tectonicExe = Join-Path $tectonicRoot 'tectonic.exe'
if (-not (Test-Path -LiteralPath $tectonicExe -PathType Leaf)) {
    if (Test-Path -LiteralPath $tectonicRoot) { throw "Incomplete tool directory already exists: $tectonicRoot. Rename it before retrying." }
    $archive = Get-VerifiedDownload 'tectonic-0.17.0-windows-msvc.zip' 'https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.17.0/tectonic-0.17.0-x86_64-pc-windows-msvc.zip' 'f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f'
    $staging = New-StagingDirectory 'tectonic'
    Expand-Archive -LiteralPath $archive -DestinationPath $staging
    if (-not (Test-Path -LiteralPath (Join-Path $staging 'tectonic.exe') -PathType Leaf)) { throw "Tectonic executable missing from $staging" }
    Move-ToolDirectory $staging $tectonicRoot
}

$ghostscriptRoot = Join-Path $toolsRoot 'ghostscript'
$ghostscriptExe = Join-Path $ghostscriptRoot 'bin\gswin64c.exe'
if (-not (Test-Path -LiteralPath $ghostscriptExe -PathType Leaf)) {
    if (Test-Path -LiteralPath $ghostscriptRoot) { throw "Incomplete tool directory already exists: $ghostscriptRoot. Rename it before retrying." }
    $sevenRoot = Join-Path $toolsRoot '7zip'
    $sevenExe = Join-Path $sevenRoot '7z.exe'
    if (-not (Test-Path -LiteralPath $sevenExe -PathType Leaf)) {
        if (Test-Path -LiteralPath $sevenRoot) { throw "Incomplete extraction tool directory: $sevenRoot. Rename it before retrying." }
        $sevenReduced = Get-VerifiedDownload '7zr-26.05.exe' 'https://github.com/ip7z/7zip/releases/download/26.05/7zr.exe' '9bf582b894dfa665f852d7e9112b02290a1c303c2d95a21fcdc41ffcb03143b7'
        $sevenArchive = Get-VerifiedDownload '7z2605-x64.exe' 'https://github.com/ip7z/7zip/releases/download/26.05/7z2605-x64.exe' 'fd99e86f57d8f429ef5ed045bf98315af962e2309b0f1ba87a147a44c71647d0'
        $staging = New-StagingDirectory '7zip'
        & $sevenReduced x $sevenArchive "-o$staging" -y | Out-Null
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $staging '7z.exe') -PathType Leaf)) { throw "Unable to unpack 7-Zip. Staging files: $staging" }
        Move-ToolDirectory $staging $sevenRoot
    }
    $archive = Get-VerifiedDownload 'gs10080w64.exe' 'https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/gs10080/gs10080w64.exe' '52a91b8bf09298788d7a57b9206127026c23eacd75405f0a131e26dc381dce50'
    $staging = New-StagingDirectory 'ghostscript'
    & $sevenExe x $archive "-o$staging" -y | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $staging 'bin\gswin64c.exe') -PathType Leaf)) { throw "Unable to unpack Ghostscript. Staging files: $staging" }
    Move-ToolDirectory $staging $ghostscriptRoot
}

New-Item -ItemType Directory -Path (Join-Path $toolsRoot 'cache') -Force | Out-Null
& $tectonicExe --version
if ($LASTEXITCODE -ne 0) { throw 'Tectonic could not start. Check the Microsoft Visual C++ runtime and the tool documentation.' }
& $ghostscriptExe --version
if ($LASTEXITCODE -ne 0) { throw 'Ghostscript could not start. Check the Microsoft Visual C++ runtime and the tool documentation.' }
Write-Host 'Portable tools are ready in .tools. Run .\start.ps1 to open the local workspace service.'
Write-Host 'Tectonic downloads missing TeX support files during the first compilation; project source is compiled locally.'
