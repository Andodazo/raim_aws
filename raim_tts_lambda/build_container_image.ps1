[CmdletBinding()]
param(
    [string]$ImageTag = 'raim-tts-lambda:dev',
    [ValidateSet('load', 'push')]
    [string]$Output = 'load'
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$dockerArgs = @(
    'buildx', 'build',
    '--platform', 'linux/arm64',
    '--target', 'runtime',
    '--tag', $ImageTag,
    '--provenance=false',
    '--progress', 'plain',
    '.'
)

if ($Output -eq 'push') {
    $dockerArgs += '--push'
} else {
    $dockerArgs += '--load'
}

& docker @dockerArgs
if ($LASTEXITCODE -ne 0) {
    throw "Docker container image build failed with exit code $LASTEXITCODE."
}

Write-Host "Built container image: $ImageTag"
