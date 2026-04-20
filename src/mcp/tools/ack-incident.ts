import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { updateIncident, getIncident } from "../../shared/incident-store.js";

export function registerAckIncident(server: McpServer, db: Database.Database) {
  server.tool(
    "ack_incident",
    "Acknowledge an incident, marking it as being investigated",
    {
      incidentId: z.string().describe("Incident ID to acknowledge"),
    },
    async (params) => {
      const incident = getIncident(db, params.incidentId);
      if (!incident) {
        return { content: [{ type: "text", text: `Incident not found: ${params.incidentId}` }] };
      }
      updateIncident(db, params.incidentId, { status: "ack" });
      return { content: [{ type: "text", text: `Incident ${params.incidentId} acknowledged.` }] };
    },
  );
}
