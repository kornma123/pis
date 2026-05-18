# COREONE 前后端服务重启脚本
# 用法: 在 PowerShell 中执行 .\restart-services.ps1

$backendDir = "后端代码/server"
$frontendDir = "前端代码"
$backendUrl = "http://localhost:3001/api/health"
$frontendUrl = "http://127.0.0.1:8080"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  COREONE 服务重启" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# 1. 停止现有 Node 进程
Write-Host "`n[1/4] 停止现有 Node 进程..." -ForegroundColor Yellow
$nodes = Get-Process node -ErrorAction SilentlyContinue
if ($nodes) {
    $nodes | Stop-Process -Force
    Write-Host "      已停止 $($nodes.Count) 个 node 进程" -ForegroundColor Green
} else {
    Write-Host "      没有运行中的 node 进程" -ForegroundColor Gray
}

# 2. 启动后端
Write-Host "`n[2/4] 启动后端服务..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$backendDir'; npx tsx src/app.ts" -WindowStyle Hidden

# 3. 启动前端
Write-Host "`n[3/4] 启动前端服务..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$frontendDir'; npx vite --host 127.0.0.1 --port 8080" -WindowStyle Hidden

# 4. 等待服务就绪
Write-Host "`n[4/4] 等待服务就绪..." -ForegroundColor Yellow
$maxWait = 30
$ready = $false
for ($i = 0; $i -lt $maxWait; $i++) {
    Start-Sleep -Seconds 1
    try {
        $res = Invoke-WebRequest -Uri $backendUrl -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        if ($res.StatusCode -eq 200) {
            $ready = $true
            break
        }
    } catch { }
    Write-Host "      等待中... ($($i + 1)s)" -ForegroundColor Gray
}

if ($ready) {
    Write-Host "`n✅ 后端已就绪: $backendUrl" -ForegroundColor Green
    Write-Host "✅ 前端地址:   $frontendUrl" -ForegroundColor Green

    # 5. 在外部浏览器打开（避免 VS Code 内置浏览器的 iframe 跨域问题）
    Write-Host "`n🌐 正在打开外部浏览器..." -ForegroundColor Cyan
    Start-Process $frontendUrl

    Write-Host "`n========================================" -ForegroundColor Cyan
    Write-Host "  启动完成！请在外部浏览器中操作。" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
} else {
    Write-Host "`n⚠️ 服务启动超时，请手动检查日志。" -ForegroundColor Red
}
