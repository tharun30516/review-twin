import { GitHub } from "./github.js";
import { AnthropicReviewer, HistoryOnlyReviewer, type LlmReviewer } from "./llm.js";
import { CommentStore } from "./store.js";

/** Build dependencies from environment variables (12-factor style). */
export function depsFromEnv() {
  const gh = new GitHub({ token: process.env.GITHUB_TOKEN });
  const store = new CommentStore(process.env.REVIEW_TWIN_DB ?? ".review-twin.db");
  const llm: LlmReviewer = process.env.ANTHROPIC_API_KEY
    ? new AnthropicReviewer(process.env.ANTHROPIC_API_KEY)
    : new HistoryOnlyReviewer();
  return { gh, store, llm };
}
