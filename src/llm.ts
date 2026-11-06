import type { Hunk } from "./diff.js";
import type { ReviewerProfile } from "./profile.js";
import type { PastComment, ReviewFinding } from "./types.js";

export interface ReviewContext {
  path: string;
  hunks: { hunk: Hunk; similar: { comment: PastComment; score: number }[] }[];
  profiles: ReviewerProfile[];
}

export interface LlmReviewer {
  readonly name: string;
  review(ctx: ReviewContext): Promise<{ findings: ReviewFinding[]; summary: string }>;
}

export function buildPrompt(ctx: ReviewContext): string {
  const people = ctx.profiles
    .slice(0, 5)
    .map((p) => `- @${p.reviewer} (${p.comments} comments): cares about ${p.themes.map((t) => t.theme).join(", ") || "general quality"}.\n  e.g. ${p.examples.map((e) => JSON.stringify(e)).join(" | ")}`)
    .join("\n");
  const hunks = ctx.hunks
    .map(({ hunk, similar }, i) => {
      const past = similar
        .map((s) => `  • @${s.comment.reviewer} said on similar code (${s.comment.url}):\n    "${s.comment.body.slice(0, 400)}"\n    code:\n${indent(s.comment.diffHunk.split("\n").slice(-8).join("\n"), 6)}`)
        .join("\n");
      return `### Change ${i + 1} (new lines ${hunk.added[0]?.line}-${hunk.added.at(-1)?.line})\n\`\`\`diff\n${hunk.text}\`\`\`\nPast feedback on similar code:\n${past || "  (none)"}`;
    })
    .join("\n\n");

  return `You are a peer code reviewer on this team. Review the change to \`${ctx.path}\` the way these teammates would, based on what they actually said on this file before.

## Who reviews this file and what they push on
${people || "(no history)"}

## The change
${hunks}

## Rules
- Only comment where the history gives a real reason, or on clear bugs. No generic advice.
- Match the team's tone and standards; reference the past comment that inspired each point.
- Use line numbers from the new file (the + lines).
- Return ONLY JSON: {"summary": string, "findings": [{"line": number, "severity": "blocker"|"suggestion"|"nit", "comment": string, "inspiredBy": [{"reviewer": string, "url": string}]}]}`;
}

const indent = (s: string, n: number) => s.split("\n").map((l) => " ".repeat(n) + l).join("\n");

/** Claude via the Anthropic Messages API (plain fetch, no SDK needed). */
export class AnthropicReviewer implements LlmReviewer {
  readonly name: string;
  constructor(private apiKey: string, private model = process.env.REVIEW_TWIN_MODEL ?? "claude-sonnet-5-5", private f: typeof fetch = fetch) {
    this.name = model;
  }

  async review(ctx: ReviewContext) {
    const res = await this.f("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: this.model, max_tokens: 2000, messages: [{ role: "user", content: buildPrompt(ctx) }] }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { content: { type: string; text?: string }[] };
    const text = data.content.filter((c) => c.type === "text").map((c) => c.text).join("");
    return parseModelJson(text, ctx.path);
  }
}

/** Pull the JSON object out of a model reply and validate the shape. */
export function parseModelJson(text: string, path: string): { findings: ReviewFinding[]; summary: string } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Model did not return JSON");
  const raw = JSON.parse(text.slice(start, end + 1)) as { summary?: string; findings?: Partial<ReviewFinding>[] };
  const sev = new Set(["blocker", "suggestion", "nit"]);
  const findings = (raw.findings ?? [])
    .filter((f) => typeof f.line === "number" && typeof f.comment === "string")
    .map<ReviewFinding>((f) => ({
      path,
      line: f.line!,
      severity: sev.has(f.severity as string) ? (f.severity as ReviewFinding["severity"]) : "suggestion",
      comment: f.comment!,
      inspiredBy: Array.isArray(f.inspiredBy) ? f.inspiredBy.slice(0, 3) : [],
    }));
  return { findings, summary: raw.summary ?? "" };
}

/**
 * No-API-key mode: surfaces the most relevant past comment for each changed region
 * as a "your reviewers said this about similar code" reminder. Useful offline and in CI.
 */
export class HistoryOnlyReviewer implements LlmReviewer {
  readonly name = "history-only (no LLM)";
  async review(ctx: ReviewContext) {
    const findings: ReviewFinding[] = [];
    for (const { hunk, similar } of ctx.hunks) {
      const best = similar[0];
      if (!best || best.score < 0.15) continue;
      findings.push({
        path: ctx.path,
        line: hunk.added[0].line,
        severity: "suggestion",
        comment: `@${best.comment.reviewer} raised this on similar code before: "${best.comment.body.slice(0, 280)}" Check whether it applies here.`,
        inspiredBy: similar.slice(0, 2).map((s) => ({ reviewer: s.comment.reviewer, url: s.comment.url })),
      });
    }
    return { findings, summary: `Matched ${findings.length} changed region(s) to past feedback on this file.` };
  }
}
