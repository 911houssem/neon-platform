# Customer Service AI - Quick Start Script
# =========================================

Write-Host "╔══════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  Customer Service AI - Full Setup       ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# Step 1: Check Docker
Write-Host "📋 Checking Docker..." -ForegroundColor Yellow
$dockerVersion = docker --version 2>$null
if (-not $dockerVersion) {
    Write-Host "❌ Docker is not installed. Please install Docker Desktop from https://www.docker.com/products/docker-desktop" -ForegroundColor Red
    exit 1
}
Write-Host "✅ $dockerVersion" -ForegroundColor Green

# Step 2: Create directories
Write-Host "📁 Creating directories..." -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path "data" | Out-Null
New-Item -ItemType Directory -Force -Path "workflows" | Out-Null
Write-Host "✅ Directories ready" -ForegroundColor Green

# Step 3: Setup environment
Write-Host "🔑 Setting up environment..." -ForegroundColor Yellow
if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host "⚠️  Created .env from .env.example - Please edit it with your API keys!" -ForegroundColor Yellow
} else {
    Write-Host "✅ .env file exists" -ForegroundColor Green
}

# Step 4: Install npm deps for qr-connector
Write-Host "📦 Installing QR Connector dependencies..." -ForegroundColor Yellow
Set-Location -Path "qr-connector"; npm install 2>&1 | Out-Null; Set-Location -Path ".."
Write-Host "✅ QR Connector ready" -ForegroundColor Green

# Step 5: Start all services
Write-Host ""
Write-Host "🚀 Starting all services (n8n + Evolution API + MongoDB + QR Connector)..." -ForegroundColor Cyan
Write-Host ""
Write-Host "⏳ First run may take a few minutes (downloading images)..." -ForegroundColor Yellow
Write-Host ""

docker compose up -d --remove-orphans

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "╔══════════════════════════════════════════════════════╗" -ForegroundColor Green
    Write-Host "║             ✅  All Services Running!               ║" -ForegroundColor Green
    Write-Host "╚══════════════════════════════════════════════════════╝" -ForegroundColor Green
    Write-Host ""
    Write-Host "🌐  Service URLs:" -ForegroundColor Cyan
    Write-Host "   QR Connector (ربط واتساب): http://localhost:3000" -ForegroundColor White
    Write-Host "   n8n Editor (سير العمل):    http://localhost:5678" -ForegroundColor White
    Write-Host "   Evolution API (Swagger):   http://localhost:8080/swagger" -ForegroundColor White
    Write-Host ""
    Write-Host "📋  خطوات التشغيل:" -ForegroundColor Yellow
    Write-Host "  1️⃣  افتح http://localhost:3000" -ForegroundColor White
    Write-Host "  2️⃣  أدخل رقم الواتساب (مع مفتاح الدولة: 966xxxxxxxx)" -ForegroundColor White
    Write-Host "  3️⃣  امسح QR Code بالواتساب (واتساب → أجهزة مرتبطة)" -ForegroundColor White
    Write-Host "  4️⃣  افتح http://localhost:5678 عشان تشوف الرسائل" -ForegroundColor White
    Write-Host ""
    Write-Host "📋  n8n Setup (أول مرة):" -ForegroundColor Yellow
    Write-Host "  1. أنشئ حساب في http://localhost:5678" -ForegroundColor White
    Write-Host "  2. Settings → Credentials → أضف:" -ForegroundColor White
    Write-Host "     - OpenAI (API Key)" -ForegroundColor White
    Write-Host "     - Evolution API (Header Auth: apikey = 123456)" -ForegroundColor White
    Write-Host "     - Discord Webhook (اختياري)" -ForegroundColor White
    Write-Host "  3. Workflows → Add → Import from File" -ForegroundColor White
    Write-Host "     واختار workflows/customer-service-workflow.json" -ForegroundColor White
    Write-Host "  4. Activate workflow" -ForegroundColor White
    Write-Host ""
    Write-Host "📋  Useful Commands:" -ForegroundColor Gray
    Write-Host "  docker compose logs -f    (view all logs)" -ForegroundColor Gray
    Write-Host "  docker compose down       (stop everything)" -ForegroundColor Gray
    Write-Host "  docker compose restart    (restart)" -ForegroundColor Gray
    Write-Host "  docker compose logs -f n8n (n8n only)" -ForegroundColor Gray
    Write-Host "  docker compose logs -f evolution-api (Evolution only)" -ForegroundColor Gray
} else {
    Write-Host "❌ Failed to start. Check Docker is running." -ForegroundColor Red
}
