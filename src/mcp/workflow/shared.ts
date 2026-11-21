import { z } from "zod";
import { Workflow, WorkflowError } from "../../workflow/service.js";

/** The one Workflow (SQLite) instance of this server process. */
export const wf = new Workflow();

export type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
export function run(fn: () => unknown): Result {
  try {
    const out = fn();
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  } catch (e: any) {
    const known = e instanceof WorkflowError || e?.name === "ZodError";
    return { content: [{ type: "text", text: `${known ? "" : "internal error: "}${e?.message ?? e}` }], isError: true };
  }
}

export const Flags = z.object({
  files_affected: z.number().int().min(0),
  reversible: z.boolean(),
  breaking: z.boolean(),
  has_precedent: z.boolean(),
  requirement_clarity: z.enum(["high", "low"]),
});
export const tid = z.string().describe("task_id");
