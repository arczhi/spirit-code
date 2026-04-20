import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { getIncident } from "../../shared/incident-store.js";

export function registerGetIncident(server: McpServer, db: Database.Database) {
  server.tool(
    "get_incident",
    "Get full details of a specific incident including analysis and fix plan",
    {
      incidentId: z.string().describe("Incident ID"),
    },
    async (params) => {
      const incident = getIncident(db, params.incidentId);
      if (!incident) {
        return { content: [{ type: "text", text: `Incident not found: ${params.incidentId}` }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(incident, null, 2) }] };
    },
  );
}
