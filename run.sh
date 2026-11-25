#!/bin/zsh
set -eu
cd "${0:A:h}"
export PYTHONPYCACHEPREFIX="$PWD/.cache/pycache"
if [[ ! -x .venv/bin/python ]]; then
  python3 -m venv .venv
fi
if ! .venv/bin/python -c 'import fastapi, uvicorn, httpx, pypdf, docx, cryptography' 2>/dev/null; then
  .venv/bin/python -m pip install -r requirements.lock
fi
if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi
export JOB_AGENT_DATA="$PWD/data"
export PYTHONPATH="$PWD/src${PYTHONPATH:+:$PYTHONPATH}"
print '求职 Agent：http://127.0.0.1:8766（Ctrl+C 停止）'
exec .venv/bin/python -m uvicorn job_agent.app:app --host 127.0.0.1 --port 8766 --no-access-log
