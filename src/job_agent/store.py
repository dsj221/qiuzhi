import json
import os
import sqlite3
import threading
from contextlib import contextmanager


class Store:
    """Small single-user store. All read/modify/write operations use one transaction."""
    def __init__(self, path):
        self.lock = threading.RLock()
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        os.chmod(path, 0o600)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA secure_delete=ON")
        self.db.execute("CREATE TABLE IF NOT EXISTS records (kind TEXT, id TEXT, body TEXT NOT NULL, PRIMARY KEY(kind,id))")
        self.db.commit()

    @contextmanager
    def transaction(self):
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                yield self
                self.db.commit()
            except BaseException:
                self.db.rollback()
                raise

    def get(self, kind, key):
        row = self.db.execute("SELECT body FROM records WHERE kind=? AND id=?", (kind, key)).fetchone()
        return json.loads(row[0]) if row else None

    def all(self, kind):
        return [json.loads(row[0]) for row in self.db.execute("SELECT body FROM records WHERE kind=? ORDER BY rowid", (kind,))]

    def put(self, kind, value):
        self.db.execute("INSERT INTO records(kind,id,body) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
                        (kind, value["id"], json.dumps(value, ensure_ascii=False)))
        return value

    def delete(self, kind, key):
        self.db.execute("DELETE FROM records WHERE kind=? AND id=?", (kind, key))

