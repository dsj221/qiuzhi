"""Finish the macOS login-service handoff and verify the serving process."""
import http.client
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import subprocess
import sys
import time


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"


def output(*args):
    return subprocess.run(args, capture_output=True, text=True).stdout.strip()


def listener():
    pids = output("/usr/sbin/lsof", "-nP", "-t", "-iTCP:8766", "-sTCP:LISTEN").split()
    if len(pids) > 1:
        raise SystemExit("8766 有多个监听进程，已保留现场。")
    return int(pids[0]) if pids else None


def parent(pid):
    return output("/bin/ps", "-p", str(pid), "-o", "ppid=")


def owned_command(pid, expected):
    owner = output("/bin/ps", "-p", str(pid), "-o", "uid=")
    cmd = output("/bin/ps", "-ww", "-p", str(pid), "-o", "command=")
    return owner == str(os.getuid()) and expected in cmd.split()


def check_api():
    token = (DATA / "admin.token").read_text().strip()
    conn = http.client.HTTPConnection("127.0.0.1", 8766, timeout=150)
    try:
        conn.request("POST", "/api/model/check", body=b"", headers={"Authorization": "Bearer " + token})
        response = conn.getresponse()
        body = json.load(response)
        if response.status != 200 or body.get("ok") is not True:
            raise SystemExit("工作台已在线，但模型生成测试失败：" + str(body.get("detail", response.status)))
    finally:
        conn.close()


def verify(label, runtime=None):
    lock = DATA / "workbench-supervisor.lock"
    for _ in range(20):
        info = output("/bin/launchctl", "print", f"gui/{os.getuid()}/{label}")
        match = re.search(r"^\s*pid = (\d+)\s*$", info, re.M)
        holders = output("/usr/sbin/lsof", "-t", str(lock)).split()
        if match and match[1] in holders:
            break
        time.sleep(0.5)
    else:
        state = next((line.strip() for line in info.splitlines() if "last exit code =" in line), "")
        raise SystemExit(f"登录服务未持有工作台锁。{state} 日志位于 {(runtime or ROOT) / 'data/workbench.log'}")

    managed = int(match[1])
    old = listener()
    expected = json.loads((ROOT / "extension/manifest.json").read_text())["version"] if runtime else None
    outdated = False
    if old and expected and parent(old) == str(managed):
        conn = http.client.HTTPConnection("127.0.0.1", 8766, timeout=3)
        try:
            conn.request("GET", "/health")
            outdated = json.load(conn.getresponse()).get("workflow_version") != expected
        finally:
            conn.close()
    legacy = [int(pid) for pid in set(holders) if int(pid) != managed]
    # Confirm identities before stopping anything. A blocked launchd worker can
    # already have the lock file open while the previous supervisor still owns it.
    for pid in legacy:
        cmd = output("/bin/ps", "-ww", "-p", str(pid), "-o", "command=").split()
        if not cmd or not any(Path(arg).name == "keep_workbench_running.py" for arg in cmd) or not owned_command(pid, cmd[0]):
            raise SystemExit("无法确认旧守护进程的身份，已保留现场。")
    if old and (outdated or parent(old) != str(managed)):
        cwd = output("/usr/sbin/lsof", "-a", "-p", str(old), "-d", "cwd", "-Fn").splitlines()
        valid_cwds = {"n" + str(ROOT), "n" + str(runtime or ROOT)}
        if not valid_cwds.intersection(cwd) or not owned_command(old, "job_agent.app:app"):
            raise SystemExit("8766 正由其他程序使用，已保留现场。")
        with sqlite3.connect((DATA / "job-agent.sqlite3").as_uri() + "?mode=ro", uri=True) as db:
            busy = db.execute("""SELECT count(*) FROM records WHERE kind='follow_watch'
                AND (json_extract(body,'$.reply') IN ('reserved','sending')
                     OR json_extract(body,'$.resume')='sending')""").fetchone()[0]
        if busy:
            raise SystemExit("工作台正在发送消息，请在本轮结束后重新打开。")
        for pid in legacy:
            os.kill(pid, signal.SIGTERM)
        if listener() == old and owned_command(old, "job_agent.app:app"):
            os.kill(old, signal.SIGTERM)
    elif not old:
        for pid in legacy:
            os.kill(pid, signal.SIGTERM)

    for _ in range(120):
        active = listener()
        if active and parent(active) == str(managed):
            conn = http.client.HTTPConnection("127.0.0.1", 8766, timeout=2)
            try:
                conn.request("GET", "/health")
                health = json.load(conn.getresponse())
                if health.get("app") == "job-search-agent" and (not expected or health.get("workflow_version") == expected):
                    break
            except (OSError, ValueError, http.client.HTTPException):
                pass
            finally:
                conn.close()
        time.sleep(0.5)
    else:
        raise SystemExit("登录服务还未接管 8766，请查看 data/workbench.log。")
    if (DATA / "deepseek.key").exists() or os.getenv("MODEL_API_KEY") or os.getenv("DEEPSEEK_API_KEY"):
        check_api()
        print("当前工作台已通过 AI 回复生成测试。")
    print("登录服务已接管 8766，可以关闭此窗口。")


if __name__ == "__main__":
    verify(sys.argv[1], Path(sys.argv[2]) if len(sys.argv) > 2 else None)
