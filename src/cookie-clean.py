"""Remove stale desktop auth cookies that break the welcome handshake.

Chromium scopes cookies by host, not by port, while the Desktop Host listens on
a new random port on every launch and names its cookie `dsh-auth-<random>`. Old
cookies are never replaced, so after dozens of launches the Cookie header no
longer fits into the default 16 KB header limit and the welcome request fails
with HTTP 431 ("Web authentication failed").

Only `dsh-auth-*` rows for loopback hosts are removed; every other cookie and the
account sign-in stay untouched. Chromium must not be running (the plugin calls
this after killing the app).
"""

import os
import sqlite3
import sys

DB = os.path.join(os.environ.get("APPDATA", ""), "@deepseek-ai", "dsh-desktop", "Network", "Cookies")

if not os.path.exists(DB):
    print("cookies: no database")
    sys.exit(0)

try:
    connection = sqlite3.connect(DB, timeout=10)
    cursor = connection.execute(
        "delete from cookies where host_key in ('127.0.0.1', 'localhost') and name like 'dsh-auth-%'"
    )
    removed = cursor.rowcount
    connection.commit()
    try:
        connection.execute("pragma wal_checkpoint(truncate)")
    except sqlite3.Error:
        pass
    connection.close()
    print(f"cookies: removed {removed}")
except Exception as error:  # noqa: BLE001 - the helper must never block a restart
    print(f"cookies: failed {error}")
