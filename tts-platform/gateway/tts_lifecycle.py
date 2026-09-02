"""Allowlisted install/start/warm/unload/stop operations for TTS models."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
import subprocess
import time
from pathlib import Path
from typing import Any

import httpx

from tts_catalog import ENGINE_CATALOG, LOCAL_WORKERS
from tts_config import cfg, default_runtime_root, settings


class LifecycleError(Exception):
    def __init__(self, status_code: int, detail: str, code: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail
        self.code = code


class ModelLifecycleManager:
    ACTIONS = {"install", "start", "wake", "unload", "stop"}

    def __init__(self) -> None:
        self.runtime_root = Path(cfg("TTS_RUNTIME_ROOT", str(default_runtime_root()))).expanduser().resolve()
        self.project_root = Path(__file__).resolve().parent.parent
        self.workers_root = self.project_root / "workers"
        self.scripts_root = self.project_root / "scripts"
        self.state_root = settings.data_root / ".runtime" / "models"
        self.state_root.mkdir(parents=True, exist_ok=True)
        self._operations: dict[str, dict[str, Any]] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._locks = {engine_id: asyncio.Lock() for engine_id in ENGINE_CATALOG}

    def _paths(self, engine_id: str) -> dict[str, Path]:
        runtime = self.runtime_root
        return {
            "chatterbox_python": runtime / "envs" / "chatterbox" / "Scripts" / "python.exe",
            "qwen_python": runtime / "envs" / "qwen" / "Scripts" / "python.exe",
            "fish_python": runtime / "envs" / "fish" / "Scripts" / "python.exe",
            "voxcpm_python": runtime / "envs" / "voxcpm" / "Scripts" / "python.exe",
            "qwen_base": runtime / "models" / "Qwen3-TTS-1.7B-Base",
            "qwen_design": runtime / "models" / "Qwen3-TTS-12Hz-1.7B-VoiceDesign",
            "voxcpm": runtime / "models" / "VoxCPM2",
            "fish_model": runtime / "models" / "s2-pro",
            "fish_repo": runtime / "repos" / "fish-speech",
            "step_repo": runtime / "repos" / "Step-Audio-EditX",
            "step_model": runtime / "hf" / "hub" / "models--stepfun-ai--Step-Audio-EditX",
        }

    def installed(self, engine_id: str) -> bool:
        spec = ENGINE_CATALOG[engine_id]
        if spec["type"] == "api":
            key_name = "MIMO_API_KEY" if engine_id == "mimo_api" else "DASHSCOPE_API_KEY"
            return bool(cfg(key_name))
        paths = self._paths(engine_id)
        checks = {
            "chatterbox": paths["chatterbox_python"].is_file,
            "qwen_local": lambda: paths["qwen_python"].is_file() and paths["qwen_base"].exists(),
            "fish": lambda: paths["fish_python"].is_file() and paths["fish_model"].exists() and paths["fish_repo"].exists(),
            "step_audio": lambda: paths["step_repo"].exists() and paths["step_model"].exists(),
            "voxcpm2": lambda: paths["voxcpm_python"].is_file() and (paths["voxcpm"] / "config.json").is_file() and (paths["voxcpm"] / ".tts-install-complete").is_file(),
            "qwen_voice_design": lambda: paths["qwen_python"].is_file() and (paths["qwen_design"] / "config.json").is_file() and (paths["qwen_design"] / ".tts-install-complete").is_file(),
        }
        check = checks.get(engine_id)
        return bool(check and check())

    def catalog(self, engine_states: list[dict[str, Any]]) -> list[dict[str, Any]]:
        states = {item["id"]: item for item in engine_states}
        result: list[dict[str, Any]] = []
        for engine_id, spec in ENGINE_CATALOG.items():
            state = states.get(engine_id, {})
            installed = self.installed(engine_id)
            available = bool(state.get("available"))
            loaded = bool(state.get("model_loaded"))
            busy = bool(state.get("busy"))
            operation = self._operations.get(engine_id)
            operation_active = operation and operation.get("status") in {"queued", "running"}
            item = {
                "id": engine_id,
                "name": spec["name"],
                "type": spec["type"],
                "description": spec["description"],
                "license": spec["license"],
                "source_url": spec["source_url"],
                "model_size_bytes": spec.get("model_size_bytes"),
                "featured": bool(spec.get("featured")),
                "installed": installed,
                "configured": installed if spec["type"] == "api" else None,
                "available": available,
                "status": state.get("status", "unconfigured" if spec["type"] == "api" else "offline"),
                "detail": state.get("detail", "尚未安装" if not installed and spec.get("installable") else "服务未启动"),
                "model_loaded": state.get("model_loaded"),
                "busy": busy,
                "latency_ms": state.get("latency_ms"),
                "languages": list(spec["languages"]),
                "language_mode": spec["language_mode"],
                "language_summary": spec["language_summary"],
                "capabilities": dict(spec["capabilities"]),
                "operation": dict(operation) if operation else None,
                "actions": {
                    "install": bool(spec.get("installable") and not installed and not operation_active),
                    "start": bool(spec.get("startable") and installed and not available and not operation_active),
                    "wake": bool(spec.get("warmable") and installed and (not available or not loaded) and not operation_active),
                    "unload": bool(spec.get("unloadable") and available and loaded and not busy and not operation_active),
                    "stop": bool(spec.get("stoppable") and available and not busy and not operation_active),
                },
            }
            result.append(item)
        return result

    def resources(self) -> dict[str, Any]:
        disk = shutil.disk_usage(self._disk_probe_path())
        result: dict[str, Any] = {
            "disk_total_bytes": disk.total,
            "disk_used_bytes": disk.used,
            "disk_free_bytes": disk.free,
            "gpu": None,
        }
        try:
            process = subprocess.run(
                ["nvidia-smi", "--query-gpu=name,memory.total,memory.used,memory.free", "--format=csv,noheader,nounits"],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            row = (process.stdout or "").splitlines()[0].split(",") if process.returncode == 0 and process.stdout.strip() else []
            if len(row) >= 4:
                result["gpu"] = {
                    "name": row[0].strip(),
                    "total_mib": int(row[1].strip()),
                    "used_mib": int(row[2].strip()),
                    "free_mib": int(row[3].strip()),
                }
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
        return result

    def begin(self, engine_id: str, action: str) -> dict[str, Any]:
        if engine_id not in ENGINE_CATALOG:
            raise LifecycleError(404, "模型不存在", "model_not_found")
        if action not in self.ACTIONS:
            raise LifecycleError(400, "不支持的模型操作", "invalid_model_action")
        spec = ENGINE_CATALOG[engine_id]
        capability = {
            "install": "installable", "start": "startable", "wake": "warmable",
            "unload": "unloadable", "stop": "stoppable",
        }[action]
        if not spec.get(capability):
            raise LifecycleError(409, f"{spec['name']} 不支持此操作", "model_action_unsupported")
        current = self._operations.get(engine_id)
        if current and current.get("status") in {"queued", "running"}:
            raise LifecycleError(409, f"{spec['name']} 正在执行 {current['action']}", "model_action_in_progress")
        operation = {
            "action": action,
            "status": "queued",
            "message": "操作已进入队列",
            "started_at": time.time(),
            "finished_at": None,
        }
        self._operations[engine_id] = operation
        task = asyncio.create_task(self._run(engine_id, action), name=f"tts-model-{engine_id}-{action}")
        self._tasks[engine_id] = task
        task.add_done_callback(
            lambda finished: self._tasks.pop(engine_id, None)
            if self._tasks.get(engine_id) is finished else None
        )
        return dict(operation)

    async def _run(self, engine_id: str, action: str) -> None:
        operation = self._operations[engine_id]
        async with self._locks[engine_id]:
            operation.update(status="running", message="正在执行")
            try:
                message = await getattr(self, f"_{action}")(engine_id)
            except LifecycleError as exc:
                operation.update(status="failed", message=exc.detail, code=exc.code)
            except Exception as exc:  # operation errors are surfaced through status polling
                operation.update(status="failed", message=str(exc).replace("\r", " ").replace("\n", " ")[:360], code="model_action_failed")
            else:
                operation.update(status="succeeded", message=message, code="")
            finally:
                operation["finished_at"] = time.time()

    async def _install(self, engine_id: str) -> str:
        if self.installed(engine_id):
            return "模型已经安装"
        script = self.scripts_root / "install_model.ps1"
        if not script.is_file():
            raise LifecycleError(500, "安装脚本不存在", "installer_missing")
        size = int(ENGINE_CATALOG[engine_id].get("model_size_bytes") or 0)
        free = shutil.disk_usage(self._disk_probe_path()).free
        if size and free < size + 2 * 1024 ** 3:
            raise LifecycleError(507, "运行时磁盘空间不足，至少需要模型大小外加 2GB 安装余量", "insufficient_disk_space")
        await self._run_process(
            ["pwsh", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script), "-ModelId", engine_id],
            engine_id,
            "install",
        )
        if not self.installed(engine_id):
            raise LifecycleError(500, "安装命令已结束，但模型完整性检查未通过；请查看安装日志", "model_install_incomplete")
        return "模型安装完成，可直接启动或唤醒"

    async def _start(self, engine_id: str) -> str:
        if not self.installed(engine_id):
            raise LifecycleError(409, "请先安装模型", "model_not_installed")
        health = await self._health(engine_id, timeout=1.5)
        if health is not None:
            return "服务已经在线"
        if engine_id == "step_audio":
            await self._run_process(
                ["pwsh", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(self.scripts_root / "start_step_docker.ps1")],
                engine_id,
                "start",
            )
        else:
            command, cwd, env = self._launch_command(engine_id)
            log_out, log_err = self._log_paths(engine_id, "service")
            flags = 0
            if os.name == "nt":
                flags = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
            with log_out.open("ab") as stdout, log_err.open("ab") as stderr:
                process = subprocess.Popen(
                    command,
                    cwd=str(cwd),
                    env=env,
                    stdin=subprocess.DEVNULL,
                    stdout=stdout,
                    stderr=stderr,
                    creationflags=flags,
                )
            self._pid_path(engine_id).write_text(str(process.pid), encoding="ascii")
        await self._wait_for_health(engine_id, 180 if engine_id in {"fish", "step_audio"} else 60)
        return "模型服务已启动，权重仍按需加载"

    async def _wake(self, engine_id: str) -> str:
        await self._start(engine_id)
        spec = ENGINE_CATALOG[engine_id]
        if not spec.get("warmable"):
            return "服务已启动"
        if engine_id == "fish":
            return "Fish 服务已就绪（该服务在启动阶段加载权重）"
        url = LOCAL_WORKERS[engine_id]["url"] + "/admin/load"
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(900, connect=5)) as client:
                response = await client.post(url)
        except httpx.HTTPError as exc:
            raise LifecycleError(503, "服务已启动，但模型加载请求失败", "model_wake_failed") from exc
        # Containers created by v0.2 did not yet expose /admin/load.  A user-
        # initiated wake is the safe point to recreate that one fixed container,
        # update the mounted worker, and tighten its port binding to loopback.
        if engine_id == "step_audio" and response.status_code == 404:
            health = await self._health(engine_id, timeout=2)
            if health and health.get("busy"):
                raise LifecycleError(409, "Step-Audio 正在生成，不能更新容器", "model_busy")
            await self._run_process(
                ["pwsh", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(self.scripts_root / "start_step_docker.ps1"), "-Recreate"],
                engine_id,
                "recreate",
            )
            await self._wait_for_health(engine_id, 180)
            async with httpx.AsyncClient(timeout=httpx.Timeout(900, connect=5)) as client:
                response = await client.post(url)
        if response.status_code not in {200, 204}:
            detail = self._response_detail(response)
            raise LifecycleError(response.status_code, detail or "模型加载失败", "model_wake_failed")
        return "模型已加载到显存，可以立即生成"

    async def _unload(self, engine_id: str) -> str:
        health = await self._health(engine_id, timeout=2)
        if health is None:
            return "服务未运行，无需释放"
        if health.get("busy"):
            raise LifecycleError(409, "模型正在生成，完成后才能释放显存", "model_busy")
        async with httpx.AsyncClient(timeout=httpx.Timeout(120, connect=4)) as client:
            response = await client.post(LOCAL_WORKERS[engine_id]["url"] + "/admin/unload")
        if response.status_code not in {200, 204}:
            raise LifecycleError(response.status_code, self._response_detail(response) or "释放显存失败", "model_unload_failed")
        return "模型权重已从显存释放，服务仍在线"

    async def _stop(self, engine_id: str) -> str:
        health = await self._health(engine_id, timeout=2)
        if health and health.get("busy"):
            raise LifecycleError(409, "模型正在生成，不能停止服务", "model_busy")
        if engine_id == "step_audio":
            process = await asyncio.to_thread(
                subprocess.run,
                ["docker", "stop", "step-audio"],
                capture_output=True,
                text=True,
                timeout=120,
                check=False,
            )
            if process.returncode != 0 and "No such container" not in (process.stderr or ""):
                raise LifecycleError(500, "Step-Audio 容器停止失败", "model_stop_failed")
            return "Step-Audio 容器已停止"

        pid = self._managed_pid(engine_id) or await asyncio.to_thread(self._port_pid, int(ENGINE_CATALOG[engine_id]["port"]))
        if not pid:
            return "服务未运行"
        command_line = await asyncio.to_thread(self._process_command_line, pid)
        if not self._matches_engine_process(engine_id, command_line):
            raise LifecycleError(409, "端口上的进程不是已识别的模型服务，已拒绝停止", "unmanaged_process")
        result = await asyncio.to_thread(
            subprocess.run,
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        if result.returncode != 0 and self._port_open(int(ENGINE_CATALOG[engine_id]["port"])):
            raise LifecycleError(500, "模型服务停止失败", "model_stop_failed")
        self._pid_path(engine_id).unlink(missing_ok=True)
        return "模型服务已停止，显存已释放"

    def _launch_command(self, engine_id: str) -> tuple[list[str], Path, dict[str, str]]:
        paths = self._paths(engine_id)
        env = dict(os.environ)
        env["TTS_RUNTIME_ROOT"] = str(self.runtime_root)
        env["HF_HOME"] = str(self.runtime_root / "hf")
        if engine_id == "chatterbox":
            return [str(paths["chatterbox_python"]), str(self.workers_root / "chatterbox_worker.py")], self.workers_root, env
        if engine_id == "qwen_local":
            env["QWEN_TTS_MODEL"] = str(paths["qwen_base"])
            return [str(paths["qwen_python"]), str(self.workers_root / "qwen_worker.py")], self.workers_root, env
        if engine_id == "qwen_voice_design":
            env["QWEN_DESIGN_MODEL"] = str(paths["qwen_design"])
            return [str(paths["qwen_python"]), str(self.workers_root / "qwen_design_worker.py")], self.workers_root, env
        if engine_id == "voxcpm2":
            env["VOXCPM_MODEL"] = str(paths["voxcpm"])
            return [str(paths["voxcpm_python"]), str(self.workers_root / "voxcpm_worker.py")], self.workers_root, env
        if engine_id == "fish":
            command = [
                str(paths["fish_python"]), "tools/api_server.py",
                "--llama-checkpoint-path", str(paths["fish_model"]),
                "--decoder-checkpoint-path", str(paths["fish_model"] / "codec.pth"),
                "--half", "--listen", "127.0.0.1:7013",
            ]
            return command, paths["fish_repo"], env
        raise LifecycleError(400, "此模型没有启动配置", "model_launcher_missing")

    async def _run_process(self, command: list[str], engine_id: str, label: str) -> None:
        log_out, log_err = self._log_paths(engine_id, label)
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        with log_out.open("ab") as stdout, log_err.open("ab") as stderr:
            process = subprocess.Popen(
                command,
                cwd=str(self.project_root),
                stdin=subprocess.DEVNULL,
                stdout=stdout,
                stderr=stderr,
                creationflags=flags,
            )
            return_code = await asyncio.to_thread(process.wait)
        if return_code != 0:
            tail = self._tail(log_err)
            raise LifecycleError(500, f"操作失败（退出码 {return_code}）{': ' + tail if tail else ''}", "model_process_failed")

    async def _wait_for_health(self, engine_id: str, timeout_seconds: int) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            health = await self._health(engine_id, timeout=2)
            if health is not None:
                return health
            await asyncio.sleep(1)
        raise LifecycleError(504, "模型服务启动超时，请查看服务日志", "model_start_timeout")

    async def _health(self, engine_id: str, timeout: float) -> dict[str, Any] | None:
        path = "/v1/health" if engine_id == "fish" else "/health"
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(timeout)) as client:
                response = await client.get(LOCAL_WORKERS[engine_id]["url"] + path)
            if response.status_code != 200:
                return None
            payload = response.json()
            return payload if isinstance(payload, dict) else {}
        except (httpx.HTTPError, ValueError):
            return None

    @staticmethod
    def _response_detail(response: httpx.Response) -> str:
        try:
            payload = response.json()
            return str(payload.get("detail") or payload.get("message") or "")[:300]
        except (ValueError, AttributeError):
            return ""

    def _log_paths(self, engine_id: str, label: str) -> tuple[Path, Path]:
        settings.logs_dir.mkdir(parents=True, exist_ok=True)
        return settings.logs_dir / f"model-{engine_id}-{label}.out.log", settings.logs_dir / f"model-{engine_id}-{label}.err.log"

    def _disk_probe_path(self) -> Path:
        candidate = self.runtime_root
        while not candidate.exists() and candidate.parent != candidate:
            candidate = candidate.parent
        return candidate

    def _pid_path(self, engine_id: str) -> Path:
        return self.state_root / f"{engine_id}.pid"

    def _managed_pid(self, engine_id: str) -> int | None:
        try:
            pid = int(self._pid_path(engine_id).read_text(encoding="ascii").strip())
        except (OSError, ValueError):
            return None
        command = self._process_command_line(pid)
        return pid if self._matches_engine_process(engine_id, command) else None

    @staticmethod
    def _port_open(port: int) -> bool:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.4):
                return True
        except OSError:
            return False

    @staticmethod
    def _port_pid(port: int) -> int | None:
        if os.name != "nt":
            return None
        script = f"$p=(Get-NetTCPConnection -State Listen -LocalPort {int(port)} -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; if($p){{$p}}"
        result = subprocess.run(["powershell", "-NoProfile", "-Command", script], capture_output=True, text=True, timeout=10, check=False)
        try:
            return int((result.stdout or "").strip())
        except ValueError:
            return None

    @staticmethod
    def _process_command_line(pid: int) -> str:
        if os.name != "nt" or pid < 1:
            return ""
        script = (
            f"$p=Get-CimInstance Win32_Process -Filter \"ProcessId = {int(pid)}\" -ErrorAction SilentlyContinue; "
            "if($p){@{Name=$p.Name;CommandLine=$p.CommandLine}|ConvertTo-Json -Compress}"
        )
        result = subprocess.run(["powershell", "-NoProfile", "-Command", script], capture_output=True, text=True, timeout=10, check=False)
        try:
            payload = json.loads(result.stdout or "{}")
            return f"{payload.get('Name', '')} {payload.get('CommandLine', '')}".casefold()
        except (ValueError, AttributeError):
            return ""

    @staticmethod
    def _matches_engine_process(engine_id: str, command_line: str) -> bool:
        needles = {
            "chatterbox": "chatterbox_worker.py",
            "qwen_local": "qwen_worker.py",
            "fish": "tools\\api_server.py",
            "voxcpm2": "voxcpm_worker.py",
            "qwen_voice_design": "qwen_design_worker.py",
        }
        needle = needles.get(engine_id, "")
        text = str(command_line or "").replace("/", "\\").casefold()
        return bool(needle and needle.casefold() in text)

    @staticmethod
    def _tail(path: Path, limit: int = 360) -> str:
        try:
            text = path.read_text(encoding="utf-8", errors="replace").strip().replace("\r", " ").replace("\n", " ")
            return text[-limit:]
        except OSError:
            return ""


model_lifecycle = ModelLifecycleManager()
