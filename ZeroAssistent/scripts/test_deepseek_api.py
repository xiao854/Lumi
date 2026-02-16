#!/usr/bin/env python3
"""
DeepSeek API 官方样例：用于在终端快速验证 DEEPSEEK_API_KEY 是否可用。
使用前请先安装: pip3 install openai
并设置环境变量: export DEEPSEEK_API_KEY=你的密钥
"""
import os
from openai import OpenAI

def main():
    api_key = os.environ.get("DEEPSEEK_API_KEY")
    if not api_key:
        print("请先设置环境变量: export DEEPSEEK_API_KEY=你的密钥")
        return 1

    client = OpenAI(
        api_key=api_key,
        base_url="https://api.deepseek.com",
    )

    print("正在调用 DeepSeek API（非流式）...")
    response = client.chat.completions.create(
        model="deepseek-chat",
        messages=[
            {"role": "system", "content": "You are a helpful assistant"},
            {"role": "user", "content": "Hello"},
        ],
        stream=False,
    )
    print(response.choices[0].message.content)
    print("\n✓ DeepSeek API 连接正常")
    return 0

if __name__ == "__main__":
    exit(main())
