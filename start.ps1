$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RequiredNodeMajor = 22

function Write-Info { param($Message) Write-Host "[INFO] $Message" -ForegroundColor Cyan }
function Write-Fail { param($Message) Write-Host "[ERROR] $Message" -ForegroundColor Red; exit 1 }

Set-Location $ProjectDir

Write-Info "Checking Node.js"
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Fail "Node.js $RequiredNodeMajor LTS is required."
}

$nodeVersion = (node -v) -replace '^v', ''
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt $RequiredNodeMajor) {
  Write-Fail "Node.js $RequiredNodeMajor+ is required; found v$nodeVersion."
}

Write-Info "Checking Rust"
$cargoCmd = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $cargoCmd) {
  Write-Fail "Rust/Cargo is required. Install from https://rustup.rs"
}

Write-Info "Checking Visual Studio Build Tools"
$vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vsWhere)) {
  Write-Host "[WARN] Visual Studio Build Tools 2022 were not detected. Install the Desktop development with C++ workload before packaging." -ForegroundColor Yellow
}

if (-not (Test-Path (Join-Path $ProjectDir "node_modules"))) {
  Write-Info "Installing npm dependencies"
  npm install
  if ($LASTEXITCODE -ne 0) { Write-Fail "npm install failed" }
}

Write-Info "Starting ThreadTerm Tauri desktop app"
npm run tauri:dev
