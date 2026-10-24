param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Tools = Join-Path $Root '.tools'
$Downloads = Join-Path $Tools 'downloads'

$OscarVersion = 'v1.32.273'
$ViceVersion = '3.10.0'
$OscarUrl = "https://github.com/drmortalwombat/oscar64/releases/download/$OscarVersion/oscar64.zip"
$ViceUrl = "https://github.com/VICE-Team/svn-mirror/releases/download/$ViceVersion/SDL2VICE-3.10-win64.zip"

function Install-Archive($Name, $Url, $Destination) {
    if ((Test-Path -LiteralPath $Destination) -and -not $Force) {
        Write-Host "$Name already exists at $Destination"
        return
    }
    New-Item -ItemType Directory -Force -Path $Downloads | Out-Null
    $Archive = Join-Path $Downloads "$Name.zip"
    Write-Host "Downloading $Name..."
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Archive
    if (Test-Path -LiteralPath $Destination) {
        Remove-Item -LiteralPath $Destination -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Expand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force
}

Install-Archive 'oscar64' $OscarUrl (Join-Path $Tools 'oscar64')
Install-Archive 'vice' $ViceUrl (Join-Path $Tools 'vice')

$Python = Get-Command python -ErrorAction SilentlyContinue
if (-not $Python) {
    throw 'Python 3 is required and was not found on PATH.'
}

Write-Host ''
Write-Host 'Toolchain ready.'
Write-Host 'Start the editor: python editor/server.py'
Write-Host 'Build the demo:  python build.py dev game/demo.json'
