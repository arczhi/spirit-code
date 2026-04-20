import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../shared/config.js";
import { getProjectId, getPipelineStatus } from "../../shared/gitlab-api.js";

export function registerGetCiStatus(server: McpServer, config: Config) {
  server.tool(
    "get_ci_status",
    "Get the status of a GitLab CI pipeline",
    {
      projectPath: z.string().describe("GitLab project path"),
      pipelineId: z.number().describe("Pipeline ID"),
    },
    async (params) => {
      try {
        const projectId = await getProjectId(config.gitlab.url, config.gitlab.token, params.projectPath);
        const pipeline = await getPipelineStatus(config.gitlab.url, config.gitlab.token, projectId, params.pipelineId);
        return { content: [{ type: "text", text: `Pipeline #${pipeline.id}: ${pipeline.status}\nRef: ${pipeline.ref}\nURL: ${pipeline.web_url}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed to get pipeline status: ${err}` }] };
      }
    },
  );
}
