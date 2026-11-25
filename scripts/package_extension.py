"""Reuse the source project's shared-adapter packaging workflow."""
import shutil
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
shutil.copyfile(root / "src/job_agent/static/boss-adapter.js", root / "extension/boss-adapter.js")
shutil.copyfile(root / "src/job_agent/static/jd-reader.js", root / "extension/jd-reader.js")
shutil.copyfile(root / "extension/fixture-profile.json", root / "src/job_agent/static/fixture-profile.json")
shutil.copyfile(root / "src/job_agent/static/pipeline-adapter.js", root / "extension/pipeline-adapter.js")
output = root / "artifacts"
output.mkdir(exist_ok=True)
with zipfile.ZipFile(output / "job-agent-extension.zip", "w", zipfile.ZIP_DEFLATED) as archive:
    for path in sorted((root / "extension").iterdir()):
        if path.is_file():
            archive.write(path, "job-agent-extension/" + path.name)
print("已生成 artifacts/job-agent-extension.zip（求职端，8766端口）")
