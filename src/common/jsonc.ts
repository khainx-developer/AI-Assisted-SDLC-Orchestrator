/** Parses JSON with full-line // comments and trailing commas. */
export function parseJsonc(raw: string): { data: any; hadComments: boolean } | null {
  try { return { data: JSON.parse(raw), hadComments: false }; } catch { /* try relaxed */ }
  try {
    const relaxed = raw.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join("\n").replace(/,(\s*[}\]])/g, "$1");
    return { data: JSON.parse(relaxed), hadComments: true };
  } catch { return null; }
}
