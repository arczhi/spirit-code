import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../shared/config.js";
import * as gitOps from "../../shared/git-ops.js";

export function registerCreateBranch(server: McpServer, _config: Config) {
  server.tool(
    "create_branch",
    "Create a new git branch from a base branch in a repository",
    {
      repoPath: z.string().describe("Path to the git repository"),
      branchName: z.string().describe("Name for the new branch"),
      baseBranch: z.string().optional().describe("Base branch to create from (default: current branch)"),
    },
    async (params) => {
      try {
        await gitOps.createBranch(params.repoPath, params.branchName, params.baseBranch);
        return { content: [{ type: "text", text: `Branch '${params.branchName}' created in ${params.repoPath}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed to create branch: ${err}` }] };
      }
    },
  );
}
