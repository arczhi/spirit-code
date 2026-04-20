import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../shared/config.js";
import { getProjectId, getMergeRequestStatus } from "../../shared/gitlab-api.js";

export function registerGetMrStatus(server: McpServer, config: Config) {
  server.tool(
    "get_mr_status",
    "Get the status of a GitLab Merge Request",
    {
      projectPath: z.string().describe("GitLab project path"),
      mrIid: z.number().describe("MR internal ID (iid)"),
    },
    async (params) => {
      try {
        const projectId = await getProjectId(config.gitlab.url, config.gitlab.token, params.projectPath);
        const mr = await getMergeRequestStatus(config.gitlab.url, config.gitlab.token, projectId, params.mrIid);
        return { content: [{ type: "text", text: `MR !${mr.iid}: ${mr.state} | ${mr.merge_status}\nTitle: ${mr.title}\nURL: ${mr.web_url}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed to get MR status: ${err}` }] };
      }
    },
  );
}
