$ErrorActionPreference = 'Stop'

Set-Location $PSScriptRoot

docker buildx build `
    --platform linux/arm64 `
    --target test `
    --progress plain `
    .

if ($LASTEXITCODE -ne 0) {
    throw "Docker unit-test build failed with exit code $LASTEXITCODE."
}

Write-Host 'Rust unit tests completed in the Linux ARM64 builder stage.'
