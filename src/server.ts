import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { depsFromEnv } from "./config.js";
import { JobQueue } from "./queue.js";
import { reviewChange, type ReviewRequest } from "./review.js";

/**
 * HTTP API
 *   POST /reviews        {repo, path, diff, author?}  → 202 {id}
 *   GET  /reviews/:id    → {status, result?}
 *   GET  /healthz
 * Stateless apart from the job map, so it runs behind a load balancer;
 * point REVIEW_TWIN_DB at shared storage (or Postgres) for many replicas.
 */
export function createApp(deps = depsFromEnv(), concurrency = Number(process.env.REVIEW_TWIN_CONCURRENCY ?? 4)) {
  const queue = new JobQueue<ReviewRequest, Awaited<ReturnType<typeof reviewChange>>>((req) => reviewChange(deps, req), concurrency);

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true, ...queue.stats() });

      if (req.method === "POST" && url.pathname === "/reviews") {
        const body = await readJson(req, 1_000_000);
        for (const k of ["repo", "path", "diff"] as const) {
          if (typeof body[k] !== "string" || !body[k]) return send(res, 400, { error: `"${k}" is required` });
        }
        if (!/^[\w.-]+\/[\w.-]+$/.test(body.repo)) return send(res, 400, { error: "repo must look like owner/name" });
        const job = queue.submit({ repo: body.repo, path: body.path, diff: body.diff, author: body.author, commits: body.commits });
        return send(res, 202, { id: job.id, status: job.status, poll: `/reviews/${job.id}` });
      }

      const m = /^\/reviews\/([\w-]+)$/.exec(url.pathname);
      if (req.method === "GET" && m) {
        const job = queue.get(m[1]);
        return job ? send(res, 200, job) : send(res, 404, { error: "not found" });
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      send(res, 400, { error: (e as Error).message });
    }
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, limit: number): Promise<Record<string, any>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8787);
  createApp().listen(port, () => console.log(`review-twin API on :${port}`));
}
