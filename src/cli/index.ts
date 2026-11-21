#!/usr/bin/env node
/**
 * sdlc-orchestrator: command-line entry point. This file only routes `argv` to a command module in ./commands.
 * `--help` text lives in ./help.ts; shared option helpers in ./args.ts.
 */
import { HELP } from "./help.js";

const argv = process.argv.slice(2);
const [cmd] = argv;

switch (cmd) {
  case "tasks": (await import("./commands/tasks.js")).tasksCommand(argv.slice(1)); break;
  case "dispatches": (await import("./commands/dispatches.js")).dispatchesCommand(argv); break;
  case "knowledge": (await import("./commands/knowledge.js")).knowledgeCommand(argv); break;
  case "evals": await (await import("./commands/evals.js")).evalsCommand(argv); break;
  case "autopilot": await (await import("./commands/autopilot.js")).autopilotCommand(argv); break;
  case "repos": (await import("./commands/settings.js")).reposCommand(argv.slice(1)); break;
  case "model": (await import("./commands/settings.js")).modelCommand(argv.slice(1)); break;
  case "branch": (await import("./commands/settings.js")).branchCommand(argv.slice(1)); break;
  case "config": (await import("./commands/settings.js")).configCommand(argv.slice(1)); break;
  case "install":
    if (argv.includes("-h") || argv.includes("--help")) console.log(HELP);
    else (await import("./commands/install.js")).installCommand(argv);
    break;
  default:
    console.log(HELP);
    process.exitCode = argv.length === 0 ? 0 : 1;
}
process.exit(process.exitCode ?? 0);
