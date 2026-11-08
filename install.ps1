# dsh-superagent-reactive one-line install (Windows PowerShell)
#
#   irm https://raw.githubusercontent.com/hxh230802/dsh-superagent-prototype/main/install.ps1 | iex
#
# 幂等：探测依赖 → clone/更新 → scripts/dsh-superagent init（建 Web profile、装 bundle、写 stateDir、起服务、打印地址）。
# 重跑只更新，不会建第二个 profile，也不会起第二个实例。
# 可用环境变量覆盖：DSA_DIR（checkout 目录）、DSA_PROFILE（profile 名）。

$Dir = if ($env:DSA_DIR) { $env:DSA_DIR } else { Join-Path $HOME 'dsh-superagent-prototype' }
$Profile = if ($env:DSA_PROFILE) { $env:DSA_PROFILE } else { 'superagent' }
$Repo = 'https://github.com/hxh230802/dsh-superagent-prototype.git'

function Fail($message, $hint) {
  Write-Host "×  $message" -ForegroundColor Red
  if ($hint) { Write-Host "   $hint" -ForegroundColor Yellow }
  throw $message          # 不用 exit：在 irm | iex 下 exit 会关掉用户窗口
}

function Major($command, $argv) {
  try { $text = & $command @argv 2>$null } catch { return 0 }
  if ("$text" -match '(\d+)') { return [int]$Matches[1] }
  return 0
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail '缺少 git' 'winget install --id Git.Git -e' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail '缺少 Node.js' 'winget install --id OpenJS.NodeJS.LTS -e' }
if ((Major 'node' @('-v')) -lt 22) { Fail "Node.js $(& node -v) 低于 22" 'winget install --id OpenJS.NodeJS.LTS -e' }
if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) { Fail '缺少 dsh' 'npm install -g @deepseek-ai/dsh@0.2.1-rc.3' }

$python = if (Get-Command python -ErrorAction SilentlyContinue) { 'python' }
          elseif (Get-Command py -ErrorAction SilentlyContinue) { 'py' }
          else { $null }
if (-not $python) { Fail '缺少 Python 3（只用来跑本机服务脚本，仅标准库）' 'winget install --id Python.Python.3.12 -e' }

if (Test-Path (Join-Path $Dir '.git')) {
  Write-Host "更新 checkout：$Dir"
  & git -C $Dir pull --ff-only
} else {
  Write-Host "克隆到：$Dir"
  & git clone --depth 1 $Repo $Dir
}
if ($LASTEXITCODE -ne 0) { Fail 'git 失败' "检查网络，或手动 git clone $Repo $Dir" }

Write-Host "安装到 profile：$Profile"
& $python (Join-Path $Dir 'scripts\dsh-superagent') init --profile $Profile
if ($LASTEXITCODE -ne 0) { Fail "init 退出码 $LASTEXITCODE" "看 $Dir\.artifacts 下最新的日志" }

$urlFile = Join-Path $Dir ".artifacts\control\profiles\$Profile\url.txt"
$url = if (Test-Path $urlFile) { (Get-Content $urlFile -Raw).Trim() } else { '' }
Write-Host ''
Write-Host '装好了。' -ForegroundColor Green
if ($url) { Write-Host "  面板：$url/  （打开后点侧栏的 Superagent）" -ForegroundColor Cyan }
Write-Host "  日常：$python scripts\dsh-superagent status|start|stop   （在 $Dir 下）" -ForegroundColor DarkGray
