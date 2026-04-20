import { createEsClient } from './shared/es-client.js';

async function main() {
  const client = createEsClient('http://localhost:19200');

  // 1. List all indices
  const indices = await client.cat.indices({ format: 'json' }) as any[];
  console.log('=== All ES Indices ===');
  for (const idx of indices.sort((a: any, b: any) => a.index.localeCompare(b.index))) {
    console.log(`  ${idx.index} (${idx['docs.count']} docs)`);
  }

  // 2. Search for any logs in debugpilot-*
  console.log('\n=== Recent logs in debugpilot-* ===');
  try {
    const res = await client.search({
      index: 'debugpilot-*',
      size: 5,
      sort: [{ '@timestamp': { order: 'desc' } }],
      query: { match_all: {} }
    });
    const total = (res.hits.total as any)?.value ?? res.hits.total;
    console.log(`Total hits: ${total}`);
    for (const hit of res.hits.hits) {
      const s = hit._source as any;
      console.log(`  [${s['@timestamp'] ?? ''}] [${s.level ?? ''}] ${String(s.message ?? JSON.stringify(s)).slice(0, 150)}`);
    }
  } catch (e: any) {
    console.log('Search failed:', e.message);
  }

  // 3. Search specifically for ERROR/FATAL
  console.log('\n=== ERROR/FATAL logs in debugpilot-* ===');
  try {
    const res = await client.search({
      index: 'debugpilot-*',
      size: 5,
      sort: [{ '@timestamp': { order: 'desc' } }],
      query: { query_string: { query: 'level:ERROR OR level:FATAL' } }
    });
    const total = (res.hits.total as any)?.value ?? res.hits.total;
    console.log(`Error hits: ${total}`);
    for (const hit of res.hits.hits) {
      const s = hit._source as any;
      console.log(`  [${s['@timestamp'] ?? ''}] [${s.level ?? ''}] ${String(s.message ?? JSON.stringify(s)).slice(0, 150)}`);
    }
  } catch (e: any) {
    console.log('Search failed:', e.message);
  }
}

main();
