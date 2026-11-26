import sys
import sqlite3
from pathlib import Path
from unittest.mock import Mock

from test_boss_connector import client

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import verify_managed_workbench as handoff
import pytest
from install_login_runtime import share_data


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS login runtime")
def test_migration_keeps_live_database_and_is_repeatable(tmp_path):
    original, installed = tmp_path / "Downloads" / "data", tmp_path / "Application Support" / "data"
    original.mkdir(parents=True)
    installed.parent.mkdir()
    with sqlite3.connect(original / "jobs.db") as old:
        old.execute("PRAGMA journal_mode=WAL")
        old.execute("CREATE TABLE messages (value TEXT)")
        old.execute("INSERT INTO messages VALUES ('before')")
        old.commit()
        inode = (original / "jobs.db").stat().st_ino
        share_data(original, installed)
        share_data(original, installed)
        assert original.is_symlink() and (installed / "jobs.db").stat().st_ino == inode
        old.execute("INSERT INTO messages VALUES ('after')")
        old.commit()
        with sqlite3.connect(installed / "jobs.db") as new:
            assert new.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 2


def test_migration_refuses_two_independent_directories(tmp_path):
    source, installed = tmp_path / "source", tmp_path / "existing"
    source.mkdir()
    installed.mkdir()
    with pytest.raises(SystemExit):
        share_data(source, installed)
    assert not source.is_symlink() and installed.is_dir()


def test_existing_healthy_server_requires_launchd_handoff(tmp_path, monkeypatch):
    monkeypatch.setattr(handoff, "DATA", tmp_path)
    monkeypatch.setattr(handoff, "ROOT", tmp_path)
    with handoff.sqlite3.connect(tmp_path / "job-agent.sqlite3") as db:
        db.execute("CREATE TABLE records (kind TEXT, body TEXT)")
    def output(*args):
        if args[0].endswith("launchctl"):
            return "pid = 21"
        if args[-1].endswith(".lock"):
            return "11\n21"
        if "cwd" in args:
            return "n" + str(tmp_path)
        return "python scripts/keep_workbench_running.py"
    monkeypatch.setattr(handoff, "output", output)
    monkeypatch.setattr(handoff, "owned_command", lambda *args: True)
    monkeypatch.setattr(handoff, "listener", Mock(side_effect=[12, 12, 22]))
    monkeypatch.setattr(handoff, "parent", lambda pid: str(pid - 1))
    kill = Mock()
    monkeypatch.setattr(handoff.os, "kill", kill)
    conn = Mock()
    conn.getresponse.return_value.read.return_value = b'{"app":"job-search-agent"}'
    monkeypatch.setattr(handoff.http.client, "HTTPConnection", lambda *args, **kw: conn)
    (tmp_path / "deepseek.key").touch()
    probe = Mock()
    monkeypatch.setattr(handoff, "check_api", probe)
    handoff.verify("test")
    assert [call.args[0] for call in kill.call_args_list] == [11, 12]
    probe.assert_called_once()


def test_model_probe_requires_admin_and_actual_generation(client, monkeypatch):
    call = Mock(return_value={"ok": True})
    monkeypatch.setattr(client.app.state.service.model, "match_response", call)
    assert client.post("/api/model/check", headers={"Authorization": ""}).status_code == 401
    call.assert_not_called()
    assert client.post("/api/model/check").json() == {"ok": True}
    assert call.call_args.args[1] == {}
    call.return_value = {}
    assert client.post("/api/model/check").status_code == 502
