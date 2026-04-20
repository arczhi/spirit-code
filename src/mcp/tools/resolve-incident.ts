import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { updateIncident, getIncident } from "../../shared/incident-store.js";

export function registerResolveIncident(server: McpServer, db: Database.Database) {
  server.tool(
    "resolve_incident",
    "Resolve an incident by linking it to a fix branch or merge request",
    {
      incidentId: z.string().describe("Incident ID to resolve"),
      mrUrl: z.string().optional().describe("GitLab MR URL"),
      branch: z.string().optional().describe("Fix branch name"),
    },
    async (params) => {
      const incident = getIncident(db, params.incidentId);
      if (!incident) {
        return { content: [{ type: "text", text: `Incident not found: ${params.incidentId}` }] };
      }
      const fields: Record<string, unknown> = { status: "resolved" };
      if (params.mrUrl) fields.mr_url = params.mrUrl;
      if (params.branch) fields.branch = params.branch;
      updateIncident(db, params.incidentId, fields);
      return { content: [{ type: "text", text: `Incident ${params.incidentId} resolved.${params.mrUrl ? ` MR: ${params.mrUrl}` : ""}` }] };
    },
  );
}
