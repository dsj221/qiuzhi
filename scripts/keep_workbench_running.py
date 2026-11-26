"""Keep one local workbench available without interrupting an existing session."""
import fcntl
import os
from pathlib import Path
import socket
import subprocess
import time


def supervise(port, command, retry_seconds):
    while True:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=2):
                pass
        except ConnectionRefusedError:
            subprocess.run(command, check=False)
        except OSError:
            # If the port cannot be checked, wait before trying again.
            pass
        time.sleep(retry_seconds)


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[1]
    os.umask(0o077)
    data = root / "data"
    data.mkdir(exist_ok=True)
    with (data / "workbench-supervisor.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        supervise(8766, ["/bin/zsh", str(root / "run.sh")], 5)
