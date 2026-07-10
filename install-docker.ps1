# COREONE Docker 本地安装脚本
# 需要以管理员身份运行 PowerShell 后执行: .\install-docker.ps1

$ErrorActionPreference = "Stop"

Write-Host "=== COREONE Docker 本地环境安装 ===" -ForegroundColor Cyan
Write-Host ""

# 1. 检查是否已安装 Docker
$dockerPath = (Get-Command docker -ErrorAction SilentlyContinue)?.Source
if ($dockerPath) {
    Write-Host "Docker 已安装: $dockerPath" -ForegroundColor Green
    $version = docker --version 2>$null
    Write-Host "版本: $version" -ForegroundColor Green
} else {
    # 运行 Docker Desktop 安装程序
    $installer = "$PSScriptRoot\DockerDesktopInstaller.exe"
    if (-not (Test-Path $installer)) {
        Write-Host "错误: 找不到安装程序 $installer" -ForegroundColor Red
        exit 1
    }

    Write-Host "正在安装 Docker Desktop..." -ForegroundColor Yellow
    Write-Host "安装程序: $installer" -ForegroundColor Gray
    Write-Host ""
    Write-Host "提示: 安装过程中会弹出安装向导，请按提示操作。" -ForegroundColor Cyan
    Write-Host "      安装完成后需要重启电脑。" -ForegroundColor Cyan
    Write-Host ""

    Start-Process -FilePath $installer -Wait

    Write-Host ""
    Write-Host "Docker Desktop 安装完成！" -ForegroundColor Green
    Write-Host ""
    Write-Host "【重要】请立即重启电脑，然后重新运行此脚本继续。" -ForegroundColor Yellow -BackgroundColor Black
    Write-Host ""
    exit 0
}

# 2. 检查 Docker 服务是否运行
Write-Host ""
Write-Host "检查 Docker 服务状态..." -ForegroundColor Cyan

try {
    $info = docker info 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Docker 服务运行正常" -ForegroundColor Green
    } else {
        Write-Host "Docker 服务未启动，正在启动 Docker Desktop..." -ForegroundColor Yellow
        Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe" -WindowStyle Hidden
        Write-Host "等待 Docker 启动 (约 30 秒)..." -ForegroundColor Yellow
        for ($i = 30; $i -gt 0; $i--) {
            Write-Host -NoNewline "`r剩余 $i 秒..."
            Start-Sleep -Seconds 1
            $test = docker info 2>$null
            if ($LASTEXITCODE -eq 0) { break }
        }
        Write-Host ""
    }
} catch {
    Write-Host "Docker 服务检查失败: $_" -ForegroundColor Red
    exit 1
}

# 3. 验证 Docker Compose
Write-Host ""
Write-Host "检查 Docker Compose..." -ForegroundColor Cyan
$composeVersion = docker compose version 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Docker Compose 可用: $composeVersion" -ForegroundColor Green
} else {
    Write-Host "Docker Compose 不可用，请检查 Docker Desktop 安装" -ForegroundColor Red
    exit 1
}

# 4. 启动 COREONE
Write-Host ""
Write-Host "=== 启动 COREONE ===" -ForegroundColor Cyan
Write-Host ""

Set-Location $PSScriptRoot

# 安全：容器缺少 JWT_SECRET 会拒绝启动。若本机 .env 未提供，则生成强随机密钥并持久化到 .env。
$envFile = Join-Path $PSScriptRoot ".env"
$hasSecret = (Test-Path $envFile) -and (Select-String -Path $envFile -Pattern '^JWT_SECRET=' -Quiet)
if (-not $env:JWT_SECRET -and -not $hasSecret) {
    $bytes = New-Object 'System.Byte[]' 48
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $secret = [Convert]::ToBase64String($bytes)
    Add-Content -Path $envFile -Value "JWT_SECRET=$secret"
    Write-Host "已生成强随机 JWT_SECRET 并写入 .env（compose 将读取）。" -ForegroundColor Yellow
}

Write-Host "构建并启动容器..." -ForegroundColor Yellow
docker compose up -d --build

if ($LASTEXITCODE -ne 0) {
    Write-Host "启动失败，请检查上方错误信息" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "COREONE 已启动！" -ForegroundColor Green
Write-Host ""
Write-Host "访问地址: http://localhost:8080" -ForegroundColor Cyan
Write-Host "登录: 系统不再内置默认账号。初始 admin 的创建与已有账号重置请按 部署说明.md 执行。" -ForegroundColor Cyan
Write-Host ""
Write-Host "常用命令:" -ForegroundColor Gray
Write-Host "  docker compose logs -f    # 查看日志" -ForegroundColor Gray
Write-Host "  docker compose down       # 停止服务" -ForegroundColor Gray
Write-Host "  docker compose restart    # 重启服务" -ForegroundColor Gray
Write-Host ""
Write-Host "按任意键打开浏览器..." -ForegroundColor Yellow
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
Start-Process "http://localhost:8080"
