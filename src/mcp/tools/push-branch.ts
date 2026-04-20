import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as gitOps from "../../shared/git-ops.js";

export function registerPushBranch(server: McpServer) {
  server.tool(
    "push_branch",
    "Push the current branch in a worktree to remote",
    {
      worktreePath: z.string().describe("Path to the git worktree"),
      remote: z.string().optional().describe("Remote name (default: origin)"),
    },
    async (params) => {
      try {
        await gitOps.pushBranch(params.worktreePath, params.remote);
        const branch = await gitOps.getCurrentBranch(params.worktreePath);
        return { content: [{ type: "text", text: `Pushed branch '${branch}' to ${params.remote ?? "origin"}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Push failed: ${err}` }] };
      }
    },
  );
}
