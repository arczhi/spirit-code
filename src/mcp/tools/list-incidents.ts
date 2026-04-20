import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { listIncidents } from "../../shared/incident-store.js";

export function registerListIncidents(server: McpServer, db: Database.Database) {
  server.tool(
    "list_incidents",
    "List recent incidents from the Spirit incident store",
    {
      env: z.string().optional().describe("Filter by environment (production, testing)"),
      status: z.string().optional().describe("Filter by status (open, ack, fixing, resolved, wontfix)"),
      limit: z.number().optional().describe("Max results (default 50)"),
    },
    async (params) => {
      const incidents = listIncidents(db, { env: params.env, status: params.status, limit: params.limit });
      if (incidents.length === 0) {
        return { content: [{ type: "text", text: "No incidents found." }] };
      }
      const lines = incidents.map((i) =>
        `[${i.status}] ${i.id.slice(0, 8)} | ${i.env}/${i.service} | ${i.level} | ${i.title} | count:${i.count} | ${i.last_seen}`
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );
}
