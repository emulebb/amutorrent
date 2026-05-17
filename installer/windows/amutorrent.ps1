#Requires -Version 5.1
<#
.SYNOPSIS
Installs runtime prerequisites and runs aMuTorrent from a native Windows package.
#>

[CmdletBinding()]
param(
    [ValidateSet("Doctor", "Install-Node", "Install-Pm2", "Start", "StartPersistent", "Stop", "Status")]
    [string]$Command = "Start",

    [int]$Port = 4000,

    [string]$BindAddress = "0.0.0.0",

    [switch]$NoBrowser
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$NodeVersion = "v24.15.0"
$MinimumNodeMajor = 24
$NodeArchives = @{
    x64 = @{
        FileName = "node-v24.15.0-win-x64.zip"
        Sha256 = "cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62"
    }
    arm64 = @{
        FileName = "node-v24.15.0-win-arm64.zip"
        Sha256 = "c9eb7402eda26e2ba7e44b6727fc85a8de56c5095b1f71ebd3062892211aa116"
    }
}

function Get-RootPath {
    return (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
}

$PackageRoot = Get-RootPath
$DataRoot = Join-Path $PackageRoot "data"
$LogsRoot = Join-Path $PackageRoot "logs"
$RuntimeRoot = Join-Path $PackageRoot "runtime"
$NodeRoot = Join-Path $RuntimeRoot "node"
$Pm2Prefix = Join-Path $RuntimeRoot "pm2"
$Pm2Home = Join-Path $RuntimeRoot "pm2-home"
$ServerEntry = Join-Path $PackageRoot "server\server.js"

function Assert-NoSpacesInPackagePath {
    if ($PackageRoot -match "\s") {
        throw "aMuTorrent package path contains spaces: '$PackageRoot'. Move it to a path without spaces."
    }
}

function Initialize-RuntimeRoots {
    foreach ($path in @($DataRoot, $LogsRoot, $RuntimeRoot, $Pm2Home)) {
        if (-not (Test-Path -LiteralPath $path)) {
            New-Item -ItemType Directory -Force -Path $path | Out-Null
        }
    }
}

function Get-NodeArchiveKey {
    $architecture = $env:PROCESSOR_ARCHITECTURE
    if ($env:PROCESSOR_ARCHITEW6432) {
        $architecture = $env:PROCESSOR_ARCHITEW6432
    }
    if ($architecture -eq "ARM64") {
        return "arm64"
    }
    return "x64"
}

function Test-NodeMajor {
    param([string]$NodePath)

    try {
        $version = & $NodePath -p "process.versions.node" 2>$null
        $major = [int](($version | Select-Object -First 1).Trim().Split(".")[0])
        return $major -ge $MinimumNodeMajor
    } catch {
        return $false
    }
}

function Resolve-PathNode {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCommand -and (Test-NodeMajor $nodeCommand.Source)) {
        return $nodeCommand.Source
    }
    return $null
}

function Resolve-PackageNode {
    $nodePath = Join-Path $NodeRoot "node.exe"
    if ((Test-Path -LiteralPath $nodePath) -and (Test-NodeMajor $nodePath)) {
        return $nodePath
    }
    return $null
}

function Install-NodeRuntime {
    Assert-NoSpacesInPackagePath
    Initialize-RuntimeRoots

    $archiveKey = Get-NodeArchiveKey
    $archive = $NodeArchives[$archiveKey]
    $archiveName = $archive.FileName
    $expectedHash = $archive.Sha256
    $downloadRoot = Join-Path $RuntimeRoot "downloads"
    $archivePath = Join-Path $downloadRoot $archiveName
    $downloadUrl = "https://nodejs.org/dist/$NodeVersion/$archiveName"
    $expandedPath = Join-Path $RuntimeRoot ($archiveName -replace "\.zip$", "")

    if (-not (Test-Path -LiteralPath $downloadRoot)) {
        New-Item -ItemType Directory -Force -Path $downloadRoot | Out-Null
    }

    Write-Host "Downloading pinned Node $NodeVersion ($archiveKey)..."
    $previousProgressPreference = $ProgressPreference
    try {
        $ProgressPreference = "SilentlyContinue"
        Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $archivePath
    } finally {
        $ProgressPreference = $previousProgressPreference
    }

    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
        throw "Node archive SHA256 mismatch for $archiveName. Expected $expectedHash, got $actualHash."
    }

    if (Test-Path -LiteralPath $expandedPath) {
        Remove-Item -Recurse -Force -LiteralPath $expandedPath
    }
    if (Test-Path -LiteralPath $NodeRoot) {
        Remove-Item -Recurse -Force -LiteralPath $NodeRoot
    }
    Expand-Archive -Force -LiteralPath $archivePath -DestinationPath $RuntimeRoot
    Move-Item -LiteralPath $expandedPath -Destination $NodeRoot
    Remove-Item -Force -LiteralPath $archivePath
    Write-Host "Node installed at $NodeRoot"
}

function Resolve-Node {
    $pathNode = Resolve-PathNode
    if ($pathNode) {
        return $pathNode
    }
    $packageNode = Resolve-PackageNode
    if ($packageNode) {
        return $packageNode
    }
    Install-NodeRuntime
    $packageNode = Resolve-PackageNode
    if ($packageNode) {
        return $packageNode
    }
    throw "Node $MinimumNodeMajor or newer is not available."
}

function Resolve-Npm {
    param([string]$NodePath)

    $nodeDir = Split-Path -Parent $NodePath
    $localNpm = Join-Path $nodeDir "npm.cmd"
    if (Test-Path -LiteralPath $localNpm) {
        return $localNpm
    }
    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($npmCommand) {
        return $npmCommand.Source
    }
    throw "npm.cmd was not found. Install Node $MinimumNodeMajor or newer, or run Install-Node first."
}

function Resolve-Pm2 {
    $pm2Command = Get-Command pm2.cmd -ErrorAction SilentlyContinue
    if ($pm2Command) {
        return $pm2Command.Source
    }
    $localPm2 = Join-Path $Pm2Prefix "node_modules\.bin\pm2.cmd"
    if (Test-Path -LiteralPath $localPm2) {
        return $localPm2
    }
    return $null
}

function Install-Pm2Runtime {
    Assert-NoSpacesInPackagePath
    Initialize-RuntimeRoots

    $nodePath = Resolve-Node
    $npmPath = Resolve-Npm $nodePath
    if (-not (Test-Path -LiteralPath $Pm2Prefix)) {
        New-Item -ItemType Directory -Force -Path $Pm2Prefix | Out-Null
    }
    & $npmPath install --prefix $Pm2Prefix pm2
}

function Set-AmutorrentEnvironment {
    $env:AMUTORRENT_DATA_DIR = $DataRoot
    $env:PORT = [string]$Port
    $env:BIND_ADDRESS = $BindAddress
    $env:PM2_HOME = $Pm2Home
    if (-not $env:LOG_LEVEL) {
        $env:LOG_LEVEL = "info"
    }
}

function Start-Amutorrent {
    Assert-NoSpacesInPackagePath
    Initialize-RuntimeRoots
    Set-AmutorrentEnvironment

    $nodePath = Resolve-Node
    Push-Location $PackageRoot
    try {
        if (-not $NoBrowser) {
            Start-Process "http://127.0.0.1:$Port" | Out-Null
        }
        & $nodePath $ServerEntry
    } finally {
        Pop-Location
    }
}

function Start-AmutorrentPersistent {
    Assert-NoSpacesInPackagePath
    Initialize-RuntimeRoots
    Set-AmutorrentEnvironment

    $pm2Path = Resolve-Pm2
    if (-not $pm2Path) {
        throw "PM2 is not available. Run '.\installer\windows\amutorrent.ps1 Install-Pm2' or add pm2.cmd to PATH."
    }
    Push-Location $PackageRoot
    try {
        & $pm2Path start $ServerEntry --name amutorrent --cwd $PackageRoot --time --update-env
        & $pm2Path save
    } finally {
        Pop-Location
    }
}

function Stop-Amutorrent {
    Set-AmutorrentEnvironment
    $pm2Path = Resolve-Pm2
    if (-not $pm2Path) {
        throw "PM2 is not available. Foreground aMuTorrent runs are stopped with Ctrl+C."
    }
    & $pm2Path stop amutorrent
    & $pm2Path delete amutorrent
    & $pm2Path save
}

function Get-AmutorrentStatus {
    Set-AmutorrentEnvironment
    $pm2Path = Resolve-Pm2
    if ($pm2Path) {
        & $pm2Path status amutorrent
        return
    }
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 5 | ConvertTo-Json -Compress
    } catch {
        throw "aMuTorrent is not responding on http://127.0.0.1:$Port/health and PM2 is not available."
    }
}

function Invoke-Doctor {
    Assert-NoSpacesInPackagePath
    Initialize-RuntimeRoots

    $nodePath = Resolve-Node
    $pm2Path = Resolve-Pm2
    Write-Host "Package root: $PackageRoot"
    Write-Host "Data root: $DataRoot"
    Write-Host "Logs root: $LogsRoot"
    Write-Host "Runtime root: $RuntimeRoot"
    Write-Host "Node: $nodePath"
    if ($pm2Path) {
        Write-Host "PM2: $pm2Path"
    } else {
        Write-Host "PM2: not installed"
    }
}

switch ($Command) {
    "Doctor" { Invoke-Doctor }
    "Install-Node" { Install-NodeRuntime }
    "Install-Pm2" { Install-Pm2Runtime }
    "Start" { Start-Amutorrent }
    "StartPersistent" { Start-AmutorrentPersistent }
    "Stop" { Stop-Amutorrent }
    "Status" { Get-AmutorrentStatus }
}
