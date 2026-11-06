import type { PastComment } from "./types.js";

/** Themes reviewers repeatedly raise. Keyword rules are cheap and explainable. */
const THEMES: Record<string, RegExp> = {
  "null / error handling": /\b(null|undefined|nil|exception|throw|try|catch|error handling|edge case)\b/i,
  "tests": /\b(test|tests|unit test|coverage|assert|mock)\b/i,
  "naming / readability": /\b(name|naming|rename|readab|clarity|confusing|unclear)\b/i,
  "performance": /\b(perf|performance|slow|allocation|O\(n|loop|cache|memo|lazy)\b/i,
  "security": /\b(secur|sanitiz|inject|xss|token|secret|auth|permission)\b/i,
  "logging / observability": /\b(log|logging|metric|telemetry|trace)\b/i,
  "async / concurrency": /\b(async|await|race|thread|lock|concurren|deadlock)\b/i,
  "API / design": /\b(interface|abstraction|coupling|single responsibility|SRP|design|pattern|extract)\b/i,
  "docs / comments": /\b(doc|docs|comment|jsdoc|xml doc|readme)\b/i,
};

export interface ReviewerProfile {
  reviewer: string;
  comments: number;
  themes: { theme: string; count: number }[];
  examples: string[];
}

/** Summarize who reviews this file and what each person tends to push on. */
export function buildProfiles(comments: PastComment[], maxExamples = 3): ReviewerProfile[] {
  const by = new Map<string, PastComment[]>();
  for (const c of comments) by.set(c.reviewer, [...(by.get(c.reviewer) ?? []), c]);
  return [...by.entries()]
    .map(([reviewer, cs]) => {
      const counts = new Map<string, number>();
      for (const c of cs) for (const [theme, re] of Object.entries(THEMES)) if (re.test(c.body)) counts.set(theme, (counts.get(theme) ?? 0) + 1);
      return {
        reviewer,
        comments: cs.length,
        themes: [...counts.entries()].map(([theme, count]) => ({ theme, count })).sort((a, b) => b.count - a.count).slice(0, 4),
        examples: cs.slice(0, maxExamples).map((c) => c.body.slice(0, 240)),
      };
    })
    .sort((a, b) => b.comments - a.comments);
}
