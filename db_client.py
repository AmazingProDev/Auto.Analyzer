import os
import sqlite3


def is_turso_enabled():
    return bool((os.getenv('TURSO_DATABASE_URL') or '').strip())


def db_backend_name():
    return 'turso' if is_turso_enabled() else 'sqlite'


def _resolve_db_path(db_path):
    if db_path:
        return db_path
    return os.getenv('TRP_DB_PATH') or '/tmp/trp_runs.db'


def connect_db(db_path=None):
    db_path = _resolve_db_path(db_path)
    turso_url = (os.getenv('TURSO_DATABASE_URL') or '').strip()
    if not turso_url:
        return sqlite3.connect(db_path)

    auth_token = (os.getenv('TURSO_AUTH_TOKEN') or '').strip()
    if not auth_token:
        raise RuntimeError('TURSO_AUTH_TOKEN is required when TURSO_DATABASE_URL is set')

    local_replica = (os.getenv('TURSO_LOCAL_REPLICA_PATH') or '').strip() or db_path
    parent = os.path.dirname(local_replica)
    if parent:
        os.makedirs(parent, exist_ok=True)
    try:
        import libsql  # pip install libsql-experimental
    except Exception as exc:
        raise RuntimeError(
            'Turso mode requires python package "libsql-experimental". '
            'Install it and redeploy.'
        ) from exc

    conn = libsql.connect(local_replica, sync_url=turso_url, auth_token=auth_token)
    try:
        conn.sync()
    except Exception:
        pass
    return conn


def sync_if_needed(conn):
    if not is_turso_enabled():
        return
    try:
        conn.sync()
    except Exception:
        pass
