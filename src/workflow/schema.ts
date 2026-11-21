export const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  project_root TEXT NOT NULL,
  parent_task_id TEXT REFERENCES tasks(task_id),
  title TEXT NOT NULL,
  description TEXT,
  source TEXT NOT NULL CHECK (source IN ('jira','adhoc')),
  stage TEXT NOT NULL,
  stage_entered_at TEXT NOT NULL,
  flags_json TEXT NOT NULL,
  linked_refs_json TEXT,
  related_repos_json TEXT,
  coordinated_release INTEGER DEFAULT 0,
  needs_attention INTEGER DEFAULT 0,
  retry_count INTEGER DEFAULT 0,
  dispatch_id TEXT,
  dispatch_status TEXT CHECK (dispatch_status IN ('in-flight','completed','failed')),
  target_files_json TEXT,
  base_branch TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_repo_stage ON tasks(project_root, stage);
CREATE TABLE IF NOT EXISTS transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  from_stage TEXT, to_stage TEXT, reason TEXT, policy_version TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stage_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  stage TEXT NOT NULL, version INTEGER NOT NULL,
  content TEXT NOT NULL DEFAULT '', -- legacy rows only; new artifacts live in file (relative to the data dir)
  file TEXT,
  input_refs_json TEXT, skill_version TEXT, platform TEXT, created_at TEXT NOT NULL,
  UNIQUE(task_id, stage, version)
);
CREATE TABLE IF NOT EXISTS edge_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  description TEXT, decision TEXT, reasoning TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS change_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  stage TEXT, request TEXT NOT NULL, affects TEXT, status TEXT NOT NULL DEFAULT 'active',
  folded_into TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  stage TEXT NOT NULL, approved_by TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS search_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL, project_root TEXT, hits INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS review_marks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_root TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS autonomy_runs (
  run_id TEXT PRIMARY KEY,
  project_root TEXT NOT NULL,
  started_at TEXT NOT NULL,
  deadline TEXT,
  max_dispatches INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','stopped','finished')),
  ended_at TEXT,
  end_reason TEXT
);
-- every decision, approval, park and runner tick of an unattended run: the source of the morning report
CREATE TABLE IF NOT EXISTS autonomy_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT, task_id TEXT,
  kind TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_autonomy_log_task ON autonomy_log(task_id, kind);
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(kind UNINDEXED, task_id UNINDEXED, project_root UNINDEXED, stage UNINDEXED, text);
`;
