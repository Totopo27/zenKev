$dbPath = "$env:USERPROFILE\.local\share\opencode\opencode.db"
$time = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
python -c "
import sqlite3, os
db_path = os.path.expanduser('~/.local/share/opencode/opencode.db')
if os.path.exists(db_path):
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    cur.execute('SELECT id FROM session_v2 WHERE time_archived IS NULL ORDER TO time_created DESC LIMIT 1')
    row = cur.fetchone()
    if row:
        session_id = row[0]
        cur.execute('UPDATE session_v2 SET time_archived = ? WHERE id = ?', ($time, session_id))
        conn.commit()
        print(f'Archived session {session_id}')
    conn.close()
"
