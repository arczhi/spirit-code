import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../shared/config.js";
import { initDb } from "../shared/incident-store.js";
import { logger } from "../shared/logger.js";

import { registerSearchLogs } from "./tools/search-logs.js";
import { registerReadFile } from "./tools/read-file.js";
import { registerSearchCode } from "./tools/search-code.js";
import { registerListFiles } from "./tools/list-files.js";
import { registerQueryDatabase } from "./tools/query-database.js";
import { registerListIncidents } from "./tools/list-incidents.js";
import { registerGetIncident } from "./tools/get-incident.js";
import { registerAckIncident } from "./tools/ack-incident.js";
import { registerResolveIncident } from "./tools/resolve-incident.js";
import { registerCreateBranch } from "./tools/create-branch.js";
import { registerManageWorktree } from "./tools/manage-worktree.js";
import { registerApplyPatch } from "./tools/apply-patch.js";
import { registerCommitChanges } from "./tools/commit-changes.js";
import { registerPushBranch } from "./tools/push-branch.js";
import { registerCreateMr } from "./tools/create-mr.js";
import { registerGetMrStatus } from "./tools/get-mr-status.js";
import { registerRunCi } from "./tools/run-ci.js";
import { registerGetCiStatus } from "./tools/get-ci-status.js";

const config = loadConfig();
const db = initDb(config.storage.path);

const server = new McpServer({
  name: "spirit",
  version: "0.1.0",
});

// Read tools
registerSearchLogs(server, config);
registerReadFile(server, config);
registerSearchCode(server, config);
registerListFiles(server, config);
registerQueryDatabase(server, config);

// Incident tools
registerListIncidents(server, db);
registerGetIncident(server, db);
registerAckIncident(server, db);
registerResolveIncident(server, db);

// Git execution tools
registerCreateBranch(server, config);
registerManageWorktree(server, config);
registerApplyPatch(server);
registerCommitChanges(server);
registerPushBranch(server);
registerCreateMr(server, config);
registerGetMrStatus(server, config);

// CI tools
registerRunCi(server, config);
registerGetCiStatus(server, config);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("Spirit MCP Server started (stdio)");
}

main().catch((err) => {
  logger.error("Failed to start Spirit MCP Server", err);
  process.exit(1);
});
