import type { Fetch } from "../src/github.js";

/** Fake GitHub: 3 commits on src/orders.ts, 2 PRs with real-looking review comments. */
export const REPO = "acme/shop";
export const FILE = "src/orders.ts";

const comments: Record<number, any[]> = {
  41: [
    {
      id: 1, path: FILE, line: 12, original_line: 12, created_at: "2026-09-01T10:00:00Z",
      html_url: "https://github.com/acme/shop/pull/41#discussion_r1", user: { login: "priya", type: "User" },
      body: "Please handle the case where customer is null before reading customer.email, this crashed in prod last time.",
      diff_hunk: "@@ -10,3 +10,4 @@\n export function sendReceipt(order: Order) {\n+  const email = order.customer.email;\n+  mailer.send(email, render(order));",
    },
    {
      id: 2, path: FILE, line: 20, original_line: 20, created_at: "2026-09-01T10:05:00Z",
      html_url: "https://github.com/acme/shop/pull/41#discussion_r2", user: { login: "dev-bot", type: "Bot" },
      body: "Automated: coverage dropped by 0.4%", diff_hunk: "@@ -1 +1 @@",
    },
    {
      id: 3, path: "src/other.ts", line: 3, original_line: 3, created_at: "2026-09-01T10:06:00Z",
      html_url: "https://github.com/acme/shop/pull/41#discussion_r3", user: { login: "priya", type: "User" },
      body: "Different file, should be ignored by the harvester.", diff_hunk: "@@ -1 +1 @@",
    },
  ],
  57: [
    {
      id: 4, path: FILE, line: 30, original_line: 30, created_at: "2026-10-02T09:00:00Z",
      html_url: "https://github.com/acme/shop/pull/57#discussion_r4", user: { login: "marco", type: "User" },
      body: "This loops over every order item and calls the price API each time. Batch the lookups or cache prices; it is slow for large carts.",
      diff_hunk: "@@ -28,3 +28,6 @@\n export async function total(order: Order) {\n+  let sum = 0;\n+  for (const item of order.items) {\n+    sum += await priceApi.get(item.sku);\n+  }",
    },
    {
      id: 5, path: FILE, line: 31, original_line: 31, created_at: "2026-10-02T09:01:00Z",
      html_url: "https://github.com/acme/shop/pull/57#discussion_r5", user: { login: "priya", type: "User" },
      body: "lgtm", diff_hunk: "@@ -1 +1 @@",
    },
  ],
};

export function fakeGitHub(calls: string[] = []): Fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname === `/repos/${REPO}/commits`) return json([{ sha: "c1" }, { sha: "c2" }, { sha: "c3" }]);
    const pulls = /\/commits\/(c\d)\/pulls$/.exec(url.pathname);
    if (pulls) return json(pulls[1] === "c3" ? [{ number: 57 }] : [{ number: 41 }]);
    const pr = /\/pulls\/(\d+)\/comments$/.exec(url.pathname);
    if (pr) return json(url.searchParams.get("page") === "1" ? comments[Number(pr[1])] ?? [] : []);
    return new Response("not found", { status: 404 });
  }) as Fetch;
}

/** A new change that repeats both mistakes the reviewers flagged before. */
export const NEW_DIFF = `diff --git a/${FILE} b/${FILE}
--- a/${FILE}
+++ b/${FILE}
@@ -40,2 +40,6 @@ export function refund(order: Order) {
 export function notifyRefund(order: Order) {
+  const email = order.customer.email;
+  mailer.send(email, renderRefund(order));
+}
@@ -60,2 +64,7 @@
 export async function refundTotal(order: Order) {
+  let sum = 0;
+  for (const item of order.items) {
+    sum += await priceApi.get(item.sku);
+  }
+  return sum;
`;
