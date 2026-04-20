import { createEsClient } from './shared/es-client.js';

async function main() {
  const client = createEsClient('http://localhost:19200');

  // Search for ERROR/FATAL with different field patterns
  const queries = [
    { name: 'level:ERROR', query: { term: { level: 'ERROR' } } },
    { name: 'level:error', query: { term: { level: 'error' } } },
    { name: 'level keyword ERROR', query: { term: { 'level.keyword': 'ERROR' } } },
    { name: 'message contains ERROR', query: { match: { message: 'ERROR' } } },
    { name: 'message contains error', query: { match: { message: 'error' } } },
    { name: 'wildcard *ERROR*', query: { query_string: { query: '*ERROR*' } } },
  ];

  for (const q of queries) {
    try {
      const res = await client.search({
        index: 'debugpilot-prod-*',
        size: 0,
        query: q.query as any,
      });
      const total = (res.hits.total as any)?.value ?? res.hits.total;
      console.log(`${q.name}: ${total} hits`);
    } catch (e: any) {
      console.log(`${q.name}: FAILED - ${e.message}`);
    }
  }

  // Get a sample doc to see field structure
  console.log('\n=== Sample doc field structure ===');
  const sample = await client.search({
    index: 'debugpilot-prod-web-2026.04.16',
    size: 1,
  });
  if (sample.hits.hits.length > 0) {
    const s = sample.hits.hits[0]._source as any;
    console.log('Fields:', Object.keys(s).join(', '));
    console.log('level value:', JSON.stringify(s.level));
    console.log('Sample message:', String(s.message).slice(0, 200));
  }

  // Search for [ERROR] or [WARN] in message text
  console.log('\n=== Search [ERROR] in message ===');
  const errRes = await client.search({
    index: 'debugpilot-prod-*',
    size: 5,
    sort: [{ '@timestamp': { order: 'desc' } }],
    query: { match_phrase: { message: '[ERROR]' } },
  });
  const errTotal = (errRes.hits.total as any)?.value ?? errRes.hits.total;
  console.log(`[ERROR] in message: ${errTotal} hits`);
  for (const hit of errRes.hits.hits) {
    const s = hit._source as any;
    console.log(`  [${s['@timestamp']}] ${String(s.message).slice(0, 200)}`);
  }

  // Also check WARN
  console.log('\n=== Search [WARN] in message ===');
  const warnRes = await client.search({
    index: 'debugpilot-prod-*',
    size: 3,
    sort: [{ '@timestamp': { order: 'desc' } }],
    query: { match_phrase: { message: '[WARN]' } },
  });
  const warnTotal = (warnRes.hits.total as any)?.value ?? warnRes.hits.total;
  console.log(`[WARN] in message: ${warnTotal} hits`);
  for (const hit of warnRes.hits.hits) {
    const s = hit._source as any;
    console.log(`  [${s['@timestamp']}] ${String(s.message).slice(0, 200)}`);
  }
}

main();
