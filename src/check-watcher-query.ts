import { createEsClient, searchErrors } from './shared/es-client.js';
import { loadConfig } from './shared/config.js';
import { logger } from './shared/logger.js';

async function main() {
  const config = loadConfig();

  for (const env of config.environments) {
    const client = createEsClient(env.elasticsearch.url);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // last 24h

    logger.info(`=== ${env.name} | query: ${env.elasticsearch.errorQuery} | since: ${since} ===`);

    const hits = await searchErrors({
      client,
      indices: env.elasticsearch.indices,
      errorQuery: env.elasticsearch.errorQuery,
      since,
      size: 10,
    });

    logger.info(`Found ${hits.length} errors`);
    for (const h of hits) {
      const s = h.source;
      logger.info(`  [${s['@timestamp']}] ${String(s.message ?? '').slice(0, 180)}`);
    }
  }
}

main();
