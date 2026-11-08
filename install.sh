#!/usr/bin/env bash
# dsh-superagent-reactive one-line install (Linux / macOS / WSL)
#
#   curl -fsSL https://raw.githubusercontent.com/hxh230802/dsh-superagent-prototype/main/install.sh | bash
#
# 幂等：探测依赖 → clone 或更新 → scripts/dsh-superagent init（建 Web profile、装 bundle、写 stateDir、起服务、打印地址）。
set -euo pipefail

REPO="https://github.com/hxh230802/dsh-superagent-prototype.git"
DIR="${DSA_DIR:-$HOME/dsh-superagent-prototype}"
PROFILE="${DSA_PROFILE:-superagent}"

fail() { printf '×  %s\n   %s\n' "$1" "${2:-}" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "缺少 $1" "${2:-}"; }

need git  'apt install git / brew install git'
need node 'https://nodejs.org（>= 22）'
need tmux 'apt install tmux / brew install tmux（start 需要）'
need dsh  'npm install -g @deepseek-ai/dsh@0.2.1-rc.3'
[ "$(node -v | sed 's/^v//; s/\..*$//')" -ge 22 ] || fail "Node $(node -v) 低于 22" 'https://nodejs.org'

python=$(command -v python3 || command -v python || true)
[ -n "$python" ] || fail '缺少 Python 3（只用来跑本机服务脚本，仅标准库）' 'apt install python3'

if [ -d "$DIR/.git" ]; then echo "更新 checkout：$DIR"; git -C "$DIR" pull --ff-only
else echo "克隆到：$DIR"; git clone --depth 1 "$REPO" "$DIR"; fi

echo "安装到 profile：$PROFILE"
"$python" "$DIR/scripts/dsh-superagent" init --profile "$PROFILE"

url_file="$DIR/.artifacts/control/profiles/$PROFILE/url.txt"
printf '\n装好了。\n'
if [ -f "$url_file" ]; then printf '  面板：%s/  （打开后点侧栏的 Superagent）\n' "$(cat "$url_file")"; fi
printf '  日常：%s scripts/dsh-superagent status|start|stop  （在 %s 下）\n' "$python" "$DIR"
