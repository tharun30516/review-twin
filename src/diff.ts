/** A changed region of the new file, with the added lines and their line numbers. */
export interface Hunk {
  path: string;
  header: string;
  newStart: number;
  text: string; // full hunk text (context + changes)
  added: { line: number; text: string }[];
}

/** Parse a unified diff (git diff / GitHub .diff) into hunks, optionally for one file. */
export function parseDiff(diff: string, onlyPath?: string): Hunk[] {
  const hunks: Hunk[] = [];
  let path = "";
  let cur: Hunk | undefined;
  let newLine = 0;

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      path = raw.slice(4).replace(/^b\//, "").trim();
      cur = undefined;
      continue;
    }
    if (raw.startsWith("--- ") || raw.startsWith("diff --git") || raw.startsWith("index ")) continue;
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (m) {
      newLine = Number(m[1]);
      cur = { path, header: raw, newStart: newLine, text: raw + "\n", added: [] };
      if (!onlyPath || path === onlyPath) hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    cur.text += raw + "\n";
    if (raw.startsWith("+")) {
      cur.added.push({ line: newLine, text: raw.slice(1) });
      newLine++;
    } else if (raw.startsWith("-")) {
      // removed line: does not advance the new-file counter
    } else if (raw.startsWith("\\")) {
      // "\ No newline at end of file"
    } else {
      newLine++;
    }
  }
  return hunks.filter((h) => h.added.length > 0);
}
