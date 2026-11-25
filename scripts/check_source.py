"""Verify that the original project's source files were left untouched."""
import hashlib
import json
from pathlib import Path


root = Path(__file__).resolve().parents[1]
source = root.parent / "简历候选Agent"
baseline = json.loads((root / "docs/source-baseline.json").read_text())
changed = [name for name, digest in baseline.items()
           if not (source / name).is_file() or hashlib.sha256((source / name).read_bytes()).hexdigest() != digest]
if changed:
    raise SystemExit("原项目文件与基线不同：\n" + "\n".join(changed))
print(f"通过：原项目 {len(baseline)} 个源文件与复制前哈希一致。")
