import type { GitHub } from "./github.js";
import { mapLimit } from "./limit.js";
import type { PastComment } from "./types.js";

interface GhCommit { sha: string }
interface GhPull { number: number; merged_at: string | null }
interface GhReviewComment {
  id: number;
  path: string;
  body: string;
  diff_hunk: string;
  line: number | null;
  original_line: number | null;
  created_at: string;
  html_url: string;
  user: { login: string; type: string } | null;
}

export interface HarvestOptions {
  repo: string; // owner/name
  path: string;
  commits?: number; // default 50
  concurrency?: number; // default 6
  /** Skip PRs already harvested (incremental sync). */
  knownPrs?: Set<number>;
  /** Ignore comments from these logins, e.g. the PR author or bots. */
  ignoreUsers?: string[];
}

/**
 * Collect reviewer comments left on `path` in the PRs behind its last N commits.
 *   commits?path=… (last 50) → commits/{sha}/pulls → pulls/{n}/comments filtered to the file
 */
export async function harvestComments(gh: GitHub, o: HarvestOptions): Promise<{ comments: PastComment[]; prs: number[] }> {
  const commits = await gh.list<GhCommit>(`/repos/${o.repo}/commits?path=${encodeURIComponent(o.path)}`, o.commits ?? 50);
  const conc = o.concurrency ?? 6;

  const prLists = await mapLimit(commits, conc, (c) => gh.get<GhPull[]>(`/repos/${o.repo}/commits/${c.sha}/pulls`));
  const prs = [...new Set(prLists.flat().map((p) => p.number))].filter((n) => !o.knownPrs?.has(n));

  const ignore = new Set((o.ignoreUsers ?? []).map((u) => u.toLowerCase()));
  const perPr = await mapLimit(prs, conc, async (n) => {
    const raw = await gh.list<GhReviewComment>(`/repos/${o.repo}/pulls/${n}/comments`, 500);
    return raw
      .filter((c) => c.path === o.path && c.user && c.user.type !== "Bot" && !ignore.has(c.user.login.toLowerCase()))
      .filter((c) => c.body.trim().length >= 8) // drop "lgtm", "+1"
      .map<PastComment>((c) => ({
        id: c.id,
        repo: o.repo,
        path: c.path,
        prNumber: n,
        reviewer: c.user!.login,
        body: c.body.trim(),
        diffHunk: c.diff_hunk,
        line: c.line ?? c.original_line,
        createdAt: c.created_at,
        url: c.html_url,
      }));
  });
  return { comments: perPr.flat(), prs };
}
