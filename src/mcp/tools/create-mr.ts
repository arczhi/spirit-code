import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../shared/config.js";
import { getProjectId, createMergeRequest } from "../../shared/gitlab-api.js";

export function registerCreateMr(server: McpServer, config: Config) {
  server.tool(
    "create_mr",
    "Create a GitLab Merge Request",
    {
      projectPath: z.string().describe("GitLab project path (e.g. group/subgroup/project)"),
      sourceBranch: z.string().describe("Source branch name"),
      targetBranch: z.string().optional().describe("Target branch (default from config)"),
      title: z.string().describe("MR title"),
      description: z.string().describe("MR description (markdown)"),
    },
    async (params) => {
      try {
        const projectId = await getProjectId(config.gitlab.url, config.gitlab.token, params.projectPath);
        const mr = await createMergeRequest({
          gitlabUrl: config.gitlab.url,
          token: config.gitlab.token,
          projectId,
          sourceBranch: params.sourceBranch,
          targetBranch: params.targetBranch ?? config.gitlab.defaultTargetBranch,
          title: params.title,
          description: params.description,
        });
        return { content: [{ type: "text", text: `MR created: !${mr.iid}\nURL: ${mr.web_url}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed to create MR: ${err}` }] };
      }
    },
  );
}
