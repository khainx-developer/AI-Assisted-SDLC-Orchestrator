import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";

/**
 * Windows: pick something we can spawn reliably. VS Code puts a "copilot-shim" on PATH that refuses
 * multi-line arguments and cannot launch npm's copilot.cmd ("UnsupportedWindowsCommandValue"),
 * so for copilot we go straight to the native binary the npm package ships.
 */
export function resolveExe(cmd: string): string {
  if (process.platform !== "win32" || extname(cmd)) return cmd;
  let hits: string[] = [];
  try { hits = execFileSync("where", [cmd], { encoding: "utf8" }).split(/\r?\n/).map((l) => l.trim()).filter(Boolean); } catch { return cmd; }
  if (cmd === "copilot") {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    for (const h of hits.filter((l) => /\.cmd$/i.test(l))) {
      const native = join(dirname(h), "node_modules", "@github", "copilot", "node_modules", "@github", `copilot-win32-${arch}`, "copilot.exe");
      if (existsSync(native)) return native;
    }
  }
  const real = hits.filter((l) => !/copilot-shim/i.test(l));
  return real.find((l) => /\.exe$/i.test(l)) ?? real[0] ?? hits[0] ?? cmd;
}

/** Kill the CLI and everything it spawned. child.kill() alone leaves grandchildren running on Windows (cmd shims, node wrappers). */
export function killTree(pid?: number) {
  if (!pid) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(pid, "SIGKILL");
  } catch { /* already gone */ }
}
