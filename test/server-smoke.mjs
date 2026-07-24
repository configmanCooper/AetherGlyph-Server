import { createGameServer } from '../server.js';

const server = createGameServer({
  ratingStore: {
    kind: 'test',
    getRating: async () => 1000,
    recordResult: async () => {},
    close: async () => {},
  },
  secret: 'smoke-secret',
});

try {
  const port = await server.listen(0);
  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  const health = await response.json();
  if (!health.ok || health.snapshotHz !== 10 || health.service !== 'aetherglyph-server') {
    throw new Error(`Unexpected health response: ${JSON.stringify(health)}`);
  }
  const root = await (await fetch(`http://127.0.0.1:${port}/`)).json();
  if (root.assetsServed !== false) throw new Error('Server unexpectedly serves client assets.');
  for (const page of ['privacy.html', 'account-deletion.html']) {
    const legal = await fetch(`http://127.0.0.1:${port}/${page}`);
    if (!legal.ok || !(await legal.text()).includes('Aetherglyph')) {
      throw new Error(`Missing legal page: ${page}`);
    }
  }
  console.log('server-smoke: PASS');
} finally {
  await server.close('smoke complete');
}
