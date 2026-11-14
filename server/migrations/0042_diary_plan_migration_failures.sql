CREATE TABLE diary_plan_migration_failures (
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  code TEXT NOT NULL,
  PRIMARY KEY (owner_user_id, date)
);
