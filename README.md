# review-twin

**An AI peer reviewer that learns from your teammates.** It reads every review comment left on a file in the PRs behind its **last 50 commits**, learns what each reviewer cares about, and reviews your new change the way they would, citing the past comment behind every point.

Generic AI reviewers give generic advice. Your team already wrote down its standards, one PR comment at a time. review-twin turns that history into a reviewer that knows *"Priya always asks for null checks on `customer`"* and *"Marco flags API calls inside loops in this file."*

```
review-twin · src/orders.ts · 2 past comments · reviewers: @marco, @priya

  @marco pushes on: performance
  @priya pushes on: null / error handling

  L41 [suggestion] @priya raised this on similar code before: "Please handle the case where customer is null
      before reading customer.email, this crashed in prod last time." Check whether it applies here.
        ↳ @priya https://github.com/acme/shop/pull/41#discussion_r1
  L65 [suggestion] @marco raised this on similar code before: "This loops over every order item and calls the
      price API each time. Batch the lookups or cache prices; it is slow for large carts."
        ↳ @marco https://github.com/acme/shop/pull/57#discussion_r4
```
*(real output of `npm run demo`, offline mode)*

## How it works

```
 file path ──► last 50 commits ──► PRs behind them ──► review comments on that file
                (GitHub API, ETag cache, rate-limit aware, 6-way concurrency)
                                        │
                              SQLite knowledge base  (incremental: only new PRs are fetched)
                                        │
          ┌─────────────────────────────┼──────────────────────────────┐
   reviewer profiles             TF-IDF retrieval                  your diff
   (who reviews, what            (past comments whose code         (parsed into hunks
    themes they push on)          looks like each new hunk)         with new-file line numbers)
          └─────────────────────────────┼──────────────────────────────┘
                                        ▼
                     Claude writes grounded findings  ──►  CLI / JSON / inline PR review
                     (or history-only mode with no API key)
```

1. **Harvest.** `commits?path=…` → `commits/{sha}/pulls` → `pulls/{n}/comments`, filtered to the file. Bots, other files, the PR author's own replies and one-word comments ("lgtm", "+1") are dropped.
2. **Learn.** Comments are stored per `(repo, file)`. Reviewer profiles group them by person and theme (null handling, tests, naming, performance, security, async, API design…).
3. **Retrieve.** Each changed hunk is matched to the most similar past comments using code-aware TF-IDF (splits `camelCase` / `snake_case`).
4. **Review.** Claude gets the diff, the profiles and the matching past comments, and returns structured findings. Findings on lines you didn't add are discarded, so every comment can be posted inline.

## Quick start

```bash
npm install
npm test          # 10 tests: diff parsing, harvesting, incremental sync, retrieval, end-to-end, retries, queue
npm run demo      # offline demo with a fake repo history

export GITHUB_TOKEN=ghp_...            # read access
export ANTHROPIC_API_KEY=sk-ant-...    # optional; without it: history-only mode

npx tsx src/cli.ts learn  --repo owner/name --file src/orders.ts
npx tsx src/cli.ts review --repo owner/name --file src/orders.ts               # your local uncommitted change
npx tsx src/cli.ts review --repo owner/name --file src/orders.ts --pr 123 --post  # inline comments on a PR
```

### On every PR (GitHub Action)

Copy [`examples/review-twin-action.yml`](examples/review-twin-action.yml) into `.github/workflows/`. It reviews each changed file and posts a single **COMMENT** review. It never approves or blocks; humans stay in charge.

### As a service

```bash
npx tsx src/server.ts     # or: docker build -t review-twin . && docker run -p 8787:8787 review-twin
curl -X POST localhost:8787/reviews -d '{"repo":"owner/name","path":"src/orders.ts","diff":"..."}'
# → 202 {"id":"…","poll":"/reviews/…"}
curl localhost:8787/reviews/<id>
```

## Built to scale

| Concern | Approach |
|---|---|
| GitHub rate limits | ETag conditional requests (304s are free), waits for `x-ratelimit-reset`, exponential backoff on 5xx/secondary limits |
| Fan-out (50 commits → N PRs) | Bounded concurrency (`mapLimit`), PRs de-duplicated across commits |
| Repeat reviews | Incremental sync: PRs already learned are skipped, so the 2nd review of a file makes 2 API calls instead of 50+ |
| Slow LLM calls | `POST /reviews` returns `202` + job id; a worker pool with a concurrency cap processes jobs. Same interface fits BullMQ/Redis for many pods |
| Storage | SQLite with WAL, indexed by `(repo, path)`; the `CommentStore` interface is small enough to move to Postgres + pgvector |
| Retrieval quality | `Retriever` interface: TF-IDF today, embeddings + vector DB as a drop-in later |
| Safety | Never approves or requests changes; body-size limits; input validation; findings must reference added lines |

## Project layout

```
src/github.ts    REST client: pagination, ETag cache, rate limits, retries
src/harvest.ts   last-N-commits → PRs → file comments
src/store.ts     SQLite knowledge base with incremental sync
src/diff.ts      unified diff → hunks with new-file line numbers
src/retrieve.ts  code-aware TF-IDF retriever
src/profile.ts   per-reviewer themes
src/llm.ts       prompt, Claude client, JSON parsing, history-only fallback
src/review.ts    pipeline + posting inline PR reviews
src/queue.ts     concurrency-capped job queue
src/server.ts    HTTP API      src/cli.ts   CLI
```

## License

MIT
