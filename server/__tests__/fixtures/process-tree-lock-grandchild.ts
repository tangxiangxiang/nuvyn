import Database from 'better-sqlite3'

const dbPath = process.env.NUVYN_PROCESS_TREE_DB

if (!dbPath) {
  process.exit(2)
}

const db = new Database(dbPath)

db.exec(
  'CREATE TABLE IF NOT EXISTS lock_test(id INTEGER)',
)

process.stdout.write(
  'READY:grandchild-lock\n',
)

setInterval(
  () => {},
  1_000,
)
