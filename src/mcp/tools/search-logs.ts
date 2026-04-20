import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../shared/config.js";
import { createEsClient, searchLogs } from "../../shared/es-client.js";

export function registerSearchLogs(server: McpServer, config: Config) {
  server.tool(
    "search_logs",
    "Search Elasticsearch logs by keyword, level, and time range",
    {
      env: z.string().describe("Environment name (e.g. production, testing)"),
      keyword: z.string().optional().describe("Search keyword"),
      level: z.string().optional().describe("Log level filter (ERROR, WARN, INFO, DEBUG)"),
      timeFrom: z.string().optional().describe("Time range start (ISO8601)"),
      timeTo: z.string().optional().describe("Time range end (ISO8601)"),
      index: z.string().optional().describe("Specific index to search (overrides env default)"),
      size: z.number().optional().describe("Max results to return (default 50)"),
    },
    async (params) => {
      const envConfig = config.environments.find((e) => e.name === params.env);
      if (!envConfig) {
        return { content: [{ type: "text", text: `Environment not found: ${params.env}` }] };
      }

      const client = createEsClient(envConfig.elasticsearch.url);
      const indices = params.index ? [params.index] : envConfig.elasticsearch.indices;
      const timeRange = params.timeFrom && params.timeTo ? { from: params.timeFrom, to: params.timeTo } : undefined;

      try {
        const hits = await searchLogs({ client, indices, keyword: params.keyword, level: params.level, timeRange, size: params.size });
        const formatted = hits.map((h) => {
          const s = h.source;
          return `[${s["@timestamp"] ?? ""}] [${s["level"] ?? ""}] ${s["message"] ?? JSON.stringify(s)}`;
        }).join("\n");
        return { content: [{ type: "text", text: hits.length === 0 ? "No logs found." : formatted }] };
      } catch (err) {
        return { content: [{ type: "text", text: `ES search failed: ${err}` }] };
      }
    },
  );
}
