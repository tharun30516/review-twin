#!/usr/bin/env -S npx tsx
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { depsFromEnv } from "./config.js";
import { harvestComments } from "./harvest.js";
import { buildProfiles } from "./profile.js";
import { postReview, reviewChange } from "./review.js";
import type { ReviewResult } from "./types.js";

const HELP = `review-twin: an AI peer reviewer trained on your team's past comments

Usage
  review-twin learn  --repo owner/name --file path/to/file.ts [--commits 50]
  review-twin review --repo owner/name --file path/to/file.ts [--diff change.patch | --pr 123] [--post] [--json]

Env
  GITHUB_TOKEN        read access (and write, for --post)
  ANTHROPIC_API_KEY   optional; without it, review-twin runs in history-only mode
  REVIEW_TWIN_DB      SQLite file for the comment history (default .review-twin.db)
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: "string" },
    file: { type: "string" },
    diff: { type: "string" },
    pr: { type: "string" },
    commits: { type: "string", default: "50" },
    author: { type: "string" },
    post: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});

const cmd = positionals[0];
if (values.help || !cmd || !values.repo || !values.file) {
  console.log(HELP);
  process.exit(cmd ? 1 : 0);
}

const deps = depsFromEnv();
const repo = values.repo!;
const path = values.file!;
const commits = Number(values.commits);

if (cmd === "learn") {
  const { comments, prs } = await harvestComments(deps.gh, { repo, path, commits, knownPrs: deps.store.knownPrs(repo, path) });
  deps.store.upsert(comments, prs, repo, path);
  const all = deps.store.forFile(repo, path);
  console.log(`Learned ${comments.length} new comments from ${prs.length} PRs (total ${all.length}).\n`);
  for (const p of buildProfiles(all).slice(0, 8)) {
    console.log(`@${p.reviewer}: ${p.comments} comments · ${p.themes.map((t) => `${t.theme} (${t.count})`).join(", ") || "general"}`);
  }
} else if (cmd === "review") {
  let diff: string;
  let pr: { number: number; head: { sha: string }; user: { login: string } } | undefined;
  if (values.pr) {
    pr = await deps.gh.get(`/repos/${repo}/pulls/${values.pr}`);
    const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${values.pr}`, {
      headers: { accept: "application/vnd.github.diff", "user-agent": "review-twin", ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) },
    });
    if (!res.ok) throw new Error(`Could not fetch PR diff: ${res.status}`);
    diff = await res.text();
  } else if (values.diff) {
    diff = await readFile(values.diff, "utf8");
  } else {
    diff = execFileSync("git", ["diff", "HEAD", "--", path], { encoding: "utf8" }); // local uncommitted change
  }

  const result = await reviewChange(deps, { repo, path, diff, commits, author: values.author ?? pr?.user.login });
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else print(result);

  if (values.post) {
    if (!pr) throw new Error("--post needs --pr");
    await postReview(deps.gh, repo, pr.number, pr.head.sha, result);
    console.log(`\nPosted ${result.findings.length} comments to PR #${pr.number}.`);
  }
} else {
  console.log(HELP);
  process.exit(1);
}
deps.store.close();

function print(r: ReviewResult) {
  console.log(`review-twin · ${r.path} · ${r.historyUsed} past comments from ${r.reviewers.length} reviewers · ${r.model}\n`);
  console.log(r.summary + "\n");
  for (const f of r.findings) {
    console.log(`  L${f.line} [${f.severity}] ${f.comment}`);
    for (const i of f.inspiredBy) console.log(`        ↳ @${i.reviewer} ${i.url}`);
  }
  if (r.findings.length === 0) console.log("  No findings.");
}
