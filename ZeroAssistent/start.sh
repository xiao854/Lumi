#!/usr/bin/env bash
# Lumi 生产环境一键启动脚本（Gunicorn）
# 用法：./start.sh  或  bash start.sh
# 需先安装依赖：pip install -r requirements.txt
# 建议先设置环境变量：export DEEPSEEK_API_KEY=你的密钥 等

set -e
cd "$(dirname "$0")"
PORT="${PORT:-8000}"
WORKERS="${GUNICORN_WORKERS:-4}"

echo "Lumi 启动中：0.0.0.0:${PORT} (workers=${WORKERS})"
exec gunicorn -w "$WORKERS" -b "0.0.0.0:${PORT}" "web_app:create_app()"
