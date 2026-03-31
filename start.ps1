# ============================================================
# OpenWork — One-click launcher (Windows PowerShell)
# Run: Right-click > "Run with PowerShell"
# Or:  powershell -ExecutionPolicy Bypass -File start.ps1
# ============================================================
$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RequiredNodeMajor = 18
$EnvFile = Join-Path $ProjectDir ".env"
$EnvExample = Join-Path $ProjectDir ".env.example"

function Write-Info  { param($m) Write-Host "[INFO] $m" -ForegroundColor Cyan }
function Write-Ok    { param($m) Write-Host "[OK] $m" -ForegroundColor Green }
function Write-Warn  { param($m) Write-Host "[WARN] $m" -ForegroundColor Yellow }
function Write-Fail  { param($m) Write-Host "[ERROR] $m" -ForegroundColor Red; Read-Host "Press Enter to exit"; exit 1 }

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  OpenWork - Launcher (Windows)" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# --- Step 1: Check Node.js ---
Write-Info "Checking Node.js..."

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    $nvmCmd = Get-Command nvm -ErrorAction SilentlyContinue
    if ($nvmCmd) {
        Write-Info "Installing Node.js v20 via nvm..."
        nvm install 20
        nvm use 20
    } else {
        Write-Fail "Node.js not found. Install Node.js 18+ or nvm-windows."
    }
}

$nodeVersion = (node -v) -replace 'v',''
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt $RequiredNodeMajor) {
    $nvmCmd = Get-Command nvm -ErrorAction SilentlyContinue
    if ($nvmCmd) {
        Write-Warn "Node v$nodeVersion too old, upgrading..."
        nvm install 20
        nvm use 20
    } else {
        Write-Fail "Node.js $RequiredNodeMajor+ required, found v$nodeVersion"
    }
}
Write-Ok "Node.js $(node -v)"

# --- Step 2: Check build tools ---
Write-Info "Checking build tools..."

$vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$hasBT = (Test-Path $vsWhere) -and (& $vsWhere -latest -property installationPath 2>$null)

if ($hasBT) {
    Write-Ok "Visual Studio Build Tools found"
} else {
    Write-Warn "VS Build Tools not detected. Native modules may fail."
    Write-Warn "Fix: npm install -g windows-build-tools"
}

# --- Step 3: Setup .env ---
Set-Location $ProjectDir
Write-Info "Checking .env..."

function New-JwtSecret {
    -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
}

if (-not (Test-Path $EnvFile)) {
    Copy-Item $EnvExample $EnvFile
    $jwt = New-JwtSecret
    Add-Content $EnvFile "`nJWT_SECRET=$jwt"
    Write-Ok ".env created with JWT_SECRET"
} else {
    Write-Ok ".env exists"
    $c = Get-Content $EnvFile -Raw
    if ($c -notmatch "(?m)^JWT_SECRET=") {
        $jwt = New-JwtSecret
        Add-Content $EnvFile "`nJWT_SECRET=$jwt"
        Write-Ok "JWT_SECRET added"
    }
}

# --- Step 4: Install dependencies ---
Write-Info "Checking dependencies..."
if (-not (Test-Path (Join-Path $ProjectDir "node_modules"))) {
    Write-Info "Running npm install (may take a few minutes)..."
    npm install
    if ($LASTEXITCODE -ne 0) { Write-Fail "npm install failed" }
    Write-Ok "Dependencies installed"
} else {
    Write-Ok "node_modules exists"
}

# --- Step 5: Check CLI tools ---
Write-Host ""
Write-Info "Checking CLI tools..."
if (Get-Command claude -ErrorAction SilentlyContinue) {
    Write-Ok "claude CLI found"
} else {
    Write-Warn "claude CLI not found (install: npm i -g @anthropic-ai/claude-code)"
}
if (Get-Command codex -ErrorAction SilentlyContinue) {
    Write-Ok "codex CLI found"
} else {
    Write-Warn "codex CLI not found (optional: npm i -g @openai/codex)"
}
Write-Host ""

# --- Step 6: Launch ---
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Starting OpenWork" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Info "Frontend: http://localhost:5173"
Write-Info "Backend:  http://localhost:3001"
Write-Host ""

npm run dev
