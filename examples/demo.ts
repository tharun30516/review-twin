/** Offline demo with a fake GitHub history: `npm run demo` */
import { GitHub } from "../src/github.js";
import { HistoryOnlyReviewer } from "../src/llm.js";
import { buildProfiles } from "../src/profile.js";
import { reviewChange } from "../src/review.js";
import { CommentStore } from "../src/store.js";
import { FILE, NEW_DIFF, REPO, fakeGitHub } from "../test/fixtures.js";

const store = new CommentStore();
const r = await reviewChange({ gh: new GitHub({ fetch: fakeGitHub() }), store, llm: new HistoryOnlyReviewer() }, { repo: REPO, path: FILE, diff: NEW_DIFF });

console.log(`review-twin · ${r.path} · ${r.historyUsed} past comments · reviewers: ${r.reviewers.map((x) => "@" + x).join(", ")}\n`);
for (const p of buildProfiles(store.forFile(REPO, FILE))) console.log(`  @${p.reviewer} pushes on: ${p.themes.map((t) => t.theme).join(", ")}`);
console.log(`\n${r.summary}\n`);
for (const f of r.findings) {
  console.log(`  L${f.line} [${f.severity}] ${f.comment}`);
  for (const i of f.inspiredBy) console.log(`        ↳ @${i.reviewer} ${i.url}`);
}
