import { z } from "zod";
import { resolve, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../shared/config.js";
import * as gitOps from "../../shared/git-ops.js";

export function registerManageWorktree(server: McpServer, _config: Config) {
  server.tool(
    "manage_worktree",
    "Create or remove a git worktree for isolated development",
    {
      repoPath: z.string().describe("Path to the main git repository"),
      action: z.enum(["create", "remove"]).describe("Action: create or remove"),
      branchName: z.string().describe("Branch name for the worktree"),
      worktreePath: z.string().optional().describe("Custom worktree path (auto-generated if omitted)"),
    },
    async (params) => {
      const wtPath = params.worktreePath ?? join(resolve(params.repoPath), ".worktrees", "spirit", params.branchName);

      try {
        if (params.action === "create") {
          await gitOps.createWorktree(params.repoPath, wtPath, params.branchName);
          return { content: [{ type: "text", text: `Worktree created at ${wtPath} on branch '${params.branchName}'` }] };
        } else {
          await gitOps.removeWorktree(params.repoPath, wtPath);
          return { content: [{ type: "text", text: `Worktree removed: ${wtPath}` }] };
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Worktree ${params.action} failed: ${err}` }] };
      }
    },
  );
}
