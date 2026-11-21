/** The background runner of an unattended run: where its output goes, how to read it, how to start it. */
import { spawn } from "node:child_process";
import { openSync, mkdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "../shared/paths.js";

export const runnerLogPath = (run_id: string) => join(dataDir(), "autopilot", `${run_id}.log`);

/** Last `lines` lines of the runner's log (empty when there is none yet) and when it was last written. */
export function readRunnerLog(run_id: string, lines = 30): { path: string; updated_at: string | null; tail: string[] } {
  const path = runnerLogPath(run_id);
  if (!existsSync(path)) return { path, updated_at: null, tail: [] };
  const text = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  return { path, updated_at: statSync(path).mtime.toISOString(), tail: text.slice(-Math.max(1, lines)) };
}

/** Start `autopilot start --resume <run_id>` detached, so the run continues after the chat or terminal that asked for it is gone. */
export function launchRunner(run_id: string): { pid: number | null; log: string } {
  const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli", "index.js");
  const log = runnerLogPath(run_id);
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, "a");
  const child = spawn(process.execPath, [cli, "autopilot", "start", "--resume", run_id], { detached: true, stdio: ["ignore", fd, fd], windowsHide: true });
  child.unref();
  return { pid: child.pid ?? null, log };
}
