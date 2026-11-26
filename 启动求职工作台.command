#!/bin/zsh
set -eu
cd "${0:A:h}"
print '请保持此终端窗口打开，可以最小化。按 Control+C 停止工作台。'
exec /bin/zsh ./run.sh
