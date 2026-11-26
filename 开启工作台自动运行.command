#!/bin/zsh
set -eu
cd "${0:A:h}"
umask 077
label=local.qiuzhiagent.workbench
domain="gui/$(id -u)"
plist="$HOME/Library/LaunchAgents/$label.plist"
runtime="$HOME/Library/Application Support/$label"
/usr/bin/python3 scripts/install_login_runtime.py "$runtime"
/usr/bin/python3 - "$plist" "$label" "$runtime" <<'PY'
import os, plistlib, sys, tempfile
from pathlib import Path

path = Path(sys.argv[1])
root = Path(sys.argv[3])
config = dict(Label=sys.argv[2], RunAtLoad=True, KeepAlive=True, ThrottleInterval=10,
              ProgramArguments=["/usr/bin/python3", str(root / "scripts/keep_workbench_running.py")],
              StandardOutPath=str(root / "data/workbench.log"),
              StandardErrorPath=str(root / "data/workbench.log"))
path.parent.mkdir(parents=True, exist_ok=True)
(root / "data").mkdir(exist_ok=True)
if not path.exists() or plistlib.loads(path.read_bytes()) != config:
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as tmp:
        plistlib.dump(config, tmp)
    os.replace(tmp.name, path)
PY
/usr/bin/plutil -lint "$plist"
/bin/launchctl enable "$domain/$label"
if loaded=$(/bin/launchctl print "$domain/$label" 2>/dev/null); then
  if [[ "$loaded" != *"$runtime/scripts/keep_workbench_running.py"* ]]; then
    /bin/launchctl bootout "$domain/$label"
    for attempt in {1..40}; do
      /bin/launchctl print "$domain/$label" >/dev/null 2>&1 || break
      sleep 0.25
    done
    /bin/launchctl bootstrap "$domain" "$plist"
  fi
else
  /bin/launchctl bootstrap "$domain" "$plist"
fi
exec /usr/bin/python3 scripts/verify_managed_workbench.py "$label" "$runtime"
