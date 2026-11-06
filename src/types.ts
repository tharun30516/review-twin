/** A review comment a teammate left on a pull request that touched the file. */
export interface PastComment {
  id: number;
  repo: string; // "owner/name"
  path: string;
  prNumber: number;
  reviewer: string;
  body: string;
  /** The diff hunk the comment was attached to (code context). */
  diffHunk: string;
  line: number | null;
  createdAt: string;
  url: string;
}

/** One comment the twin wants to leave on the new change. */
export interface ReviewFinding {
  path: string;
  line: number;
  severity: "blocker" | "suggestion" | "nit";
  comment: string;
  /** Past comments that motivated this finding, so humans can check the reasoning. */
  inspiredBy: { reviewer: string; url: string }[];
}

export interface ReviewResult {
  repo: string;
  path: string;
  historyUsed: number;
  reviewers: string[];
  findings: ReviewFinding[];
  summary: string;
  model: string;
}
