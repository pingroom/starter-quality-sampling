import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson } from './storage.js';
import { step } from './engine.js';
import { CONFIG, ROOM_CODE, mockApi } from './mock.js';

const input = await readJson(new URL('../examples/audit.json', import.meta.url), 65536);
for (const choices of [['conforming', 'defective', 'conforming'], ['conforming', 'unknown', 'conforming']]) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-sampling-demo-'));
  try {
    const now = () => '2026-01-01T09:00:00.000Z', api = mockApi(now);
    // Fixed draw is only a reproducible offline fixture. Live CLI uses crypto.randomInt.
    const options = { client: api.client, directory, input, config: CONFIG, token: 'offline-fixture-token', room: ROOM_CODE, now, draw: () => 0 };
    let result;
    for (const choice of choices) {
      const pending = await step(options);
      api.answer(pending.inspections.find(item => item.status === 'pending').questionId, choice);
      result = await step(options);
    }
    assert.equal(result.status, choices.includes('unknown') ? 'incomplete' : 'complete');
    assert.equal(api.calls.filter(call => call.method === 'POST').length, 3);
    if (choices.includes('unknown')) assert.equal(result.inference, null);
    console.log(JSON.stringify(result, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
