import { loadConfig } from './shared/config.js';
import { createEsClient } from './shared/es-client.js';
import { getProjectId } from './shared/gitlab-api.js';
import { initDb, listIncidents } from './shared/incident-store.js';
import { logger } from './shared/logger.js';

async function main() {
  const c = loadConfig();
  logger.info('=== Spirit 精灵 Smoke Test ===');

  // 1. Config check
  for (const env of c.environments) {
    logger.info(`ENV: ${env.name} | ES: ${env.elasticsearch.url} | DBs: ${env.databases.length} | CodeRoots: ${env.codeRoots.length} | LogFiles: ${env.logFiles.length}`);
    for (const db of env.databases) {
      logger.info(`  DB: ${db.name} | ${db.driverType} | ${db.host}:${db.port}/${db.dbName} | readonly: ${db.readonly}`);
    }
    for (const cr of env.codeRoots) {
      logger.info(`  Code: ${cr.name} | ${cr.path} | branch: ${cr.defaultBranch}`);
    }
  }

  // 2. ES connection
  try {
    const client = createEsClient(c.environments[0].elasticsearch.url);
    const info = await client.info();
    logger.info(`ES: OK | version ${info.version.number}`);
  } catch (e: any) {
    logger.error(`ES: FAILED | ${e.message}`);
  }

  // 3. GitLab API
  try {
    const projectPath = c.environments[0].codeRoots[0].gitlabProjectPath;
    const id = await getProjectId(c.gitlab.url, c.gitlab.token, projectPath);
    logger.info(`GitLab: OK | project ${projectPath} = ID ${id}`);
  } catch (e: any) {
    logger.error(`GitLab: FAILED | ${e.message}`);
  }

  // 4. SQLite
  try {
    const db = initDb(c.storage.path);
    const incidents = listIncidents(db, { limit: 5 });
    logger.info(`SQLite: OK | ${incidents.length} incidents`);
    db.close();
  } catch (e: any) {
    logger.error(`SQLite: FAILED | ${e.message}`);
  }

  logger.info('=== Smoke Test Complete ===');
}

main();
