"""Seed the Chromium cookie jar with fake desktop-auth cookies.

Used by the manual cookie test: the app must be closed, because Chromium holds
the database open while it runs.
"""

import os
import sqlite3
import sys
import time

COUNT = int(sys.argv[1]) if len(sys.argv) > 1 else 80
DB = os.path.join(os.environ.get("APPDATA", ""), "@deepseek-ai", "dsh-desktop", "Network", "Cookies")

if not os.path.exists(DB):
    print("no cookie database at", DB)
    sys.exit(1)

now = int((time.time() + 11644473600) * 1_000_000)  # Chromium: microseconds since 1601
expires = now + 30 * 24 * 60 * 60 * 1_000_000

connection = sqlite3.connect(DB, timeout=10)
columns = {row[1]: row for row in connection.execute("pragma table_info(cookies)")}
print("columns:", len(columns))


def defaults(name):
    return {
        "creation_utc": now,
        "host_key": "127.0.0.1",
        "top_frame_site_key": "",
        "name": name,
        "value": "v1." + "x" * 120,
        "encrypted_value": b"",
        "path": "/",
        "expires_utc": expires,
        "is_secure": 0,
        "is_httponly": 1,
        "last_access_utc": now,
        "has_expires": 1,
        "is_persistent": 1,
        "priority": 1,
        "samesite": 2,
        "source_scheme": 1,
        "source_port": 443,
        "last_update_utc": now,
        "source_type": 0,
        "has_cross_site_ancestor": 0,
    }


def insert(row_name, host, value):
    values = defaults(row_name)
    values["host_key"] = host
    values["value"] = value
    known = [name for name in values if name in columns]
    placeholders = ",".join("?" for _ in known)
    connection.execute(
        f"insert into cookies ({','.join(known)}) values ({placeholders})",
        [values[name] for name in known],
    )


def count():
    total = connection.execute("select count(*) from cookies").fetchone()[0]
    auth = connection.execute("select count(*) from cookies where name like 'dsh-auth-%'").fetchone()[0]
    return total, auth


connection.execute("delete from cookies where name like 'dsh-auth-test-%' or name = 'keep-me'")
connection.commit()
print("before: total=%d auth=%d" % count())
for index in range(COUNT):
    insert(f"dsh-auth-test-{index}", "127.0.0.1", "v1." + "x" * 120)
insert("keep-me", "127.0.0.1", "keep")
connection.commit()
print("after seed: total=%d auth=%d" % count())
connection.close()
