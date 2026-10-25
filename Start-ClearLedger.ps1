$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$taskNodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($taskNodeCommand) {
    $taskNodePath = $taskNodeCommand.Source
} else {
    $taskNodePath = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (-not (Test-Path -LiteralPath $taskNodePath)) { throw 'Install Node.js 24+, then run npm ci.' }
}
if (-not (Test-Path -LiteralPath 'node_modules\tsx\dist\cli.mjs')) {
    throw 'Project dependencies are missing. Run npm ci with Node.js 24+ first.'
}
& $taskNodePath node_modules\tsx\dist\cli.mjs scripts\compile.ts
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $taskNodePath node_modules\tsx\dist\cli.mjs scripts\build.ts
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host 'Open http://127.0.0.1:4317 after startup. Press Ctrl+C to stop.'
& $taskNodePath node_modules\tsx\dist\cli.mjs scripts\demo.ts
