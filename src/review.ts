import { parseDiff } from "./diff.js";
import type { GitHub } from "./github.js";
import { harvestComments } from "./harvest.js";
import type { LlmReviewer } from "./llm.js";
import { buildProfiles } from "./profile.js";
import { TfIdfRetriever } from "./retrieve.js";
import type { CommentStore } from "./store.js";
import type { ReviewResult } from "./types.js";

export interface ReviewRequest {
  repo: string;
  path: string;
  diff: string;
  commits?: number;
  /** PR author: their own replies are not "reviewer" feedback. */
  author?: string;
  topK?: number;
}

/**
 * The full pipeline:
 *  1. sync history (incremental: only PRs not seen before hit the API)
 *  2. build reviewer profiles for the file
 *  3. retrieve past comments similar to each changed hunk
 *  4. ask the reviewer model for findings grounded in that history
 */
export async function reviewChange(
  deps: { gh: GitHub; store: CommentStore; llm: LlmReviewer },
  req: ReviewRequest,
): Promise<ReviewResult> {
  const { gh, store, llm } = deps;
  const known = store.knownPrs(req.repo, req.path);
  const fresh = await harvestComments(gh, {
    repo: req.repo,
    path: req.path,
    commits: req.commits ?? 50,
    knownPrs: known,
    ignoreUsers: req.author ? [req.author] : [],
  });
  store.upsert(fresh.comments, fresh.prs, req.repo, req.path);

  const history = store.forFile(req.repo, req.path).filter((c) => c.reviewer !== req.author);
  const profiles = buildProfiles(history);
  const retriever = new TfIdfRetriever(history);
  const hunks = parseDiff(req.diff, req.path).map((hunk) => ({ hunk, similar: retriever.topK(hunk, req.topK ?? 4) }));

  if (hunks.length === 0) {
    return { repo: req.repo, path: req.path, historyUsed: history.length, reviewers: profiles.map((p) => p.reviewer), findings: [], summary: "No added lines for this file in the diff.", model: llm.name };
  }

  const { findings, summary } = await llm.review({ path: req.path, hunks, profiles });
  const validLines = new Set(hunks.flatMap((h) => h.hunk.added.map((a) => a.line)));
  return {
    repo: req.repo,
    path: req.path,
    historyUsed: history.length,
    reviewers: profiles.map((p) => p.reviewer),
    // Only keep comments on lines that were actually added, so they can be posted inline.
    findings: findings.filter((f) => validLines.has(f.line)),
    summary,
    model: llm.name,
  };
}

/** Post findings as one PR review with inline comments (COMMENT, never APPROVE / REQUEST_CHANGES). */
export async function postReview(gh: GitHub, repo: string, pr: number, commitId: string, result: ReviewResult) {
  if (result.findings.length === 0) return;
  const icon = { blocker: "🔴", suggestion: "🟡", nit: "⚪" } as const;
  await gh.postJson(`/repos/${repo}/pulls/${pr}/reviews`, {
    commit_id: commitId,
    event: "COMMENT",
    body: `**review-twin** (learned from ${result.historyUsed} past comments by ${result.reviewers.slice(0, 5).map((r) => "@" + r).join(", ")})\n\n${result.summary}`,
    comments: result.findings.map((f) => ({
      path: f.path,
      line: f.line,
      side: "RIGHT",
      body: `${icon[f.severity]} **${f.severity}**: ${f.comment}${f.inspiredBy.length ? `\n\n_Based on: ${f.inspiredBy.map((i) => `[@${i.reviewer}](${i.url})`).join(", ")}_` : ""}`,
    })),
  });
}
