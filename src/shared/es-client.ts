import { Client } from "@elastic/elasticsearch";
import { logger } from "./logger.js";

export function createEsClient(url: string): Client {
  return new Client({ node: url });
}

export interface SearchLogsParams {
  client: Client;
  indices: string[];
  keyword?: string;
  level?: string;
  timeRange?: { from: string; to: string };
  size?: number;
}

export async function searchLogs(params: SearchLogsParams) {
  const { client, indices, keyword, level, timeRange, size = 50 } = params;

  const must: Record<string, unknown>[] = [];
  if (keyword) {
    must.push({ multi_match: { query: keyword, fields: ["message", "error", "stack_trace", "*"] } });
  }
  if (level) {
    must.push({ term: { level: level.toUpperCase() } });
  }
  if (timeRange) {
    must.push({ range: { "@timestamp": { gte: timeRange.from, lte: timeRange.to } } });
  }

  const body = must.length > 0
    ? { query: { bool: { must } } }
    : { query: { match_all: {} } };

  const result = await client.search({
    index: indices.join(","),
    size,
    sort: [{ "@timestamp": { order: "desc" } }],
    ...body,
  });

  return result.hits.hits.map((hit) => ({
    id: hit._id,
    index: hit._index,
    source: hit._source as Record<string, unknown>,
  }));
}

export interface SearchErrorsParams {
  client: Client;
  indices: string[];
  errorQuery: string;
  since: string; // ISO8601
  size?: number;
}

export async function searchErrors(params: SearchErrorsParams) {
  const { client, indices, errorQuery, since, size = 100 } = params;

  const result = await client.search({
    index: indices.join(","),
    size,
    sort: [{ "@timestamp": { order: "desc" } }],
    query: {
      bool: {
        must: [
          { query_string: { query: errorQuery } },
          { range: { "@timestamp": { gte: since } } },
        ],
      },
    },
  });

  logger.debug(`ES search returned ${result.hits.hits.length} errors since ${since}`);

  return result.hits.hits.map((hit) => ({
    id: hit._id,
    index: hit._index,
    source: hit._source as Record<string, unknown>,
  }));
}
