#!/usr/bin/env python3
"""
检测并自动安装 Lumi 项目所需依赖。
若本机未安装 requirements.txt 中的包或可选包（openai、ruff、platformio），
则通过 pip 自动下载安装。需联网。

用法（在项目根目录或任意目录执行）：
  python scripts/install_dependencies.py
  或
  python -m scripts.install_dependencies
"""
import os
import sys
import subprocess

# 保证能导入 usb_iot_agent（项目根在 path 中）
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from usb_iot_agent import get_project_root, install_missing_dependencies


def main():
    logs = []
    ok, msg = install_missing_dependencies(logs)
    for line in logs:
        print(line)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
