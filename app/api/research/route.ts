import { runResearch } from "../../../lib/agent/research-agent";
import { createResearchModel } from "../../../lib/providers/research-model";
import { createResearchRoute } from "../../../lib/server/research-route";
import { extractSources, searchWeb } from "../../../lib/tools/tavily";

export const maxDuration = 300;

export const POST = createResearchRoute({
  createModel: createResearchModel,
  runResearch,
  searchWeb,
  extractSources,
});
