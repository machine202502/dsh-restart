"""Report cookie counts without changing anything (app must be closed)."""

import os
import sqlite3

DB = os.path.join(os.environ.get("APPDATA", ""), "@deepseek-ai", "dsh-desktop", "Network", "Cookies")

if not os.path.exists(DB):
    print("no cookie database")
    raise SystemExit(0)

connection = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=5)
total = connection.execute("select count(*) from cookies").fetchone()[0]
auth = connection.execute("select count(*) from cookies where name like 'dsh-auth-%'").fetchone()[0]
hosts = connection.execute("select host_key, count(*) from cookies group by host_key").fetchall()
length = connection.execute("select coalesce(sum(length(name) + length(value) + 3), 0) from cookies").fetchone()[0]
print(f"total={total} auth={auth} approx_cookie_header={length} bytes")
for host, count in hosts:
    print(f"  {host}: {count}")
connection.close()
