# ZeroAssistent - USB IoT Agent（Lumi）

这是一个在本地运行的 USB 物联网 Agent，配合 Qwen / DeepSeek 等大模型使用，可以：

- 自动识别当前连接的 USB / 串口设备（如 ESP8266）
- 根据你的自然语言需求，自动生成 MicroPython 或 C++（PlatformIO）代码
- 一键将生成的代码烧录到设备；支持电脑助手（润色、改代码、终端、做 PPT/Word 等）

示例需求：

- “让接在 GPIO5(D1) 的舵机从 0° 转到 90°，停 2 秒，再回到 0°，循环执行”
- “连接 Wi-Fi 并每隔 10 秒上传一次温湿度到服务器”

### 文档导航

| 文档 | 说明 |
|------|------|
| [功能介绍.md](功能介绍.md) | 硬件烧录、电脑助手、AI 编辑、工具箱等详细功能说明 |
| [密钥与密钥对说明.md](密钥与密钥对说明.md) | SSH 密钥、API 密钥、Lumi 开发者认证密钥的创建与使用 |
| [本地电脑搭建网站.md](本地电脑搭建网站.md) | 在本机/局域网运行 Lumi Web 的步骤 |
| [DEPLOY.md](DEPLOY.md) | 打包发布、Nginx、HTTPS、环境变量 |
| [阿里云发布步骤.md](阿里云发布步骤.md) | 在阿里云 ECS 上部署 Lumi 的详细步骤 |
| [公网发布具体步骤.md](公网发布具体步骤.md) | 公网域名与 HTTPS 发布流程 |

---

## 零、资源与依赖总览

以下为本项目用到的**全部资源**及用途，便于一次性配齐环境。

| 类型 | 资源 | 用途 | 是否必选 |
|------|------|------|----------|
| **Python 包** | pyserial | 列举串口设备（USB 识别） | 必选 |
| | requests | 调用模型 API、下载文件等 | 必选 |
| | flask | Web 界面（Lumi 前端） | 必选 |
| | gunicorn | 生产环境运行 Web 服务 | 可选（开发可只用 flask） |
| | mpremote | 向 MicroPython 设备上传/运行代码 | 必选（若用 MicroPython 烧录） |
| | pdf2docx | 工具箱：PDF 转 Word | 可选 |
| | python-pptx | 电脑助手：生成可打开的 .pptx 幻灯片 | 可选 |
| **可选 Python 包** | openai | 仅用于脚本 `scripts/test_deepseek_api.py` 验证 DeepSeek 密钥 | 可选 |
| | ruff | 工具箱「检查项目代码 (ruff)」静态检查 | 可选 |
| | platformio | C++ / PlatformIO 模式编译与烧录（`pio` 命令） | 可选（仅 C++ 模式需要） |
| **系统/驱动** | USB 转串口驱动（CH340/CP210x 等） | 识别 ESP8266/ESP32 等串口 | 必选（若用硬件烧录） |
| **设备固件** | MicroPython 固件 | 烧录到 ESP8266 后，才能用 mpremote 上传 .py | 必选（若用 MicroPython 模式） |
| **环境变量** | QWEN_API_BASE / QWEN_API_KEY | 本地或自建 OpenAI 兼容模型接口 | 三选一（见下文） |
| | DASHSCOPE_API_KEY | 阿里云 DashScope 模型 | 三选一 |
| | DEEPSEEK_API_KEY（及可选 DEEPSEEK_MODEL、DEEPSEEK_API_BASE） | DeepSeek 联网 API | 三选一 |

**Python 依赖版本**：项目根目录 `requirements.txt` 中写明了上述 Python 包及最低版本，可直接用 `pip install -r requirements.txt` 安装。

### 终端安装指令汇总

在终端中**按需**执行以下命令（建议先进入项目目录 `cd ~/Desktop/ZeroAssistent`）：

```bash
# 1. 核心依赖（必选）：一次安装 requirements.txt 中全部
pip install -r requirements.txt

# 2. 若仅想单独补装某几项（已用上面则无需重复）
pip install pyserial requests flask gunicorn mpremote pdf2docx python-pptx

# 3. 可选：DeepSeek 测试脚本依赖
pip install openai

# 4. 可选：工具箱「检查项目代码 (ruff)」
pip install ruff

# 5. 可选：C++ / PlatformIO 模式（需 pio 在 PATH）
pip install platformio
# 或从 https://platformio.org/install 安装 PlatformIO Core
```

**说明**：执行 `pip install -r requirements.txt` 即已包含 1 与 2 中的包；3、4、5 为按需额外安装。

**一键检测并安装（推荐）**：若希望由程序自动检测本机是否已安装上述依赖，未安装则自动执行 pip 安装，可使用：

```bash
# 在项目根目录执行
python scripts/install_dependencies.py
```

或在 Web 界面中打开 **工具箱 → 环境 →「检测并安装依赖」**，点击「运行」即可（需联网）。

### 环境变量汇总（模型接口与超时）

以下环境变量用于模型 API 与请求行为，**至少配置一种模型接口**（通常三选一）：

| 变量名 | 含义 | 示例（终端导出命令） |
|--------|------|----------------------|
| `QWEN_API_BASE` | 本地/自建 OpenAI 兼容接口地址 | `export QWEN_API_BASE=http://127.0.0.1:8000/v1` |
| `QWEN_API_KEY` | 上述接口的 API Key（若需要） | `export QWEN_API_KEY=你的token` |
| `DASHSCOPE_API_KEY` | 阿里云 DashScope API Key | `export DASHSCOPE_API_KEY=你的key` |
| `DEEPSEEK_API_KEY` | DeepSeek 官方 API Key | `export DEEPSEEK_API_KEY=你的密钥` |
| `DEEPSEEK_MODEL` | DeepSeek 模型名（可选，默认 deepseek-chat） | `export DEEPSEEK_MODEL=deepseek-chat` |
| `DEEPSEEK_API_BASE` | DeepSeek 自建兼容地址（可选） | `export DEEPSEEK_API_BASE=https://api.deepseek.com` |
| `PREFER_DEEPSEEK` | 优先使用 DeepSeek（1 时先连 DeepSeek） | `export PREFER_DEEPSEEK=1` |
| `QWEN_REQUEST_TIMEOUT` | 模型请求超时秒数（可选，默认 300） | `export QWEN_REQUEST_TIMEOUT=600` |
| `LUMI_MODEL` / `QWEN_MODEL` | 本地 Qwen 使用的模型名（可选） | `export QWEN_MODEL=qwen2.5-coder-14b` |

持久化方式（按 shell 选一种）：

```bash
# Bash / Zsh：写入 ~/.bashrc 或 ~/.zshrc 后执行 source ~/.bashrc
echo 'export DEEPSEEK_API_KEY=你的密钥' >> ~/.zshrc
source ~/.zshrc
```

---

## 一、环境准备

### 1. 安装依赖

在终端中执行（确保当前目录为项目根目录）：

```bash
cd ~/Desktop/ZeroAssistent
pip install -r requirements.txt
```

### 2. 准备 Qwen Coder 2.5 接口

#### 方案 A：本地 / 自建 Qwen Coder 2.5（推荐）

假设你已经在本地或服务器上以 **OpenAI 兼容接口** 方式部署了 Qwen Coder 2.5，例如：

- `http://127.0.0.1:8000/v1`（常见的本地部署地址）

在终端中设置：

```bash
export QWEN_API_BASE=http://127.0.0.1:8000/v1
# 如你的服务需要鉴权，则再设置：
export QWEN_API_KEY=你的本地服务token
```

`usb_iot_agent.py` 会优先读取 `QWEN_API_BASE` / `QWEN_API_KEY`，使用 OpenAI 兼容的 `/chat/completions` 接口与本地 Qwen 通信。

#### 方案 B：DashScope 兼容 OpenAI 协议（备选）

如果暂时没有本地部署，也可以继续使用阿里云 DashScope：

1. 在 DashScope 控制台创建并获取 API Key  
2. 在终端中设置环境变量：

```bash
export DASHSCOPE_API_KEY=你的key
```

当未设置 `QWEN_API_BASE` 时，程序会自动回退使用 DashScope。

#### 方案 C：DeepSeek 联网 API（可选）

使用 DeepSeek 官方联网 API 时，只需设置环境变量（**请勿把密钥写进代码或提交到仓库**）：

```bash
export DEEPSEEK_API_KEY=你的DeepSeek_API_Key
```

可选：

- `DEEPSEEK_MODEL`：模型名，默认 `deepseek-chat`，可改为 `deepseek-reasoner` 等
- `DEEPSEEK_API_BASE`：自建兼容地址，默认 `https://api.deepseek.com`

本程序通过 `https://api.deepseek.com/v1/chat/completions`、`Bearer` 鉴权与 `deepseek-chat` 模型调用，与官方 OpenAI 兼容方式一致。可在终端用样例脚本单独验证密钥是否可用：

```bash
pip3 install openai
export DEEPSEEK_API_KEY=你的密钥
python3 scripts/test_deepseek_api.py
```

**自动选择**：当配置了多个接口时，程序会依次尝试连接，使用**第一个连接成功**的 API（约 60 秒内复用，避免重复探测）。每个接口探测时都会使用**该接口对应的模型名**（如 DeepSeek 用 `deepseek-chat`，本地 Qwen 用 `qwen2.5-coder-14b`），不会误把 DeepSeek 模型发给本地 Qwen。若你主要用 DeepSeek 且同时配置了 `QWEN_API_BASE`（如本地未启动），可设置 `PREFER_DEEPSEEK=1`，会**优先尝试 DeepSeek**，减少等待。

### 3. 设备侧准备（让 Lumi 直接操作你的设备）

1. **硬件**：用 USB 线把设备（如 ESP8266）接到电脑。
2. **驱动**：安装 USB 转串口驱动（CH340 / CP210x 等），确保系统能识别串口。
3. **MicroPython**：若用 MicroPython 模式，需先给 ESP8266 烧录一次 MicroPython 固件（之后即可用 Lumi 直接写代码并烧录）。
4. **mpremote**：终端里执行 `pip install mpremote`，用于上传代码到设备（Web 界面会检测，未安装时会有提示）。

完成以上后，Lumi 即可在界面中列出设备、生成代码并一键烧录到你的板子。

## 二、运行 Agent（全自动流程）

在终端执行：

```bash
cd ~/Desktop/ZeroAssistent
python usb_iot_agent.py
```

流程说明：

1. 程序会自动列出当前所有串口设备，并尝试猜测哪一个是 ESP8266
2. 你可以直接回车使用猜测结果，或手动输入序号选择设备
3. 按提示输入自然语言需求（例如上面舵机控制的例子）
4. 程序会调用 Qwen Coder 2.5 生成 MicroPython 代码，并显示前 80 行预览
5. 输入 `y` 确认后，会自动将该代码上传为 ESP8266 的 `main.py`
6. 重启或复位 ESP8266，代码即会自动运行

## 三、自定义硬件约束

在 `usb_iot_agent.py` 中有一段硬件约束示例：

```python
extra_hardware_context = (
    "\\n硬件约束示例（可根据实际接线修改）：\\n"
    "- 舵机信号线接到 GPIO 5（D1）。\\n"
    "- 使用 machine.PWM 控制舵机，占空比映射到 0~180 度。\\n"
)
```

你可以根据自己的实际接线情况修改这段内容，以便 Qwen Coder 2.5 生成更加贴合你硬件的代码。

## 四、Web 界面与自动化工具箱

除命令行外，可通过 Web 界面使用 Lumi（集成度更高、支持多开发板与自动化脚本）：

```bash
cd ~/Desktop/ZeroAssistent
python web_app.py
```

浏览器访问 `http://127.0.0.1:5000` 即可。

### 如何让 Lumi 直接操作你的设备（Web 界面三步）

1. **连接设备**：用 USB 线把 ESP8266（或其它支持的板子）接到电脑，确保已装好串口驱动。
2. **选择串口**：打开「硬件烧录」页，左侧会列出当前串口设备；点击你要用的那一项（或保持自动猜测的高亮项）。
3. **发指令并烧录**：在输入框里用自然语言描述需求（如「让 GPIO5 的舵机转 90 度」），发送后 Lumi 会生成代码；出现「是否将上一条指令生成的代码烧录到设备？」时点 **「烧录到设备」**，代码会通过 mpremote 上传为设备上的 `main.py`，设备复位后即运行。

若未安装 mpremote，请先执行 `pip install mpremote`；工具箱里也有「烧录上次代码」「检测 MicroPython」等快捷操作。

### 如何让 Lumi 直接操作你的电脑

在 **电脑助手**（左侧栏「PC助手」）里，用自然语言描述你想在电脑上做的事，Lumi 会给出对应的终端命令或脚本，你即可在本地执行：

1. **打开电脑助手**：左侧栏点击「PC助手」。
2. **描述任务**：例如「列出当前目录下的所有 .py 文件」「用 Python 运行桌面上的 test.py」「把某文件夹打成 zip」。
3. **发送**：Lumi 会自动识别为「终端命令」模式并返回一条可执行的命令。
4. **执行**：若回复中给出的是终端命令，输入框旁会出现 **「执行命令」** 按钮，点击后该命令会在你电脑上执行，结果会显示在对话里。

支持的操作包括：列出/查看文件、运行 Python 脚本、压缩解压、pip 安装、curl/wget 下载等（受安全白名单限制，不会执行 `rm -rf /` 等危险命令）。此外，说「润色桌面上的 xxx.docx」或「修改某路径的 main.py」时，Lumi 会直接读该文件、改完后写回，无需你复制粘贴。

### 功能概览

详细功能说明见 **[功能介绍.md](功能介绍.md)**。

- **聊天式交互**：输入自然语言需求，自动生成 MicroPython 或 C++（PlatformIO）代码，并可一键烧录。
- **多开发板**：在「C++ / PlatformIO 模式」下可选择开发板（ESP8266、ESP32、STM32、Arduino Uno 等），无需改环境变量。
- **自动化工具箱**（右侧面板）：
  - **维护**：清理 Lumi 缓存（临时工程、缓存文件）。
  - **设备**：刷新串口列表、检测 MicroPython 设备、烧录上次代码。
  - **环境**：检查 PlatformIO 是否安装及版本。
  - **代码**：将当前生成的代码导出到桌面（.py / .cpp）。

工具箱脚本在界面中按分类展示，点击「运行」即可执行，结果会输出到「模型进程」日志区域。

## 五、打包成网站发布

要把 Lumi 部署成可公网或局域网访问的网站，可按以下三种方式任选其一（详细步骤见 **[DEPLOY.md](DEPLOY.md)**）。

| 方式 | 适用场景 | 终端命令示例 |
|------|----------|--------------|
| **直接运行** | 本机/内网快速试运行 | `FLASK_HOST=0.0.0.0 PORT=8000 python web_app.py` |
| **Gunicorn** | 生产环境、多进程稳定运行 | `gunicorn -w 4 -b 0.0.0.0:8000 "web_app:create_app()"` |
| **Docker** | 服务器一键部署、环境隔离 | `docker build -t lumi . && docker run -d -p 8000:5000 -e DEEPSEEK_API_KEY=你的密钥 lumi` |

**上线前必做**：配置至少一种模型接口（如 `export DEEPSEEK_API_KEY=你的密钥`），否则助手功能不可用。  
**说明**：部署到远程服务器时，USB/串口相关功能不可用，Web 界面与电脑助手（依赖 API）可正常使用。  
完整说明（Nginx 反向代理、HTTPS、环境变量表）见 **[DEPLOY.md](DEPLOY.md)**。

## 六、扩展方向（可选）

- 将 ESP8266 更换为 ESP32 / ESP32-CAM，并扩展到摄像头与人脸识别场景
- 为多个串口设备（多块板子）批量生成和烧录不同的代码
- 为生成代码增加本地安全审查逻辑（限制某些危险操作后再允许烧录）
- 在 `usb_iot_agent.py` 的 `TOOLBOX_SCRIPTS` 中增加更多自动化脚本

