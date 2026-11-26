"""Prepare a launchd runtime outside Downloads, preserving the live SQLite files."""
import ctypes
import os
from pathlib import Path
import subprocess
import sys


def share_data(source, target):
    if source.is_symlink():
        if not target.is_dir() or not source.samefile(target):
            raise SystemExit("原项目的 data 已指向另一处目录，已保留现有数据。")
        return
    source.mkdir(mode=0o700, exist_ok=True)
    if target.is_symlink() and os.readlink(target) == str(target):
        pass  # Previous installation stopped immediately before the atomic swap.
    elif os.path.lexists(target):
        raise SystemExit("安装位置已有独立的数据目录，已保留两处数据。")
    else:
        target.symlink_to(target, target_is_directory=True)
    # The link points to the destination *after* the swap. All existing handles
    # (including WAL and supervisor lock) and all opens via source stay valid.
    rename = ctypes.CDLL(None, use_errno=True).renamex_np
    rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(os.fsencode(source), os.fsencode(target), 2) != 0:  # RENAME_SWAP
        error = ctypes.get_errno()
        target.unlink()
        raise SystemExit("未能在同一磁盘迁移数据，原数据仍在项目内：" + os.strerror(error))


def install(root, runtime):
    os.umask(0o077)
    runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Relative paths preserve the app layout. Avoid copying unrelated personal
    # artifacts, the git checkout or private data into a second database.
    files = ["src/job_agent", "scripts/keep_workbench_running.py", "run.sh", "requirements.lock"]
    files += [name for name in (".venv", ".env", "artifacts/job-agent-extension.zip") if (root / name).exists()]
    subprocess.run(["/usr/bin/rsync", "-aR", "--exclude=__pycache__", *files, str(runtime) + "/"],
                   cwd=root, check=True)
    if not (root / ".env").exists():
        (runtime / ".env").unlink(missing_ok=True)
    if not (runtime / ".venv/bin/python").exists():
        subprocess.run(["/usr/bin/python3", "-m", "venv", str(runtime / ".venv")], check=True)
    python = str(runtime / ".venv/bin/python")
    if subprocess.run([python, "-c", "import uvicorn,fastapi,httpx,pypdf,docx,cryptography"], cwd=runtime).returncode:
        subprocess.run([python, "-m", "pip", "install", "-r", "requirements.lock"], cwd=runtime, check=True)
    share_data(root / "data", runtime / "data")


if __name__ == "__main__":
    install(Path(__file__).resolve().parents[1], Path(sys.argv[1]).absolute())
