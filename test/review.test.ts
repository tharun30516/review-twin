import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDiff } from "../src/diff.js";
import { GitHub } from "../src/github.js";
import { harvestComments } from "../src/harvest.js";
import { HistoryOnlyReviewer, parseModelJson, buildPrompt, type LlmReviewer } from "../src/llm.js";
import { buildProfiles } from "../src/profile.js";
import { JobQueue } from "../src/queue.js";
import { TfIdfRetriever, tokenize } from "../src/retrieve.js";
import { reviewChange } from "../src/review.js";
import { CommentStore } from "../src/store.js";
import { FILE, NEW_DIFF, REPO, fakeGitHub } from "./fixtures.js";

test("parseDiff maps added lines to new-file line numbers", () => {
  const hunks = parseDiff(NEW_DIFF, FILE);
  assert.equal(hunks.length, 2);
  assert.deepEqual(hunks[0].added.map((a) => a.line), [41, 42, 43]);
  assert.equal(hunks[1].added[0].line, 65);
});

test("tokenize splits camelCase and snake_case", () => {
  assert.deepEqual(tokenize("priceApi.get(item_sku)"), ["price", "api", "get", "item", "sku"]);
});

test("harvest keeps only human comments on the file, skips bots, other files and 'lgtm'", async () => {
  const gh = new GitHub({ fetch: fakeGitHub() });
  const { comments, prs } = await harvestComments(gh, { repo: REPO, path: FILE });
  assert.deepEqual(prs.sort(), [41, 57]);
  assert.deepEqual(comments.map((c) => c.id).sort(), [1, 4]);
});

test("incremental sync does not refetch known PRs", async () => {
  const calls: string[] = [];
  const store = new CommentStore();
  const gh = new GitHub({ fetch: fakeGitHub(calls) });
  const first = await harvestComments(gh, { repo: REPO, path: FILE });
  store.upsert(first.comments, first.prs, REPO, FILE);
  calls.length = 0;
  const second = await harvestComments(gh, { repo: REPO, path: FILE, knownPrs: store.knownPrs(REPO, FILE) });
  assert.equal(second.prs.length, 0);
  assert.ok(!calls.some((c) => c.includes("/comments")), "no PR comment calls on second sync");
});

test("retrieval matches each new hunk to the right past comment", async () => {
  const gh = new GitHub({ fetch: fakeGitHub() });
  const { comments } = await harvestComments(gh, { repo: REPO, path: FILE });
  const r = new TfIdfRetriever(comments);
  const [nullHunk, loopHunk] = parseDiff(NEW_DIFF, FILE);
  assert.equal(r.topK(nullHunk, 1)[0].comment.reviewer, "priya");
  assert.equal(r.topK(loopHunk, 1)[0].comment.reviewer, "marco");
});

test("profiles capture what each reviewer pushes on", async () => {
  const gh = new GitHub({ fetch: fakeGitHub() });
  const { comments } = await harvestComments(gh, { repo: REPO, path: FILE });
  const p = Object.fromEntries(buildProfiles(comments).map((x) => [x.reviewer, x.themes.map((t) => t.theme)]));
  assert.ok(p.priya.includes("null / error handling"));
  assert.ok(p.marco.includes("performance"));
});

test("end to end (history-only): flags both repeated mistakes on the right lines", async () => {
  const res = await reviewChange(
    { gh: new GitHub({ fetch: fakeGitHub() }), store: new CommentStore(), llm: new HistoryOnlyReviewer() },
    { repo: REPO, path: FILE, diff: NEW_DIFF },
  );
  assert.equal(res.historyUsed, 2);
  assert.deepEqual(res.findings.map((f) => f.line), [41, 65]);
  assert.match(res.findings[0].comment, /customer is null/);
  assert.match(res.findings[1].comment, /Batch the lookups/);
});

test("LLM findings on lines that were not added are dropped", async () => {
  const fake: LlmReviewer = {
    name: "fake",
    review: async (ctx) => {
      assert.match(buildPrompt(ctx), /@priya/);
      return parseModelJson(
        'Sure! {"summary":"two issues","findings":[{"line":41,"severity":"blocker","comment":"null check"},{"line":999,"severity":"nit","comment":"x"}]}',
        ctx.path,
      );
    },
  };
  const res = await reviewChange({ gh: new GitHub({ fetch: fakeGitHub() }), store: new CommentStore(), llm: fake }, { repo: REPO, path: FILE, diff: NEW_DIFF });
  assert.deepEqual(res.findings.map((f) => [f.line, f.severity]), [[41, "blocker"]]);
});

test("GitHub client retries 5xx then succeeds", async () => {
  let n = 0;
  const gh = new GitHub({
    maxRetries: 3,
    fetch: (async () => (++n < 3 ? new Response("boom", { status: 502 }) : new Response("[]", { status: 200 }))) as any,
  });
  assert.deepEqual(await gh.get("/x"), []);
  assert.equal(n, 3);
});

test("job queue respects concurrency", async () => {
  let live = 0, peak = 0;
  const q = new JobQueue<number, number>(async (x) => {
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 10));
    live--;
    return x * 2;
  }, 2);
  const jobs = [1, 2, 3, 4, 5].map((x) => q.submit(x));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(peak, 2);
  assert.deepEqual(jobs.map((j) => q.get(j.id)!.result), [2, 4, 6, 8, 10]);
});
