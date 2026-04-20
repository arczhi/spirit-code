import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../shared/config.js";
import { getProjectId, triggerPipeline } from "../../shared/gitlab-api.js";

export function registerRunCi(server: McpServer, config: Config) {
  server.tool(
    "run_ci",
    "Trigger a GitLab CI pipeline on a branch",
    {
      projectPath: z.string().describe("GitLab project path (e.g. group/subgroup/project)"),
      ref: z.string().describe("Branch or tag to run pipeline on"),
    },
    async (params) => {
      try {
        const projectId = await getProjectId(config.gitlab.url, config.gitlab.token, params.projectPath);
        const pipeline = await triggerPipeline(config.gitlab.url, config.gitlab.token, projectId, params.ref);
        return { content: [{ type: "text", text: `Pipeline #${pipeline.id} triggered on '${params.ref}'\nStatus: ${pipeline.status}\nURL: ${pipeline.web_url}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed to trigger pipeline: ${err}` }] };
      }
    },
  );
}
