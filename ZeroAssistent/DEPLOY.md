# ZeroAssistent 打包上线指南

将项目部署为可公网或局域网访问的网站时，按以下方式运行并配置环境变量即可。

**想按步骤一步步做？**  
- **阿里云 ECS + 阿里云域名**：直接看 **[阿里云发布步骤.md](阿里云发布步骤.md)**。  
- 其他云 / 自建机：看 **[公网发布具体步骤.md](公网发布具体步骤.md)**，从「准备服务器」到「浏览器访问」按顺序执行即可。

---

## 快速发布（三种方式任选）

| 方式 | 命令 | 说明 |
|------|------|------|
| **脚本启动** | `chmod +x start.sh && ./start.sh` | 本机/服务器用 Gunicorn 监听 8000，需先 `pip install -r requirements.txt` |
| **Docker 单容器** | `docker build -t lumi . && docker run -d -p 8000:5000 -e DEEPSEEK_API_KEY=你的密钥 lumi` | 一键构建并后台运行，端口 8000 |
| **Docker Compose** | `cp .env.example .env` → 编辑 `.env` 填密钥 → `docker-compose up -d` | 用 `.env` 管理环境变量，端口 8000 |

访问：`http://服务器IP:8000`（或本机 `http://127.0.0.1:8000`）。  
**使用公网域名（如 https://lumi.你的域名.com）**：见 **四、使用公网域名（Nginx + HTTPS）**，按步骤做域名解析、Nginx 反向代理和 Let's Encrypt 证书即可。  
上线前务必配置至少一种模型 API（见下文「三、环境变量」）。

---

## 一、环境与依赖

在服务器或本机执行：

```bash
cd /path/to/ZeroAssistent
pip install -r requirements.txt
```

## 二、运行方式

### 方式 A：直接运行（开发或小流量）

```bash
# 仅本机访问（默认）
python web_app.py

# 允许局域网/外网访问，并指定端口
export FLASK_HOST=0.0.0.0
export PORT=8000
python web_app.py
```

- `FLASK_HOST=0.0.0.0`：监听所有网卡，可从其他机器访问  
- `PORT`：端口，默认 5000  
- 生产环境建议关闭 debug：不设置 `FLASK_DEBUG`，或 `FLASK_DEBUG=0`

### 方式 B：Gunicorn（推荐生产环境）

多进程、更稳定，适合正式上线：

```bash
# 安装依赖后执行（4 个 worker，绑定 0.0.0.0:8000）
gunicorn -w 4 -b 0.0.0.0:8000 "web_app:create_app()"
```

- `-w 4`：worker 数量，可按 CPU 核数调整  
- `-b 0.0.0.0:8000`：监听地址与端口  
- 需指定 `"web_app:create_app()"`，因为应用由工厂函数 `create_app()` 创建  

通过环境变量改端口示例：

```bash
export PORT=8000
gunicorn -w 4 -b 0.0.0.0:${PORT} "web_app:create_app()"
```

## 三、上线前必须配置的环境变量

至少配置一种模型接口，否则 Lumi 助手等功能不可用：

| 变量 | 说明 |
|------|------|
| `QWEN_API_BASE` | 本地/自建 Qwen OpenAI 兼容接口，如 `http://127.0.0.1:8000/v1` |
| `QWEN_API_KEY` 或 `DASHSCOPE_API_KEY` | 对应接口的 API Key（若需要） |
| `DEEPSEEK_API_KEY` | 使用 DeepSeek 时填写 |

可选：

| 变量 | 说明 |
|------|------|
| `PORT` | 服务端口（默认 5000） |
| `FLASK_HOST` | 绑定地址，上线填 `0.0.0.0` |
| `FLASK_DEBUG` | 设为 `0` 或留空，生产不要开 debug |

示例（使用 DeepSeek 并监听 8000 端口）：

```bash
export DEEPSEEK_API_KEY=你的密钥
export FLASK_HOST=0.0.0.0
export PORT=8000
gunicorn -w 4 -b 0.0.0.0:8000 "web_app:create_app()"
```

## 四、使用公网域名（Nginx + HTTPS）

要用**公网域名**访问 Lumi（如 `https://lumi.你的域名.com`），按以下步骤操作。

### 1. 域名解析

在域名服务商处添加 **A 记录**，把域名指到你的服务器公网 IP：

| 类型 | 主机记录 | 记录值 |
|------|----------|--------|
| A    | `lumi` 或 `@` | `你的服务器公网IP` |

- 主机记录填 `lumi` 时，访问地址为 `https://lumi.你的域名.com`
- 填 `@` 时，访问地址为 `https://你的域名.com`

解析生效后，在本地执行 `ping lumi.你的域名.com` 应能解析到该 IP。

### 2. 安装 Nginx 与 Certbot（Ubuntu/Debian 示例）

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
```

其他系统可从 [Nginx 官网](https://nginx.org/) 与 [Certbot 官网](https://certbot.eff.org/) 按系统选择安装方式。

### 3. Nginx 站点配置（先 HTTP，再配 HTTPS）

创建站点配置（将 `lumi.你的域名.com` 换成你的域名）。项目内已提供示例：`deploy/nginx-lumi.conf.example`，可复制后改域名使用。

```bash
sudo nano /etc/nginx/sites-available/lumi
```

写入以下内容（**先只保留 80 端口**，下一步用 Certbot 自动加 443）：

```nginx
server {
    listen 80;
    server_name lumi.你的域名.com;
    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        chunked_transfer_encoding off;
        proxy_read_timeout 300;
        proxy_connect_timeout 300;
        proxy_send_timeout 300;
    }
}
```

启用站点并重载 Nginx：

```bash
sudo ln -sf /etc/nginx/sites-available/lumi /etc/nginx/sites-enabled/
sudo nginx -t
sudo nginx -s reload
```

### 4. 申请 HTTPS 证书（Let's Encrypt）

在服务器上执行（**确保域名已解析到本机**）：

```bash
sudo certbot --nginx -d lumi.你的域名.com
```

按提示输入邮箱、同意条款后，Certbot 会自动修改 Nginx 配置、申请证书并开启 443。若希望访问 HTTP 时自动跳转到 HTTPS，在提示时选择 “Redirect” 即可。

证书续期（Let's Encrypt 约 90 天有效，可自动续期）：

```bash
sudo certbot renew --dry-run
```

若正常，可加入 crontab 定期执行：`sudo crontab -e`，添加一行：

```cron
0 3 * * * certbot renew --quiet
```

### 5. 启动 Lumi 应用（仅监听本机）

Nginx 已对外 80/443，应用只需监听本机 8000，避免直接暴露：

```bash
cd /path/to/ZeroAssistent
export DEEPSEEK_API_KEY=你的密钥
gunicorn -w 4 -b 127.0.0.1:8000 "web_app:create_app()"
```

或用项目自带的启动脚本前先改端口与绑定（在 `start.sh` 同目录）：

```bash
export PORT=8000
# 若 start.sh 里是 0.0.0.0，可改为 127.0.0.1，仅让 Nginx 访问
gunicorn -w 4 -b 127.0.0.1:8000 "web_app:create_app()"
```

建议用 systemd 或 supervisor 托管 Gunicorn，保证掉线自启。示例 systemd 单元（`/etc/systemd/system/lumi.service`）：

```ini
[Unit]
Description=Lumi Web
After=network.target

[Service]
User=你的用户名
WorkingDirectory=/path/to/ZeroAssistent
Environment="DEEPSEEK_API_KEY=你的密钥"
Environment="PORT=8000"
ExecStart=/usr/bin/gunicorn -w 4 -b 127.0.0.1:8000 "web_app:create_app()"
Restart=always

[Install]
WantedBy=multi-user.target
```

然后执行：

```bash
sudo systemctl daemon-reload
sudo systemctl enable lumi
sudo systemctl start lumi
sudo systemctl status lumi
```

### 6. 访问与检查

- 浏览器打开：`https://lumi.你的域名.com`
- 若证书与 Nginx 正常，即可看到 Lumi 界面；若报错，可查看 `sudo nginx -t`、`sudo tail -f /var/log/nginx/error.log` 和 Gunicorn 进程是否在监听 8000。

## 五、Docker 部署

项目根目录已提供 `Dockerfile`，可直接构建并运行。

**方式 1：单次运行**

```bash
docker build -t lumi .
docker run -d -p 8000:5000 -e DEEPSEEK_API_KEY=你的密钥 lumi
```

浏览器访问 `http://本机或服务器IP:8000`。按需增加 `-e QWEN_API_BASE=...`、`-e DASHSCOPE_API_KEY=...` 等。

**方式 2：Docker Compose（推荐，便于管理环境变量）**

```bash
cp .env.example .env
# 编辑 .env，填写 DEEPSEEK_API_KEY 或 QWEN_API_BASE 等
docker-compose up -d
```

端口 8000 映射到容器内 5000；重启策略为 `unless-stopped`。修改 `.env` 后执行 `docker-compose up -d` 即可生效。

## 六、注意事项

- **USB/串口**：部署在远程服务器时无法连接本机硬件，设备相关功能会显示“未连接”或不可用，Lumi 网页与助手对话（依赖已配置的 API）可正常使用。  
- **密钥安全**：不要将 API Key 写进代码或提交到仓库，使用环境变量或密钥管理服务。  
- **HTTPS**：对外提供登录或敏感操作时，建议用 Nginx/Caddy 配置 HTTPS（Let’s Encrypt 等）。

按以上步骤即可将 ZeroAssistent 打包并在本机或云服务器上线运行。
