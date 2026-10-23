import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Bind immediately after chat.connect. Fork/export helpers publish their own
// short-lived server to the same port hint; never rediscover it before a POST.
export async function bindOc2Mock(portFile, directory) {
  const port = Number(await readFile(portFile, 'utf8'));
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, `invalid mock port in ${portFile}: ${port}`);
  const origin = `http://127.0.0.1:${port}`;
  const health = await fetch(`${origin}/global/health`);
  assert.equal(health.ok, true, `mock readiness at ${origin}: ${health.status}`);
  await health.arrayBuffer();
  return async (path, body) => {
    try {
      const response = await fetch(`${origin}${path}?directory=${encodeURIComponent(directory)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.ok, true, `${path} at ${origin}: ${response.status}`);
      return await response.json();
    } catch (cause) {
      // A failed mutation is uncertain. Diagnose it, never retry it here.
      throw new Error(`OC2 mock POST ${path} at bound ${origin} failed: ${cause.message}`, { cause });
    }
  };
}
