from __future__ import annotations

import os
import re
import shutil
import sys
import threading
import time
import uuid
from datetime import datetime, timedelta
from typing import Optional

from flask import Flask, Response, jsonify, render_template, request, send_from_directory, stream_with_context

# 一些 Windows + Python 组合下，Flask 在启动时会调用 socket.getfqdn(host)
# 若主机名或反向解析结果包含非 UTF-8 字节，可能触发 UnicodeDecodeError 导致服务无法启动。
# 这里为 getfqdn 打一个“安全补丁”：一旦解码失败就回退到 "localhost"。
import socket

_orig_getfqdn = socket.getfqdn


def _safe_getfqdn(name: str = "") -> str:
    try:
        return _orig_getfqdn(name)
    except UnicodeDecodeError:
        return "localhost"


socket.getfqdn = _safe_getfqdn

LUMI_AGENT_VERSION = "v1.2602"

from usb_iot_agent import (
    list_serial_devices,
    guess_esp8266_port,
    get_supported_boards,
    get_toolbox_scripts,
    run_toolbox_script,
    call_qwen_coder,
    call_qwen_coder_multi_file,
    call_qwen_cpp_for_platformio,
    call_qwen_code_complete,
    call_qwen_code_optimize,
    call_qwen_assistant,
    call_qwen_assistant_stream,
    run_assistant_terminal,
    resolve_file_path_from_instruction,
    resolve_folder_path_from_instruction,
    resolve_create_target_from_instruction,
    get_mentioned_file_paths,
    read_file_content_for_assistant,
    extract_content_to_write_from_reply,
    extract_html_from_reply,
    write_assistant_result_to_file,
    list_directory_for_assistant,
    read_folder_files_for_assistant,
    write_assistant_results_to_folder,
    ensure_directory_and_write_files,
    _parse_multi_file_output,
    extract_run_command_from_reply,
    extract_run_commands_from_reply,
    infer_assistant_mode,
    write_temp_code,
    flash_micropython_main,
    flash_micropython_files,
    build_and_upload_platformio,
    clear_lumi_cache,
    ping_qwen_model,
    get_model_provider_info,
    _get_working_endpoint,
    edit_desktop_file,
    edit_file_preview,
    edit_file_apply,
    get_project_root,
    is_path_under_allowed_bases,
    read_file_for_preview,
    open_file_in_system,
    open_folder_in_system,
    open_xcode_project,
    download_github_file,
    github_search_and_download,
)

# 网页内预览：preview_id -> 项目根目录绝对路径（仅允许桌面/项目根下）
_preview_roots: dict = {}


def create_app() -> Flask:
    app = Flask(__name__, static_folder="static", template_folder="templates")

    def start_daily_cache_cleanup():
        """
        启动一个后台线程，每天 0 点清理一次 Lumi 相关缓存文件。
        """

        def worker():
            while True:
                now = datetime.now()
                tomorrow = now.date() + timedelta(days=1)
                midnight = datetime.combine(tomorrow, datetime.min.time())
                wait_seconds = (midnight - now).total_seconds()
                if wait_seconds < 0:
                    wait_seconds = 60
                time.sleep(wait_seconds)
                try:
                    logs: list[str] = []
                    clear_lumi_cache(logs)
                    for line in logs:
                        print(f"[CACHE] {line}")
                except Exception as e:
                    print(f"[CACHE] 清理缓存时出错: {e}")

        t = threading.Thread(target=worker, daemon=True)
        t.start()

    @app.route("/")
    def index():
        devices = list_serial_devices()
        guessed: Optional[str] = guess_esp8266_port(devices) if devices else None
        return render_template("index.html", devices=devices, guessed=guessed, lumi_agent_version=LUMI_AGENT_VERSION)

    @app.route("/favicon.ico")
    def favicon():
        """标签页图标：很多浏览器会优先请求 /favicon.ico，此处直接返回 static/title-logo.jpg"""
        resp = send_from_directory(
            app.static_folder,
            "title-logo.jpg",
            mimetype="image/jpeg",
        )
        resp.headers["Cache-Control"] = "public, max-age=3600"
        return resp

    @app.route("/api/devices", methods=["GET"])
    def api_devices():
        force = request.args.get("refresh", "").lower() in ("1", "true", "yes")
        devices = list_serial_devices(force_refresh=force)
        guessed: Optional[str] = guess_esp8266_port(devices) if devices else None
        return jsonify({"devices": devices, "guessed": guessed})

    @app.route("/api/status", methods=["GET"])
    def api_status():
        """返回当前 Agent 运行环境状态（API Key、mpremote、当前模型接口等）"""
        has_api_key = bool(
            os.environ.get("DASHSCOPE_API_KEY")
            or os.environ.get("QWEN_API_BASE")
            or os.environ.get("DEEPSEEK_API_KEY")
        )
        mpremote_path = shutil.which("mpremote")
        pio_path = shutil.which(os.environ.get("PLATFORMIO", "pio"))
        # 先探测一次可用接口并写入缓存，这样「当前模型接口」显示的是实际连上的 API
        try:
            _get_working_endpoint()
        except Exception:
            pass
        provider_info = get_model_provider_info()
        return jsonify(
            {
                "has_api_key": has_api_key,
                "has_mpremote": bool(mpremote_path),
                "mpremote_path": mpremote_path,
                "has_platformio": bool(pio_path),
                "platformio_path": pio_path,
                "model_provider": provider_info.get("provider", ""),
                "model_provider_label": provider_info.get("label", ""),
                "model_name": provider_info.get("model", ""),
            }
        )

    @app.route("/api/version", methods=["GET"])
    def api_version():
        """返回 Lumi 与运行环境版本信息，供开发者调试使用"""
        return jsonify(
            {
                "app": "Lumi USB IoT Agent",
                "agent_version": LUMI_AGENT_VERSION,
                "python": sys.version.split()[0],
                "python_full": sys.version.strip(),
            }
        )

    @app.route("/api/developer/verify", methods=["POST"])
    def api_developer_verify():
        """开发者认证：校验密钥，正确则前端可展示开发者问候语"""
        data = request.get_json(force=True) or {}
        key = (data.get("key") or data.get("secret") or "").strip()
        secret = os.environ.get("LUMI_DEV_SECRET", "273751877MoXiaoyun")
        ok = key == secret
        return jsonify({"ok": ok})

    @app.route("/api/boards", methods=["GET"])
    def api_boards():
        """返回支持的 PlatformIO 开发板列表，供 C++ 模式下的下拉选择"""
        return jsonify({"boards": get_supported_boards()})

    @app.route("/api/toolbox", methods=["GET"])
    def api_toolbox_list():
        """返回自动化脚本工具箱列表"""
        return jsonify({"scripts": get_toolbox_scripts()})

    @app.route("/api/toolbox/run", methods=["POST"])
    def api_toolbox_run():
        """执行指定工具箱脚本。body: { script_id, params?: {} }"""
        data = request.get_json(force=True) or {}
        script_id = (data.get("script_id") or "").strip()
        params = data.get("params") or {}

        if not script_id:
            return jsonify({"ok": False, "error": "缺少 script_id", "logs": []}), 400

        logs = []
        try:
            ok, result = run_toolbox_script(script_id, params, logs)
            return jsonify({"ok": ok, "logs": logs, "data": result})
        except Exception as e:
            logs.append(f"执行失败: {e}")
            return jsonify({"ok": False, "error": str(e), "logs": logs}), 500

    @app.route("/api/code-complete", methods=["POST"])
    def api_code_complete():
        """对用户提供的源代码进行补全。body: { code, language_hint? }"""
        data = request.get_json(force=True) or {}
        code = (data.get("code") or "").strip()
        language_hint = (data.get("language_hint") or "").strip()
        if not code:
            return jsonify({"ok": False, "error": "代码不能为空"}), 400
        try:
            result = call_qwen_code_complete(code, language_hint=language_hint)
            return jsonify({"ok": True, "code": result})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500

    @app.route("/api/code-optimize", methods=["POST"])
    def api_code_optimize():
        """对用户提供的源代码进行优化。body: { code, instruction? }"""
        data = request.get_json(force=True) or {}
        code = (data.get("code") or "").strip()
        instruction = (data.get("instruction") or "").strip()
        if not code:
            return jsonify({"ok": False, "error": "代码不能为空"}), 400
        try:
            result = call_qwen_code_optimize(code, instruction=instruction)
            return jsonify({"ok": True, "code": result})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500

    @app.route("/api/model-ping", methods=["GET"])
    def api_model_ping():
        """
        轻量探测您的本地API是否可用，并返回简单延迟。
        前端可据此给出更直观的连接状态提示，便于调试超时问题。
        """
        result = ping_qwen_model()
        status_code = 200 if result.get("ok") else 500
        return jsonify(result), status_code

    def _is_github_download_and_flash(text: str) -> bool:
        """判断是否为「从 GitHub 下载并烧录」类指令。"""
        t = (text or "").lower()
        if "github" not in t:
            return False
        if not any(k in t for k in ("下载", "拉取", "获取", "找", "搜索")):
            return False
        if not any(k in t for k in ("烧录", "烧写", "上传", "刷入", "写入设备")):
            return False
        return True

    @app.route("/api/run", methods=["POST"])
    def api_run():
        data = request.get_json(force=True) or {}
        instruction = (data.get("instruction") or "").strip()
        port = (data.get("port") or "").strip()
        auto_flash = bool(data.get("auto_flash", True))
        mode = (data.get("mode") or "micropython").strip()  # micropython | platformio
        reuse_code = bool(data.get("reuse_code", False))
        multi_file = bool(data.get("multi_file", False))  # 多文件 MicroPython 项目
        client_code = data.get("code") or ""
        board_id = (data.get("board_id") or "").strip() or None
        platform = (data.get("platform") or "").strip() or None

        if not instruction and not reuse_code:
            return jsonify({"ok": False, "error": "指令不能为空"}), 400

        devices = list_serial_devices()
        if not devices:
            return jsonify({"ok": False, "error": "未检测到任何串口设备"}), 400

        if not port:
            port = guess_esp8266_port(devices) or devices[0]["device"]

        logs = []

        def log(msg: str):
            logs.append(msg)
            print(msg)

        try:
            if reuse_code and client_code:
                # 复用前一次已经生成好的代码，不再重新调用模型
                log("使用上一次生成的代码进行烧录，不再重新调用模型。")
                code = client_code
            elif _is_github_download_and_flash(instruction):
                # 从 GitHub 搜索并下载源文件，再烧录（不生成代码）
                log("检测到「从 GitHub 下载并烧录」类指令，正在搜索并下载源文件…")
                code, source_info = github_search_and_download(instruction, logs)
                log(f"来源: {source_info}")
            else:
                if mode == "micropython" and multi_file:
                    log("正在调用 Qwen Coder 2.5 生成多文件 MicroPython 项目...")
                    files_dict = call_qwen_coder_multi_file(instruction)
                    code = files_dict.get("main.py", "") or (list(files_dict.values())[0] if files_dict else "")
                    # 多文件预览：每个文件前 30 行
                    _preview_max_lines = 30
                    _preview_max_chars = 8000
                    preview_parts = []
                    for fp, content in sorted(files_dict.items()):
                        preview_parts.append(f"=== {fp} ===")
                        for i, line in enumerate(content.splitlines()[: _preview_max_lines], 1):
                            preview_parts.append(f"{i:3}: {line}")
                        if len(content.splitlines()) > _preview_max_lines:
                            preview_parts.append("... (已截断)")
                    preview_str = "\n".join(preview_parts)
                    if len(preview_str) > 20000:
                        preview_str = preview_str[:20000] + "\n...(预览已截断)"
                    if auto_flash and files_dict:
                        log(f"将使用串口设备: {port}")
                        flash_micropython_files(port, files_dict, logs)
                    return jsonify(
                        {
                            "ok": True,
                            "port": port,
                            "preview": preview_str,
                            "code": code,
                            "files": files_dict,
                            "multi_file": True,
                            "logs": logs,
                        }
                    )
                if mode == "micropython":
                    extra_hardware_context = (
                        "\\n硬件约束示例（可根据实际接线修改）：\\n"
                        "- 舵机信号线接到 GPIO 5（D1）。\\n"
                        "- 使用 machine.PWM 控制舵机，占空比映射到 0~180 度。\\n"
                    )
                    full_instruction = instruction + extra_hardware_context

                    log("正在调用 Qwen Coder 2.5 生成 MicroPython 代码...")
                    code = call_qwen_coder(full_instruction)
                elif mode == "platformio":
                    log("正在调用 Qwen Coder 2.5 生成 C++ (PlatformIO) 工程主文件...")
                    code = call_qwen_cpp_for_platformio(instruction)
                else:
                    return jsonify({"ok": False, "error": f"未知模式: {mode}"}), 400

            # 预览前 50 行并限制总长，减小响应体积
            _preview_max_lines = 50
            _preview_max_chars = 12000
            preview_lines = []
            for i, line in enumerate(code.splitlines()[: _preview_max_lines], 1):
                preview_lines.append(f"{i:3}: {line}")
            preview_str = "\n".join(preview_lines)
            if len(preview_str) > _preview_max_chars:
                preview_str = preview_str[:_preview_max_chars] + "\n...(预览已截断)"

            if auto_flash:
                log(f"将使用串口设备: {port}")
                flash_micropython = mode == "micropython" or _is_github_download_and_flash(instruction)
                if flash_micropython:
                    tmp_path = write_temp_code(code)
                    try:
                        log("正在通过 mpremote 上传为 main.py ...")
                        flash_micropython_main(port, tmp_path)
                        log("上传完成。请重启或复位 ESP8266。")
                    finally:
                        try:
                            os.remove(tmp_path)
                        except OSError:
                            pass
                elif mode == "platformio":
                    build_and_upload_platformio(
                        code, port, logs, board_id=board_id, platform=platform
                    )

            return jsonify(
                {
                    "ok": True,
                    "port": port,
                    "preview": preview_str,
                    "code": code,
                    "logs": logs,
                }
            )
        except Exception as e:
            log(f"发生错误: {e}")
            return jsonify({"ok": False, "error": str(e), "logs": logs}), 500

    @app.route("/api/edit-file", methods=["POST"])
    def api_edit_file():
        data = request.get_json(force=True) or {}
        relative_path = (data.get("relative_path") or "").strip()
        instruction = (data.get("instruction") or "").strip()

        logs = []

        def log(msg: str):
            logs.append(msg)
            print(msg)

        if not relative_path:
            return jsonify({"ok": False, "error": "文件路径不能为空", "logs": logs}), 400
        if not instruction:
            return jsonify({"ok": False, "error": "修改需求不能为空", "logs": logs}), 400

        try:
            log(f"准备修改桌面文件: {relative_path}")
            new_content = edit_desktop_file(relative_path, instruction)

            # 预览前 80 行
            preview_lines = []
            for i, line in enumerate(new_content.splitlines()[:80], 1):
                preview_lines.append(f"{i:3}: {line}")

            log("文件已成功写回。")
            return jsonify(
                {
                    "ok": True,
                    "preview": "\n".join(preview_lines),
                    "logs": logs,
                }
            )
        except Exception as e:
            log(f"发生错误: {e}")
            return jsonify({"ok": False, "error": str(e), "logs": logs}), 500

    @app.route("/api/edit-file/preview", methods=["POST"])
    def api_edit_file_preview():
        """AI 预览编辑：返回新内容，不写盘。body: relative_path, instruction, selected_text?, context_files? """
        data = request.get_json(force=True) or {}
        relative_path = (data.get("relative_path") or "").strip()
        instruction = (data.get("instruction") or "").strip()
        selected_text = (data.get("selected_text") or "").strip() or None
        context_files = data.get("context_files")
        if isinstance(context_files, list):
            context_files = [
                {"path": (c.get("path") or "").strip(), "content": c.get("content")}
                for c in context_files
                if (c.get("path") or "").strip()
            ]
        else:
            context_files = None
        if not relative_path:
            return jsonify({"ok": False, "error": "文件路径不能为空"}), 400
        if not instruction:
            return jsonify({"ok": False, "error": "修改需求不能为空"}), 400
        try:
            new_content = edit_file_preview(
                relative_path,
                instruction,
                selected_text=selected_text,
                context_files=context_files,
            )
            return jsonify({"ok": True, "new_content": new_content})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500

    @app.route("/api/edit-file/apply", methods=["POST"])
    def api_edit_file_apply():
        """将预览得到的内容写回文件。body: relative_path, new_content """
        data = request.get_json(force=True) or {}
        relative_path = (data.get("relative_path") or "").strip()
        new_content = data.get("new_content")
        if not relative_path:
            return jsonify({"ok": False, "error": "文件路径不能为空"}), 400
        if new_content is None:
            return jsonify({"ok": False, "error": "new_content 不能为空"}), 400
        try:
            edit_file_apply(relative_path, str(new_content))
            return jsonify({"ok": True})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500

    @app.route("/api/project-root", methods=["GET"])
    def api_project_root():
        """返回当前项目根目录（用于前端展示）。"""
        return jsonify({"project_root": get_project_root()})

    @app.route("/api/github-flash", methods=["POST"])
    def api_github_flash():
        data = request.get_json(force=True) or {}
        url = (data.get("url") or "").strip()
        port = (data.get("port") or "").strip()
        auto_flash = bool(data.get("auto_flash", True))

        logs = []

        def log(msg: str):
            logs.append(msg)
            print(msg)

        if not url:
            return jsonify({"ok": False, "error": "GitHub 文件 URL 不能为空", "logs": logs}), 400

        devices = list_serial_devices()
        if not devices:
            return jsonify({"ok": False, "error": "未检测到任何串口设备", "logs": logs}), 400

        if not port:
            port = guess_esp8266_port(devices) or devices[0]["device"]

        try:
            log(f"正在从 GitHub 下载文件: {url}")
            code = download_github_file(url)

            # 预览前 80 行
            preview_lines = []
            for i, line in enumerate(code.splitlines()[:80], 1):
                preview_lines.append(f"{i:3}: {line}")

            if auto_flash:
                log(f"将使用串口设备: {port}")
                tmp_path = write_temp_code(code)
                try:
                    log("正在通过 mpremote 上传为 main.py ...")
                    flash_micropython_main(port, tmp_path)
                    log("上传完成。请重启或复位 ESP8266。")
                finally:
                    try:
                        os.remove(tmp_path)
                    except OSError:
                        pass

            return jsonify(
                {
                    "ok": True,
                    "port": port,
                    "preview": "\n".join(preview_lines),
                    "logs": logs,
                }
            )
        except Exception as e:
            log(f"发生错误: {e}")
            return jsonify({"ok": False, "error": str(e), "logs": logs}), 500

    @app.route("/api/assistant/chat", methods=["POST"])
    def api_assistant_chat():
        """电脑助手对话：mode + instruction；可从指令或 context 解析文件路径，读文件后润色/修改并写回。mode=auto 时根据指令自动选择模式。"""
        data = request.get_json(force=True) or {}
        mode = (data.get("mode") or "auto").strip()
        instruction = (data.get("instruction") or "").strip()
        context = dict(data.get("context") or {})
        if not instruction:
            return jsonify({"ok": False, "error": "指令不能为空"}), 400
        try:
            # 最先强制识别「做…软件/App/网页/小游戏」，避免被深度思考或 resolve 未命中导致只出计划
            create_target = None
            desktop = os.path.expanduser("~/Desktop")
            instr_norm = (instruction or "").replace("\u3000", " ").strip()  # 全角空格等规范化
            is_create_agent = instr_norm.startswith("【创造 Agent】") or instr_norm.startswith("【创造Agent】")
            if not is_create_agent and "做" in instr_norm:
                if "软件" in instr_norm or "应用" in instr_norm or "app" in instr_norm.lower():
                    mode = "create_file"
                    create_target = (desktop, "写日记_项目" if "日记" in instr_norm else "应用_项目")
                    print("[Lumi] 已识别为「做…软件」→ create_file，目标文件夹:", create_target[1], flush=True)
                elif "网页" in instr_norm or "小游戏" in instr_norm or "网页游戏" in instr_norm:
                    mode = "create_file"
                    create_target = resolve_create_target_from_instruction(instruction)
                    if create_target is None:
                        create_target = (desktop, "网页小游戏_网站")
                    print("[Lumi] 已识别为「做…网页/小游戏」→ create_file，目标文件夹:", create_target[1], flush=True)
            mentioned_files = [{"path": p, "name": n} for p, n in get_mentioned_file_paths(instruction)]
            file_path = context.get("file_path")
            if file_path and isinstance(file_path, str):
                file_path = file_path.strip()
                if file_path.startswith("~"):
                    file_path = os.path.expanduser(file_path)
                file_path = os.path.normpath(file_path)
            else:
                file_path = resolve_file_path_from_instruction(instruction)
            # 解析到文件路径但文件不存在时，直接提示用户（create_file 模式是创建新项目，不要求路径指向已存在文件，故跳过）
            if file_path and not os.path.isfile(file_path) and mode != "create_file":
                return jsonify({
                    "ok": False,
                    "error": f"未找到文件：已解析路径为 {file_path}，请确认路径是否正确（例如桌面 furina 文件夹内是否有 furina.html）。",
                }), 400
            folder_path = context.get("folder_path")
            if folder_path and isinstance(folder_path, str):
                folder_path = folder_path.strip()
                if folder_path.startswith("~"):
                    folder_path = os.path.expanduser(folder_path)
                folder_path = os.path.normpath(folder_path)
            else:
                folder_path = resolve_folder_path_from_instruction(instruction)
            if file_path and os.path.isfile(file_path):
                ok_read, content, err_read = read_file_content_for_assistant(file_path)
                if not ok_read:
                    return jsonify({"ok": False, "error": err_read}), 400
                context["file_path"] = file_path
                context["file_content"] = content
            if mode == "auto" or not mode:
                mode = infer_assistant_mode(instruction, context)
            # 若尚未因「做…软件」设过 create_target，再解析「做…网站」等
            if create_target is None:
                create_target = resolve_create_target_from_instruction(instruction)
                if create_target is not None:
                    mode = "create_file"
                elif re.search(r"(?:做|开发).*(?:软件|应用|App)", instruction, re.IGNORECASE):
                    mode = "create_file"
                    desktop = os.path.expanduser("~/Desktop")
                    create_target = (desktop, "写日记_项目" if "日记" in instruction else "应用_项目")
            # 若已解析到单文件，则不做 folder_edit，改为单文件编辑（避免「某文件夹里的某文件」被当成批量）
            if file_path and os.path.isfile(file_path) and mode == "folder_edit":
                ext = os.path.splitext(file_path)[1].lower()
                mode = "polish" if ext in (".docx", ".doc", ".txt") else "edit_code"
            # 查看文件夹内容
            if mode == "list_folder" and folder_path and os.path.isdir(folder_path):
                ok_list, entries, err_list = list_directory_for_assistant(folder_path, max_entries=200)
                if not ok_list:
                    return jsonify({"ok": False, "error": err_list}), 400
                context["folder_path"] = folder_path
                context["folder_listing"] = entries
                if data.get("stream"):
                    def _stream_list():
                        import json
                        reply = ""
                        for chunk in call_qwen_assistant_stream("list_folder", instruction, context=context):
                            reply += chunk
                            yield "data: " + json.dumps({"type": "chunk", "content": chunk}, ensure_ascii=False) + "\n\n"
                        yield "data: " + json.dumps({"type": "done", "reply": reply, "mode": "list_folder", "file_edit": None, "mentioned_files": mentioned_files}, ensure_ascii=False) + "\n\n"
                    return Response(
                        stream_with_context(_stream_list()),
                        mimetype="text/event-stream",
                        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
                    )
                reply = call_qwen_assistant("list_folder", instruction, context=context)
                return jsonify({"ok": True, "reply": reply, "mode": "list_folder", "mentioned_files": mentioned_files})
            # 文件夹内批量修改（仅当未解析到单文件时）
            if folder_path and os.path.isdir(folder_path) and mode == "folder_edit" and not (file_path and os.path.isfile(file_path)):
                pattern = "*"
                if re.search(r"\.py|py\s*文件|所有\s*\.?py", instruction, re.IGNORECASE):
                    pattern = "*.py"
                elif re.search(r"\.txt|txt\s*文件|所有\s*\.?txt", instruction, re.IGNORECASE):
                    pattern = "*.txt"
                else:
                    m = re.search(r"\.(js|ts|jsx|tsx|html|css)", instruction, re.IGNORECASE)
                    if m:
                        pattern = "*." + m.group(1).lower()
                ok_f, folder_files, err_f = read_folder_files_for_assistant(folder_path, pattern=pattern, max_files=20)
                if not ok_f:
                    return jsonify({"ok": False, "error": err_f}), 400
                if not folder_files:
                    return jsonify({"ok": True, "reply": "该目录下没有匹配的文件（pattern: " + pattern + "）。", "mode": mode})
                context["folder_path"] = folder_path
                context["folder_files"] = folder_files
                if data.get("stream"):
                    def _stream_folder_edit():
                        import json
                        yield "data: " + json.dumps({"type": "chunk", "content": "正在修改文件…"}, ensure_ascii=False) + "\n\n"
                        reply = ""
                        for chunk in call_qwen_assistant_stream("folder_edit", instruction, context=context):
                            reply += chunk
                        allowed = {rel for rel, _ in folder_files}
                        parsed = _parse_multi_file_output(reply)
                        edits = {k: v for k, v in parsed.items() if k in allowed}
                        ok_write, write_errors = write_assistant_results_to_folder(folder_path, edits)
                        if ok_write and edits:
                            final_reply = "已经帮你改好了！共 " + str(len(edits)) + " 个文件。"
                        elif write_errors:
                            final_reply = "覆写失败"
                        else:
                            final_reply = reply
                        yield "data: " + json.dumps({"type": "done", "reply": final_reply, "mode": "folder_edit", "file_edit": None, "mentioned_files": mentioned_files}, ensure_ascii=False) + "\n\n"
                    return Response(
                        stream_with_context(_stream_folder_edit()),
                        mimetype="text/event-stream",
                        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
                    )
                reply = call_qwen_assistant("folder_edit", instruction, context=context)
                allowed = {rel for rel, _ in folder_files}
                parsed = _parse_multi_file_output(reply)
                edits = {k: v for k, v in parsed.items() if k in allowed}
                ok_write, write_errors = write_assistant_results_to_folder(folder_path, edits)
                if ok_write and edits:
                    reply = "已经帮你改好了！共 " + str(len(edits)) + " 个文件。"
                elif write_errors:
                    reply = "覆写失败"
                return jsonify({"ok": True, "reply": reply, "mode": "folder_edit", "mentioned_files": mentioned_files})
            # 自主创建文件/网站/软件（如「帮我做一个 xxx 的网站」或「做写日记的 ios 软件」）
            if mode == "create_file":
                if create_target is None:
                    create_target = resolve_create_target_from_instruction(instruction)
                if not create_target:
                    mode = "deep_think"
                else:
                    base_dir, folder_name = create_target
                    target_dir = os.path.normpath(os.path.join(base_dir, folder_name))
                    if data.get("stream"):
                        def _stream_create_file():
                            import json
                            mentioned_files = data.get("context", {}).get("mentioned_files") or []
                            # 只收不推：模型输出用于解析写文件，不发给用户；只发一句「正在生成…」和最后的「已经帮你创建好了！」
                            yield "data: " + json.dumps({"type": "chunk", "content": "正在生成项目…"}, ensure_ascii=False) + "\n\n"
                            reply = ""
                            for chunk in call_qwen_assistant_stream("create_file", instruction, context=context):
                                reply += chunk
                            parsed = _parse_multi_file_output(reply)
                            if not parsed:
                                content = extract_content_to_write_from_reply(reply) or extract_html_from_reply(reply)
                                if content:
                                    parsed = {"index.html": content}
                            if parsed:
                                progress_list = []
                                ok_create, create_errors = ensure_directory_and_write_files(target_dir, parsed, progress_callback=progress_list.append)
                                status = "已经帮你创建好了！" if ok_create else "创建失败"
                                final_reply = ("\n".join(progress_list) + "\n" + status) if progress_list else status
                                created_path = target_dir if ok_create else None
                                auto_open_path = os.path.join(target_dir, "index.html") if (ok_create and "index.html" in parsed) else (created_path or None)
                            else:
                                final_reply = "创建失败"
                                created_path = None
                                auto_open_path = None
                            run_commands = extract_run_commands_from_reply(reply)
                            run_cwd = created_path if (created_path and os.path.isdir(created_path)) else None
                            if run_commands:
                                term_outputs = []
                                for run_cmd in run_commands:
                                    ok_term, term_out = run_assistant_terminal(run_cmd, cwd=run_cwd, timeout_sec=120)
                                    term_outputs.append((run_cmd, ok_term, term_out))
                                lines = [("已执行：%s\n[输出]\n%s" % (c, o) if ok else "执行失败：%s\n%s" % (c, o)) for c, ok, o in term_outputs]
                                final_reply = final_reply + "\n\n" + "\n\n".join(lines) if final_reply else "\n\n".join(lines)
                            if created_path and not any((f.get("path") or "") == created_path for f in mentioned_files):
                                mentioned_files = list(mentioned_files) + [{"path": created_path, "name": os.path.basename(created_path)}]
                            yield "data: " + json.dumps({"type": "done", "reply": final_reply, "mode": "create_file", "file_edit": None, "mentioned_files": mentioned_files, "created_path": created_path, "auto_open_path": auto_open_path}, ensure_ascii=False) + "\n\n"
                        return Response(
                            stream_with_context(_stream_create_file()),
                            mimetype="text/event-stream",
                            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
                        )
                    reply = call_qwen_assistant("create_file", instruction, context=context)
                    parsed = _parse_multi_file_output(reply)
                    if not parsed:
                        content = extract_content_to_write_from_reply(reply) or extract_html_from_reply(reply)
                        if content:
                            parsed = {"index.html": content}
                    if parsed:
                        progress_list = []
                        ok_create, create_errors = ensure_directory_and_write_files(target_dir, parsed, progress_callback=progress_list.append)
                        status = "已经帮你创建好了！" if ok_create else "创建失败"
                        reply = ("\n".join(progress_list) + "\n" + status) if progress_list else status
                    else:
                        reply = "创建失败"
                    created_path = target_dir if ("已经帮你创建好了！" in (reply or "")) else None
                    auto_open_path = os.path.join(target_dir, "index.html") if (created_path and parsed and "index.html" in parsed) else created_path
                    run_commands = extract_run_commands_from_reply(reply)
                    run_cwd = created_path if (created_path and os.path.isdir(created_path)) else None
                    if run_commands:
                        term_outputs = []
                        for run_cmd in run_commands:
                            ok_term, term_out = run_assistant_terminal(run_cmd, cwd=run_cwd, timeout_sec=120)
                            term_outputs.append((run_cmd, ok_term, term_out))
                        lines = [("已执行：%s\n[输出]\n%s" % (c, o) if ok else "执行失败：%s\n%s" % (c, o)) for c, ok, o in term_outputs]
                        reply = reply + "\n\n" + "\n\n".join(lines) if reply else "\n\n".join(lines)
                    if created_path and not any((f.get("path") or "") == created_path for f in mentioned_files):
                        mentioned_files = list(mentioned_files) + [{"path": created_path, "name": os.path.basename(created_path)}]
                    return jsonify({
                        "ok": True,
                        "reply": reply,
                        "mode": "create_file",
                        "mentioned_files": mentioned_files,
                        "created_path": created_path,
                        "auto_open_path": auto_open_path,
                    })
            if data.get("stream"):
                def _stream_default():
                    import json
                    file_edit_info = None
                    created_path = None
                    auto_open_path = None
                    mentioned_files = data.get("context", {}).get("mentioned_files") or []
                    try:
                        # 创建类请求：只做创建，只回复「已经帮你创建好了！」或「创建失败」，不向用户展示任何其他文本
                        create_intent = resolve_create_target_from_instruction(instruction) is not None or (
                            ("做" in instruction or "开发" in instruction)
                            and any(x in instruction for x in ["网站", "软件", "应用", "网页", "小游戏"])
                        ) or "app" in instruction.lower()
                        reply = ""
                        if create_intent:
                            yield "data: " + json.dumps({"type": "chunk", "content": "正在生成项目…"}, ensure_ascii=False) + "\n\n"
                            last_keepalive = time.time()
                            for chunk in call_qwen_assistant_stream(mode, instruction, context=context):
                                reply += chunk
                                if time.time() - last_keepalive > 2.5:
                                    yield ": keepalive\n\n"
                                    last_keepalive = time.time()
                        else:
                            for chunk in call_qwen_assistant_stream(mode, instruction, context=context):
                                reply += chunk
                                yield "data: " + json.dumps({"type": "chunk", "content": chunk}, ensure_ascii=False) + "\n\n"
                    except Exception as e:
                        reply = "请求出错（模型或网络异常）：%s" % (getattr(e, "message", None) or str(e))
                    try:
                        # 模型自主决定创建：回复中含 ---FILE:--- 时，解析并写入桌面文件夹
                        if "---FILE:" in (reply or "").upper():
                            post_target = resolve_create_target_from_instruction(instruction)
                            if not post_target:
                                post_target = (os.path.expanduser("~/Desktop"), "新建项目")
                            base_dir, folder_name = post_target
                            target_dir = os.path.normpath(os.path.join(base_dir, folder_name))
                            parsed = _parse_multi_file_output(reply)
                            if not parsed:
                                content = extract_content_to_write_from_reply(reply) or extract_html_from_reply(reply)
                                if content:
                                    parsed = {"index.html": content}
                            if parsed:
                                progress_list = []
                                ok_create, _ = ensure_directory_and_write_files(target_dir, parsed, progress_callback=progress_list.append)
                                if ok_create:
                                    status = "已经帮你创建好了！"
                                    reply = ("\n".join(progress_list) + "\n" + status) if progress_list else status
                                    created_path = target_dir
                                    auto_open_path = os.path.join(target_dir, "index.html") if "index.html" in parsed else target_dir
                        # 禁止在对话中展示代码：若回复含代码块/HTML 但未走 ---FILE:---，仍提取保存并只回复简短确认
                        if created_path is None and reply and ("```" in reply or "<!DOCTYPE" in reply.upper() or "<html" in reply.lower()):
                            content = extract_html_from_reply(reply) or extract_content_to_write_from_reply(reply)
                            if content and len(content) > 100:
                                post_target = resolve_create_target_from_instruction(instruction)
                                if not post_target:
                                    post_target = (os.path.expanduser("~/Desktop"), "新建项目")
                                base_dir, folder_name = post_target
                                target_dir = os.path.normpath(os.path.join(base_dir, folder_name))
                                progress_list = []
                                ok_create, _ = ensure_directory_and_write_files(target_dir, {"index.html": content}, progress_callback=progress_list.append)
                                if ok_create:
                                    status = "已经帮你创建好了！"
                                    reply = ("\n".join(progress_list) + "\n" + status) if progress_list else status
                                    created_path = target_dir
                                    auto_open_path = os.path.join(target_dir, "index.html")
                        if created_path is None and file_path and os.path.isfile(file_path) and mode in ("polish", "edit_code") and context.get("file_content") is not None:
                            content_to_write = extract_content_to_write_from_reply(reply)
                            ok_write, err_write = write_assistant_result_to_file(file_path, reply, original_length=len(context.get("file_content") or ""))
                            file_edit_info = {
                                "path": file_path,
                                "before": context.get("file_content") or "",
                                "after": content_to_write,
                                "write_ok": ok_write,
                            }
                            reply = "已经帮你改好了！" if ok_write else ("覆写失败" if err_write else reply)
                        run_commands = extract_run_commands_from_reply(reply)
                        run_cwd = created_path if (create_intent and created_path and os.path.isdir(created_path)) else None
                        if run_commands:
                            term_outputs = []
                            for i, run_cmd in enumerate(run_commands):
                                yield "data: " + json.dumps({"type": "status", "message": "正在执行命令 (%d/%d)…" % (i + 1, len(run_commands))}, ensure_ascii=False) + "\n\n"
                                term_result = [None]
                                def _run_term(cmd=run_cmd):
                                    try:
                                        term_result[0] = run_assistant_terminal(cmd, cwd=run_cwd, timeout_sec=120)
                                    except Exception as e:
                                        term_result[0] = (False, "执行异常：%s" % (getattr(e, "message", None) or str(e)))
                                t = threading.Thread(target=_run_term)
                                t.start()
                                while t.is_alive():
                                    yield ": keepalive\n\n"
                                    time.sleep(2.5)
                                res = term_result[0]
                                if res is None:
                                    res = (False, "执行超时或未返回结果")
                                ok_term, term_out = res
                                term_outputs.append((run_cmd, ok_term, term_out))
                            lines = []
                            for cmd, ok, out in term_outputs:
                                lines.append(("已执行：%s\n[输出]\n%s" % (cmd, out)) if ok else ("执行失败：%s\n%s" % (cmd, out)))
                            reply = reply + "\n\n" + "\n\n".join(lines) if reply else "\n\n".join(lines)
                        # 创建类请求只允许以这两句之一结尾，其余一律视为「创建失败」
                        if create_intent and not (reply or "").strip().endswith("已经帮你创建好了！") and not (reply or "").strip().endswith("创建失败"):
                            reply = "创建失败"
                        if created_path and not any((f.get("path") or "") == created_path for f in mentioned_files):
                            mentioned_files = list(mentioned_files) + [{"path": created_path, "name": os.path.basename(created_path)}]
                        if file_edit_info:
                            p = file_edit_info.get("path") or ""
                            if p and not any((f.get("path") or "") == p for f in mentioned_files):
                                mentioned_files = list(mentioned_files) + [{"path": p, "name": os.path.basename(p)}]
                    except Exception as e:
                        reply = (reply or "") + "\n\n[处理过程出错] %s" % (getattr(e, "message", None) or str(e))
                    yield "data: " + json.dumps({"type": "done", "reply": reply, "mode": mode, "file_edit": file_edit_info, "mentioned_files": mentioned_files, "created_path": created_path, "auto_open_path": auto_open_path}, ensure_ascii=False) + "\n\n"
                return Response(
                    stream_with_context(_stream_default()),
                    mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
                )
            reply = call_qwen_assistant(mode, instruction, context=context)
            file_edit_info = None
            created_path = None
            auto_open_path = None
            create_intent = resolve_create_target_from_instruction(instruction) is not None or (
                ("做" in instruction or "开发" in instruction)
                and any(x in instruction for x in ["网站", "软件", "应用", "网页", "小游戏"])
            ) or "app" in instruction.lower()
            if "---FILE:" in (reply or "").upper():
                post_target = resolve_create_target_from_instruction(instruction)
                if not post_target:
                    post_target = (os.path.expanduser("~/Desktop"), "新建项目")
                base_dir, folder_name = post_target
                target_dir = os.path.normpath(os.path.join(base_dir, folder_name))
                parsed = _parse_multi_file_output(reply)
                if not parsed:
                    content = extract_content_to_write_from_reply(reply) or extract_html_from_reply(reply)
                    if content:
                        parsed = {"index.html": content}
                if parsed:
                    progress_list = []
                    ok_create, _ = ensure_directory_and_write_files(target_dir, parsed, progress_callback=progress_list.append)
                    if ok_create:
                        status = "已经帮你创建好了！"
                        reply = ("\n".join(progress_list) + "\n" + status) if progress_list else status
                        created_path = target_dir
                        auto_open_path = os.path.join(target_dir, "index.html") if "index.html" in parsed else target_dir
            if created_path is None and reply and ("```" in reply or "<!DOCTYPE" in reply.upper() or "<html" in reply.lower()):
                content = extract_html_from_reply(reply) or extract_content_to_write_from_reply(reply)
                if content and len(content) > 100:
                    post_target = resolve_create_target_from_instruction(instruction)
                    if not post_target:
                        post_target = (os.path.expanduser("~/Desktop"), "新建项目")
                    base_dir, folder_name = post_target
                    target_dir = os.path.normpath(os.path.join(base_dir, folder_name))
                    progress_list = []
                    ok_create, _ = ensure_directory_and_write_files(target_dir, {"index.html": content}, progress_callback=progress_list.append)
                    if ok_create:
                        status = "已经帮你创建好了！"
                        reply = ("\n".join(progress_list) + "\n" + status) if progress_list else status
                        created_path = target_dir
                        auto_open_path = os.path.join(target_dir, "index.html")
            if created_path is None and file_path and os.path.isfile(file_path) and mode in ("polish", "edit_code") and context.get("file_content") is not None:
                original_len = len(context.get("file_content") or "")
                content_to_write = extract_content_to_write_from_reply(reply)
                ok_write, err_write = write_assistant_result_to_file(file_path, reply, original_length=original_len)
                file_edit_info = {
                    "path": file_path,
                    "before": context.get("file_content") or "",
                    "after": content_to_write,
                    "write_ok": ok_write,
                }
                if ok_write:
                    reply = "已经帮你改好了！"
                elif err_write:
                    reply = "覆写失败"
            run_commands = extract_run_commands_from_reply(reply)
            run_cwd = created_path if (create_intent and created_path and os.path.isdir(created_path)) else None
            if run_commands:
                term_outputs = []
                for run_cmd in run_commands:
                    ok_term, term_out = run_assistant_terminal(run_cmd, cwd=run_cwd, timeout_sec=120)
                    term_outputs.append((run_cmd, ok_term, term_out))
                lines = [("已执行：%s\n[输出]\n%s" % (c, o) if ok else "执行失败：%s\n%s" % (c, o)) for c, ok, o in term_outputs]
                reply = reply + "\n\n" + "\n\n".join(lines) if reply else "\n\n".join(lines)
            # 创建类请求只允许以这两句之一结尾，其余一律视为「创建失败」
            if create_intent and not (reply or "").strip().endswith("已经帮你创建好了！") and not (reply or "").strip().endswith("创建失败"):
                reply = "创建失败"
            if created_path and not any((f.get("path") or "") == created_path for f in mentioned_files):
                mentioned_files = list(mentioned_files) + [{"path": created_path, "name": os.path.basename(created_path)}]
            if file_edit_info:
                p = file_edit_info.get("path") or ""
                if p and not any((f.get("path") or "") == p for f in mentioned_files):
                    mentioned_files = list(mentioned_files) + [{"path": p, "name": os.path.basename(p)}]
            return jsonify({"ok": True, "reply": reply, "mode": mode, "file_edit": file_edit_info, "mentioned_files": mentioned_files, "created_path": created_path, "auto_open_path": auto_open_path})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500

    @app.route("/api/assistant/open-file", methods=["POST"])
    def api_assistant_open_file():
        """用系统默认应用打开文件。body: path（绝对路径，仅允许桌面或项目根下）。"""
        data = request.get_json(force=True) or {}
        path = (data.get("path") or "").strip()
        if not path:
            return jsonify({"ok": False, "error": "缺少 path"}), 400
        ok, err = open_file_in_system(path)
        return jsonify({"ok": ok, "error": err or None})

    @app.route("/api/assistant/open-folder", methods=["POST"])
    def api_assistant_open_folder():
        """在系统文件管理器中打开目录；若 path 为文件则打开其所在目录。body: path。"""
        data = request.get_json(force=True) or {}
        path = (data.get("path") or "").strip()
        if not path:
            return jsonify({"ok": False, "error": "缺少 path"}), 400
        ok, err = open_folder_in_system(path)
        return jsonify({"ok": ok, "error": err or None})

    @app.route("/api/assistant/open-in-xcode", methods=["POST"])
    def api_assistant_open_in_xcode():
        """用 Xcode 打开工程。body: path（项目目录或 .xcodeproj 路径）。"""
        data = request.get_json(force=True) or {}
        path = (data.get("path") or "").strip()
        if not path:
            return jsonify({"ok": False, "error": "缺少 path"}), 400
        ok, err = open_xcode_project(path)
        return jsonify({"ok": ok, "error": err or None})

    @app.route("/api/assistant/read-file", methods=["POST"])
    def api_assistant_read_file():
        """读取文件内容供前端预览。仅允许桌面或项目根下的文件。body: path。"""
        data = request.get_json(force=True) or {}
        path = (data.get("path") or "").strip()
        if not path:
            return jsonify({"ok": False, "error": "缺少 path"}), 400
        ok, content, err = read_file_for_preview(path)
        if not ok:
            return jsonify({"ok": False, "error": err or "读取失败"}), 400
        return jsonify({"ok": True, "path": path, "content": content})

    @app.route("/api/assistant/register-preview-root", methods=["POST"])
    def api_assistant_register_preview_root():
        """注册一个项目目录供网页内预览，返回 preview_id。body: path（目录或 index.html 等文件的绝对路径；若为文件则用其所在目录）。"""
        global _preview_roots
        data = request.get_json(force=True) or {}
        path = (data.get("path") or "").strip()
        if not path:
            return jsonify({"ok": False, "error": "缺少 path"}), 400
        path = os.path.normpath(os.path.expanduser(path))
        root = path
        if os.path.isfile(path):
            root = os.path.dirname(path)
        elif not os.path.isdir(path):
            return jsonify({"ok": False, "error": "路径不存在"}), 400
        if not is_path_under_allowed_bases(root):
            return jsonify({"ok": False, "error": "仅允许预览桌面或项目根下的目录"}), 400
        root_real = os.path.realpath(root)
        preview_id = str(uuid.uuid4())
        _preview_roots[preview_id] = root_real
        return jsonify({"ok": True, "preview_id": preview_id})

    @app.route("/api/assistant/serve-app/<preview_id>/")
    @app.route("/api/assistant/serve-app/<preview_id>/<path:subpath>")
    def api_assistant_serve_app(preview_id: str, subpath: str = ""):
        """为网页内预览提供静态文件。preview_id 由 register-preview-root 返回，便于 iframe 内相对请求（如 script.js）携带同一 id。"""
        global _preview_roots
        if not preview_id or preview_id not in _preview_roots:
            return Response("预览已失效或未注册", status=404, mimetype="text/plain")
        root = _preview_roots[preview_id]
        subpath = (subpath or "").strip().lstrip("/")
        if ".." in subpath or subpath.startswith(".."):
            return Response("非法路径", status=403, mimetype="text/plain")
        if not subpath or subpath.endswith("/"):
            subpath = "index.html"
        file_path = os.path.join(root, subpath)
        try:
            file_path = os.path.normpath(file_path)
            if not file_path.startswith(root + os.sep) and file_path != root:
                return Response("非法路径", status=403, mimetype="text/plain")
        except (TypeError, ValueError):
            return Response("非法路径", status=403, mimetype="text/plain")
        if not os.path.isfile(file_path) and subpath == "index.html":
            # 项目根没有 index.html 时，尝试用目录下任意 .html 作为入口
            try:
                for name in sorted(os.listdir(root)):
                    if name.lower().endswith(".html"):
                        fallback = os.path.join(root, name)
                        if os.path.isfile(fallback):
                            file_path = fallback
                            break
            except OSError:
                pass
        if not os.path.isfile(file_path):
            # 若是 Xcode 项目，返回说明页而非“文件不存在”
            try:
                for name in os.listdir(root):
                    if name.endswith(".xcodeproj") and os.path.isdir(os.path.join(root, name)):
                        html = (
                            "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Xcode 项目</title></head><body style=\"font-family:system-ui;padding:2rem;max-width:36em;margin:0 auto;\">"
                            "<h2>这是 Xcode 项目</h2>"
                            "<p>iOS/macOS 应用无法在浏览器中预览。</p>"
                            "<p>请关闭本窗口，在右侧「对话中提到的文件」中点击<strong>「打开」</strong>在 Finder 中打开该文件夹，然后双击 <code>.xcodeproj</code> 用 Xcode 打开并运行。</p>"
                            "<p>或点击<strong>「用 Xcode 打开」</strong>直接启动 Xcode 并打开该工程。</p>"
                            "</body></html>"
                        )
                        return Response(html, status=200, mimetype="text/html; charset=utf-8")
            except OSError:
                pass
            return Response("文件不存在（该目录下无 index.html 或其它 .html 文件）", status=404, mimetype="text/plain; charset=utf-8")
        directory = os.path.dirname(file_path)
        filename = os.path.basename(file_path)
        return send_from_directory(directory, filename)

    @app.route("/api/assistant/terminal", methods=["POST"])
    def api_assistant_terminal():
        """执行助手生成的终端命令（白名单内）。body: command, cwd?, timeout?"""
        data = request.get_json(force=True) or {}
        command = (data.get("command") or "").strip()
        cwd = (data.get("cwd") or "").strip() or None
        timeout = int(data.get("timeout") or 60)
        timeout = max(10, min(300, timeout))
        if not command:
            return jsonify({"ok": False, "error": "命令不能为空"}), 400
        ok, output = run_assistant_terminal(command, cwd=cwd, timeout_sec=timeout)
        return jsonify({"ok": ok, "output": output})

    @app.route("/api/drone-basic", methods=["POST"])
    def api_drone_basic():
        """
        一键生成并烧录基础无人机飞控框架代码（示例用途）。
        说明：这里生成的是一个教学/演示用的飞控框架，占位实现，不直接用于真实飞行。
        """
        data = request.get_json(force=True) or {}
        port = (data.get("port") or "").strip()
        auto_flash = bool(data.get("auto_flash", True))

        logs = []

        def log(msg: str):
            logs.append(msg)
            print(msg)

        devices = list_serial_devices()
        if not devices:
            return jsonify({"ok": False, "error": "未检测到任何串口设备", "logs": logs}), 400

        if not port:
            port = guess_esp8266_port(devices) or devices[0]["device"]

        try:
            # 固定的飞控框架需求说明
            instruction = (
                "为运行 MicroPython 的 ESP8266 生成一个【基础四轴无人机飞控框架示例】main.py：\\n"
                "1. 提供 4 路电机 PWM 输出，占空比范围 0~100%，假设接在 GPIO12、GPIO13、GPIO14、GPIO15。\\n"
                "2. 使用类 `FlightController` 封装电机控制、油门/俯仰/横滚/偏航四个通道的混控逻辑（可为占位实现，带详细注释）。\\n"
                "3. 预留 `update_from_rc()`、`update_from_imu()` 等方法，内部先用模拟数据/简单逻辑占位，并在注释中说明应接入遥控/IMU。\\n"
                "4. 在 `main()` 中循环调用更新逻辑，并通过 `print` 输出当前电机占空比做调试。\\n"
                "5. 所有代码必须可以直接作为 main.py 运行。不要输出任何解释文字或 Markdown。\\n"
            )

            log("正在为基础无人机飞控生成 MicroPython 框架代码...")
            code = call_qwen_coder(instruction)

            # 预览前 80 行
            preview_lines = []
            for i, line in enumerate(code.splitlines()[:80], 1):
                preview_lines.append(f"{i:3}: {line}")

            if auto_flash:
                log(f"将使用串口设备: {port}")
                tmp_path = write_temp_code(code)
                try:
                    log("正在通过 mpremote 上传为 main.py ...")
                    flash_micropython_main(port, tmp_path)
                    log("上传完成。请重启或复位 ESP8266。")
                finally:
                    try:
                        os.remove(tmp_path)
                    except OSError:
                        pass

            return jsonify(
                {
                    "ok": True,
                    "port": port,
                    "preview": "\n".join(preview_lines),
                    "logs": logs,
                }
            )
        except Exception as e:
            log(f"发生错误: {e}")
            return jsonify({"ok": False, "error": str(e), "logs": logs}), 500

    # 启动每日 0 点缓存清理任务
    start_daily_cache_cleanup()

    return app


if __name__ == "__main__":
    app = create_app()
    host = os.environ.get("FLASK_HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "5000"))
    debug = os.environ.get("FLASK_DEBUG", "").strip().lower() in ("1", "true", "yes")
    app.run(host=host, port=port, debug=debug)

