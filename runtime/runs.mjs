import { DatabaseSync } from "node:sqlite";

const runColumns = `
  run_id, session_id, cwd, model, status, started_at, finished_at,
  cancel_requested, error, effort
`;

export function summarizeRun({ cancel_requested, error, ...run }) {
  return {
    ...run,
    status: run.status === "running" && cancel_requested ? "cancelling" : run.status,
    ...(error ? { error } : {}),
  };
}

export function openRuns(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY, cwd TEXT NOT NULL, model TEXT,
      session_id TEXT NOT NULL, status TEXT NOT NULL, owner_pid INTEGER NOT NULL,
      started_at TEXT NOT NULL, finished_at TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0,
      answer TEXT, error TEXT, steps TEXT NOT NULL DEFAULT '[]', effort TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_turn_per_session ON runs(session_id) WHERE status = 'running';
  `);

  db.exec("BEGIN IMMEDIATE");
  try {
    if (!db.prepare("SELECT 1 FROM pragma_table_info('runs') WHERE name = 'effort'").get()) {
      db.exec("ALTER TABLE runs ADD COLUMN effort TEXT");
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    throw error;
  }

  const insert = db.prepare(`
    INSERT INTO runs (run_id, cwd, session_id, model, status, owner_pid, started_at)
    VALUES (?, ?, ?, ?, 'running', ?, ?)
    ON CONFLICT(session_id) WHERE status = 'running' DO NOTHING
  `);
  const read = db.prepare(`SELECT ${runColumns} FROM runs WHERE run_id = ?`);
  const readDetails = db.prepare(`SELECT ${runColumns}, steps, answer FROM runs WHERE run_id = ?`);
  const latestSelection = db.prepare(`
    SELECT model, effort FROM runs
    WHERE session_id = ? AND status = 'succeeded' AND model <> ''
    ORDER BY rowid DESC LIMIT 1
  `);
  const recent = db.prepare(`
    SELECT ${runColumns} FROM runs
    ORDER BY (status = 'running') DESC, started_at DESC, run_id
    LIMIT ? OFFSET ?
  `);
  const runningOwners = db.prepare("SELECT run_id, owner_pid FROM runs WHERE status = 'running'");
  const saveModel = db.prepare("UPDATE runs SET model = ? WHERE run_id = ?");
  const saveEffort = db.prepare("UPDATE runs SET effort = ? WHERE run_id = ?");
  const saveSteps = db.prepare("UPDATE runs SET steps = ? WHERE run_id = ?");
  const readCancel = db.prepare("SELECT cancel_requested FROM runs WHERE run_id = ?");
  const markCancel = db.prepare(`
    UPDATE runs SET cancel_requested = 1
    WHERE run_id = ? AND status = 'running' AND cancel_requested = 0
  `);
  const finish = db.prepare(`
    UPDATE runs SET status = ?, finished_at = ?, answer = ?, error = ?
    WHERE run_id = ? AND status = 'running'
  `);

  return {
    begin({ id, cwd, sessionId, model }) {
      const result = insert.run(id, cwd, sessionId, model ?? null, process.pid, new Date().toISOString());
      if (!result.changes) {
        throw new Error("This Claude Code session already has an active turn. Wait for it or cancel it before following up.");
      }
    },
    get: id => read.get(id),
    getDetails: id => readDetails.get(id),
    latestSelection: sessionId => latestSelection.get(sessionId),
    recent: (limit, offset) => recent.all(limit, offset),
    saveModel: (id, model) => saveModel.run(model, id),
    saveEffort: (id, effort) => saveEffort.run(effort, id),
    saveSteps: (id, steps) => saveSteps.run(JSON.stringify(steps), id),
    cancelRequested: id => readCancel.get(id)?.cancel_requested === 1,
    requestCancel: id => markCancel.run(id),
    finish(id, { status, answer = null, error = null }) {
      finish.run(status, new Date().toISOString(), answer, error, id);
    },
    recoverDisconnected() {
      for (const { run_id, owner_pid } of runningOwners.all()) {
        if (owner_pid === process.pid) continue;
        try {
          process.kill(owner_pid, 0);
        } catch (error) {
          if (error.code === "ESRCH") {
            finish.run("disconnected", new Date().toISOString(), null,
              "The MCP process exited before reporting a final result.", run_id);
          }
        }
      }
    },
  };
}
