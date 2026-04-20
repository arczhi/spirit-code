import { z } from "zod";
import mysql from "mysql2/promise";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../shared/config.js";

export function registerQueryDatabase(server: McpServer, config: Config) {
  // Build a flat list of all configured databases for the description
  const allDbs = config.environments.flatMap((e) =>
    e.databases.map((d) => `${e.name}/${d.name}`)
  );
  const dbListHint = allDbs.length > 0 ? `Configured: ${allDbs.join(", ")}` : "No databases configured";

  server.tool(
    "query_database",
    `Execute a SQL query against a database. ${dbListHint}. Use 'env' + 'dbName' to select from config, or 'connectionString' for direct connection.`,
    {
      env: z.string().optional().describe("Environment name to look up database from config"),
      dbName: z.string().optional().describe("Database connection name in config"),
      connectionString: z.string().optional().describe("Direct MySQL connection string (overrides env/dbName)"),
      sql: z.string().describe("SQL query to execute"),
      readonly: z.boolean().optional().describe("Force read-only mode (default: true for prod, from config otherwise)"),
    },
    async (params) => {
      let connStr: string;
      let isReadonly: boolean;

      if (params.connectionString) {
        connStr = params.connectionString;
        isReadonly = params.readonly ?? true;
      } else if (params.env && params.dbName) {
        const envConfig = config.environments.find((e) => e.name === params.env);
        if (!envConfig) {
          return { content: [{ type: "text", text: `Environment not found: ${params.env}. Available: ${config.environments.map((e) => e.name).join(", ")}` }] };
        }
        const dbConfig = envConfig.databases.find((d) => d.name === params.dbName);
        if (!dbConfig) {
          const available = envConfig.databases.map((d) => d.name).join(", ") || "(none)";
          return { content: [{ type: "text", text: `Database '${params.dbName}' not found in env '${params.env}'. Available: ${available}` }] };
        }
        connStr = `mysql://${dbConfig.username}:${encodeURIComponent(dbConfig.password)}@${dbConfig.host}:${dbConfig.port}/${dbConfig.dbName}`;
        isReadonly = params.readonly ?? dbConfig.readonly;
      } else {
        return { content: [{ type: "text", text: "Provide either 'env' + 'dbName' to use configured database, or 'connectionString' for direct connection." }] };
      }

      const sqlUpper = params.sql.trim().toUpperCase();
      if (isReadonly && !sqlUpper.startsWith("SELECT") && !sqlUpper.startsWith("SHOW") && !sqlUpper.startsWith("DESCRIBE") && !sqlUpper.startsWith("EXPLAIN")) {
        return { content: [{ type: "text", text: "Read-only mode: only SELECT, SHOW, DESCRIBE, EXPLAIN are allowed." }] };
      }

      let conn: mysql.Connection | null = null;
      try {
        conn = await mysql.createConnection(connStr);
        const [rows] = await conn.execute(params.sql);
        const result = Array.isArray(rows) ? rows.slice(0, 100) : rows;
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Query failed: ${err}` }] };
      } finally {
        if (conn) await conn.end();
      }
    },
  );
}
