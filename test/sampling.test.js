import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport } from '../src/engine.js';
import { readJson, atomicJson, acquireLock } from '../src/storage.js';
import { validateInput, validateState, sampleFor, drawSample, confidenceSet, choose, requestFor, validateConfig, hash, iso } from '../src/model.js';
import { loadConnection, loadEnvironment } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, ASKER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/audit.json', import.meta.url), 65536);
const simple = () => ({ ...structuredClone(example), sampleSize: 1, items: [structuredClone(example.items[0])] });
const twoItems = () => ({ ...structuredClone(example), sampleSize: 2, items: structuredClone(example.items.slice(0, 2)) });
async function setup(t, input = simple()) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-quality-sampling-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now);
  const options = { client: api.client, directory, input, config: structuredClone(CONFIG), token: 'offline-fixture-token', room: ROOM_CODE, now, draw: () => 0 };
  return { directory, clock, api, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;
async function decide(s, decisions) {
  let result;
  for (const value of decisions) {
    result = await s.run();
    const pending = result.inspections.find(item => item.status === 'pending');
    s.api.answer(pending.questionId, value); result = await s.run();
  }
  return result;
}

test('lost response blocks later inspections; exact-ID recovery reads the original request without resend', async (t) => {
  const s = await setup(t, twoItems()); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.deepEqual((await s.run({ command: 'find' })).candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), 'conforming'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'ready');
  assert.equal(sends(s.api), 1);
});

test('malformed create response and empty search never authorize a new POST', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true; await assert.rejects(s.run());
  assert.equal((await s.saved()).attempts[0].status, 'creating'); s.api.questions.clear();
  assert.deepEqual((await s.run({ command: 'find' })).candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('recovery validates exact target, room, request, options, data and non-handoff provenance', async (t) => {
  for (const mutate of [
    (q) => { q.target_user_id = OTHER; }, (q) => { q.room.code = 'WRONG1234567'; }, (q) => { q.prompt = 'Other prompt'; },
    (q) => { q.options[0].primary = true; }, (q) => { q.options[0].destructive = true; }, (q) => { q.options.reverse(); },
    (q) => { q.data.item_id = 'other'; }, (q) => { q.data.input_hash = 'changed'; }, (q) => { delete q.is_handoff; },
    (q) => { q.is_handoff = true; }, (q) => { q.asker.type = 'user'; }, (q) => { q.resolution_policy = 'all'; },
  ]) {
    const s = await setup(t); s.api.controls.loseNext = true; await s.run(); mutate(s.api.questions.get(id(1)));
    await assert.rejects(s.run({ command: 'recover', attachId: id(1) })); assert.equal((await s.saved()).attempts[0].status, 'creating');
    assert.equal(sends(s.api), 1);
  }
});

test('wrong, missing, typed or unsupported answers never resolve an inspection', async (t) => {
  for (const mutate of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = 'conforming'; }, (q) => { q.answer.value = 'unsupported'; }, (q) => { q.answer.label = 'Wrong'; },
  ]) {
    const s = await setup(t); await s.run(); s.api.answer(id(1), 'conforming'); mutate(s.api.questions.get(id(1)));
    const result = await s.run(); assert.equal(result.observedStatus, 'invalid_answer'); assert.equal(result.inference, null);
    await s.run(); assert.equal(sends(s.api), 1);
  }
});

test('original asker, lifetime and intent remain bound across reads and across inspections', async (t) => {
  for (const mutate of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); await s.run(); mutate(s.api.questions.get(id(1))); await assert.rejects(s.run(), /identity or lifetime/);
  }
  const s = await setup(t, twoItems()); await s.run(); s.api.answer(id(1), 'conforming'); await s.run();
  s.api.controls.loseNext = true; await s.run(); s.api.questions.get(id(2)).asker.id = OTHER;
  await assert.rejects(s.run({ command: 'recover', attachId: id(2) }), /different asking registrations/);
  const other = await setup(t); other.api.controls.loseNext = true; await other.run();
  const q = other.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(other.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('expiry accepts delayed processing but rejects premature and implausibly future resolution on replay', async (t) => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
  s.api.terminal(id(1), 'expired'); s.api.questions.get(id(1)).resolved_at = '2026-01-01T09:15:30.000Z';
  assert.equal((await s.run()).status, 'incomplete'); assert.equal((await localReport(s.directory, s.options.input)).inference, null);
  const original = await s.saved();
  for (const timestamp of ['2026-01-01T09:14:59.999Z', '2026-01-01T09:17:00.001Z']) {
    const saved = structuredClone(original); saved.attempts[0].observation.resolvedAt = timestamp;
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run(), /resolution time/); assert.equal(s.api.calls.length, calls);
    const live = await setup(t); await live.run(); live.clock.value = s.clock.value; live.api.terminal(id(1), 'expired');
    live.api.questions.get(id(1)).resolved_at = timestamp; await assert.rejects(live.run(), /resolution time/);
  }
});

test('answer and resolution times must agree and answer/cancellation cannot occur after expiry', async (t) => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), 'conforming');
  s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const terminal of ['answered', 'cancelled']) {
    const other = await setup(t); await other.run(); other.clock.value = '2026-01-01T09:16:00.000Z';
    if (terminal === 'answered') other.api.answer(id(1), 'conforming'); else other.api.terminal(id(1), terminal);
    await assert.rejects(other.run(), /resolution time/);
  }
});

test('checked time follows response; future creation, wrong TTL and answer on pending fail', async (t) => {
  const s = await setup(t); await s.run(); const get = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), 'conforming'); return get(...args); };
  await s.run(); assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  for (const mutate of [
    (q) => { q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z'; },
    (q) => { q.expires_at = '2026-01-01T10:00:00.000Z'; }, (q) => { q.answer = {}; },
  ]) { const other = await setup(t); await other.run(); mutate(other.api.questions.get(id(1))); await assert.rejects(other.run()); }
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z'); assert.throws(() => iso('2026-02-30T09:00:00Z'));
});

test('room preflight refuses public/unsupported rooms and missing inspector before a POST', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].type = 'dm'; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('reservation write failure sends nothing; answer save failure resumes the original question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), 'conforming');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'complete'); assert.equal(sends(s.api), 1);
});

test('post-create save failure leaves uncertain intent for verified recovery without another POST', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads preserve evidence and corrupted request/provenance fail before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  s.api.controls.readError = false; s.api.answer(id(1), 'conforming'); await s.run(); const original = await s.saved();
  for (const mutate of [
    (saved) => { saved.attempts[0].request.ttl = 60; }, (saved) => { saved.attempts.push(saved.attempts[0]); },
    (saved) => { saved.attempts[0].pair = 'other::pair'; }, (saved) => { saved.attempts[0].observation.answer.responderId = OTHER; },
  ]) {
    const saved = structuredClone(original); mutate(saved); assert.throws(() => validateState(saved, s.options.input));
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
  }
});

test('bounded file reads reject malformed, oversized, invalid UTF-8 and symlink data without revealing contents', async (t) => {
  const s = await setup(t), path = join(s.directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",bad');
  await assert.rejects(readJson(path), (error) => !error.message.includes('PRIVATE_TOKEN') && error.message.includes('malformed'));
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path), /UTF-8/);
  await writeFile(path, 'x'.repeat(100)); await assert.rejects(readJson(path, 50), /size limit/);
  await symlink(path, join(s.directory, 'linked')); await assert.rejects(readJson(join(s.directory, 'linked')));
});

test('private lock excludes other commands; report is offline and private', async (t) => {
  const s = await setup(t); await s.run(); const release = await acquireLock(s.directory);
  await assert.rejects(s.run(), /lock exists/); await assert.rejects(localReport(s.directory, s.options.input), /lock exists/);
  await release(); const before = s.api.calls.length;
  assert.equal((await localReport(s.directory, s.options.input, { save: true })).inference, null); assert.equal(s.api.calls.length, before);
  assert.equal((await stat(join(s.directory, 'report.json'))).mode & 0o777, 0o600);
});

test('partial or blank environment overrides never combine with saved credentials', async (t) => {
  const s = await setup(t); await atomicJson(s.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(s.directory, { PINGROOM_TOKEN: '' })); await assert.rejects(loadConnection(s.directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.equal((await loadConnection(s.directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() })).token, 'explicit');
});

test('transport rejects unrelated writes, redirects and oversized responses', async () => {
  let count = 0; const client = makeClient({ token: 'fixture', fetchImpl: async () => { count++; return new Response(null, { status: 302 }); } });
  await assert.rejects(client.questions.get(id(1))); assert.equal(count, 1); await assert.rejects(client.questions.cancel(id(1))); assert.equal(count, 1);
  const large = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) }); await assert.rejects(large.questions.get(id(1)));
});

test('transport deadlines bound stalled fetch/body and allow abort through infinite ready empty chunks', async () => {
  const stalled = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) }); await assert.rejects(stalled.questions.get(id(1)));
  const body = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) }); await assert.rejects(body.questions.get(id(1)));
  const controller = new AbortController();
  const empty = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (out) => out.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20); try { await assert.rejects(empty.questions.get(id(1))); } finally { clearTimeout(timer); }
});

test('abort before reservation sends nothing; after reservation it preserves unresolved intent', async (t) => {
  const s = await setup(t), stopped = new AbortController(); stopped.abort(); await assert.rejects(s.run({ signal: stopped.signal })); assert.equal(sends(s.api), 0);
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(s.run({ signal: controller.signal, write: async (...args) => { await atomicJson(...args); if (++writes === 2) controller.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});


test('partial external credentials cannot borrow the room from dotenv', async (t) => {
  const s = await setup(t), path = join(s.directory, '.env');
  await writeFile(path, 'PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = { PINGROOM_TOKEN: 'shell-token' }; await loadEnvironment(partial, path);
  assert.equal(partial.PINGROOM_ROOM, undefined); await assert.rejects(loadConnection(s.directory, partial));
  const env = {}; await loadEnvironment(env, path); assert.deepEqual(await loadConnection(s.directory, env), { token: 'file-token', room: ROOM_CODE });
});


const population = (N, n) => ({ auditId: 'fixed-roster', title: 'Card audit', criterion: 'Has a title and level', sampleSize: n,
  items: Array.from({ length: N }, (_, i) => ({ id: `c${String(i).padStart(3,'0')}`, label: `Card ${i}`, details: `Inspect local card ${i}` })) });

test('canonical IDs and shrinking unbiased draw indices reconstruct a unique ordered sample', () => {
  const input = population(5,3); input.items.reverse(); const bounds = [], indices = [4,1,2];
  const sample = drawSample(input, max => { bounds.push(max); return indices[bounds.length - 1]; });
  assert.deepEqual(bounds,[5,4,3]); assert.deepEqual(sampleFor(input,sample).map(item => item.id),['c004','c001','c003']);
  assert.equal(new Set(sampleFor(input,sample).map(item => item.id)).size,3);
  assert.deepEqual(input.items.map(item => item.id),['c004','c003','c002','c001','c000']);
  assert.deepEqual(validateInput(input),validateInput({ ...input, items:[...input.items].reverse() }));
  for (const draws of [[5,0,0],[-1,0,0],[0,0,3],[0,1.5,0],[0,0],['0',0,0]]) assert.throws(() => sampleFor(input,{...sample,drawIndices:draws}));
  assert.throws(() => sampleFor(input,{...sample,seed:1})); assert.throws(() => drawSample(input,()=>5));
});

test('every ordered sample is represented exactly once by shrinking-pool indices', () => {
  const input = population(4,3), counts = new Map();
  for (let a=0;a<4;a++) for (let b=0;b<3;b++) for (let c=0;c<2;c++) {
    const key=sampleFor(input,{method:'crypto_random_int_without_replacement',drawIndices:[a,b,c]}).map(item=>item.id).join(',');
    counts.set(key,(counts.get(key)??0)+1);
  }
  assert.equal(counts.size,24); assert.ok([...counts.values()].every(count=>count===1));
});

test('exact confidence bounds match independent combinatorial oracle cases and conservative equality', () => {
  for (const [N,n,x,lo,hi] of [[10,5,0,0,3],[10,5,2,2,7],[10,5,5,7,10],[20,5,1,1,13],[200,12,0,0,51],[8,8,3,3,3],
    [40,1,0,0,39],[40,1,1,1,40],[1,1,0,0,0],[1,1,1,1,1]]) {
    const result=confidenceSet(N,n,x); assert.equal(result.lowerDefectCount,lo); assert.equal(result.upperDefectCount,hi);
    assert.deepEqual(result.acceptedDefectCounts,Array.from({length:hi-lo+1},(_,i)=>lo+i));
  }
  assert.equal(choose(200,12),6107693672247476400n); assert.equal(choose(8,-1),0n); assert.equal(choose(8,9),0n);
  for (const args of [[0,1,0],[201,1,0],[10,0,0],[10,11,0],[20,13,1],[10,3,-1],[10,3,4],[10,3,1.5]]) assert.throws(()=>confidenceSet(...args));
});

test('independent enumeration of all small-population subsets gives at least 95 percent coverage', () => {
  // No combination formula here: enumerate each possible sample explicitly.
  for (let N=1;N<=9;N++) for (let n=1;n<=N;n++) {
    const subsets=[];
    function walk(start,selected) {
      if(selected.length===n){subsets.push([...selected]);return;}
      for(let i=start;i<N;i++) walk(i+1,[...selected,i]);
    }
    walk(0,[]);
    const intervals=Array.from({length:n+1},(_,x)=>confidenceSet(N,n,x));
    for(let K=0;K<=N;K++) {
      let covered=0;
      for(const subset of subsets) {
        const x=subset.filter(index=>index<K).length;
        if(intervals[x].acceptedDefectCounts.includes(K)) covered++;
      }
      assert.ok(covered*20 >= subsets.length*19,`N=${N}, n=${n}, K=${K}`);
    }
  }
});

test('census identifies the population count exactly for every possible classification count', () => {
  for(let N=1;N<=12;N++) for(let x=0;x<=N;x++) assert.deepEqual(confidenceSet(N,N,x).acceptedDefectCounts,[x]);
});

test('sample is saved before any POST and resumes without drawing again', async t => {
  const s=await setup(t,population(8,3)); let draws=0;
  const result=await s.run({draw:max=>{draws++;return max-1;},write:async(...args)=>{
    if(args[2].attempts.length===0){assert.equal(sends(s.api),0);assert.deepEqual(args[2].sample.drawIndices,[7,6,5]);}
    await atomicJson(...args);
  }});
  assert.equal(draws,3); assert.deepEqual(result.inspections.map(item=>item.itemId),['c007','c006','c005']);
  await s.run({draw:()=>{throw new Error('Must never redraw');}});
  assert.equal(sends(s.api),1); assert.equal((await s.saved()).attempts[0].itemId,'c007');
});

test('sample-write failure sends nothing; persisted sample survives the following intent failure', async t => {
  const s=await setup(t,population(5,2));
  await assert.rejects(s.run({write:async()=>{throw new Error('disk full');}})); assert.equal(sends(s.api),0); assert.equal(await s.saved(),null);
  let writes=0;
  await assert.rejects(s.run({draw:max=>max-1,write:async(...args)=>{if(++writes===2)throw new Error('disk full');await atomicJson(...args);}}));
  assert.equal(sends(s.api),0); assert.deepEqual((await s.saved()).sample.drawIndices,[4,3]);
  const result=await s.run({draw:()=>{throw new Error('Must never redraw');}}); assert.equal(result.inspections[0].itemId,'c004');
});

test('complete binary inspections yield attributed finite-population inference; replay is offline', async t => {
  const s=await setup(t,population(10,5)); const result=await decide(s,['conforming','defective','conforming','defective','conforming']);
  assert.equal(result.status,'complete'); assert.equal(result.inference.lowerDefectCount,2); assert.equal(result.inference.upperDefectCount,7);
  assert.deepEqual(result.deterministicDefectBounds,{lower:2,upper:7,basis:'observed_classifications_assumed_correct'});
  assert.equal(result.inspections[0].responderId,CONFIG.participant.id); assert.equal(result.inspections[0].askerId,ASKER);
  assert.deepEqual(result.inference.sampleDefectFraction,{numerator:2,denominator:5});
  const calls=s.api.calls.length; assert.deepEqual((await s.run()).inference,result.inference); assert.equal(s.api.calls.length,calls);
});

test('Unknown is never replaced; incomplete samples report only deterministic bounds', async t => {
  const s=await setup(t,population(10,3)); let result=await decide(s,['unknown']);
  assert.equal(result.status,'ready'); assert.equal(result.inference,null); assert.deepEqual(result.unknownItemIds,['c000']);
  assert.deepEqual(result.deterministicDefectBounds,{lower:0,upper:10,basis:'observed_classifications_assumed_correct'});
  result=await decide(s,['defective','conforming']); assert.equal(result.status,'incomplete'); assert.equal(result.inference,null);
  assert.deepEqual(result.deterministicDefectBounds,{lower:1,upper:9,basis:'observed_classifications_assumed_correct'}); assert.deepEqual(result.unansweredItems,[]);
  await s.run(); assert.equal(sends(s.api),3); assert.deepEqual(result.inspections.map(item=>item.itemId),['c000','c001','c002']);
});

test('pending, expiry and cancellation remain unanswered, never conforming or Unknown', async t => {
  for(const terminal of ['expired','cancelled']) {
    const s=await setup(t,population(5,2)); await decide(s,['conforming']); await s.run();
    assert.equal((await localReport(s.directory,s.options.input)).inference,null);
    if(terminal==='expired')s.clock.value='2026-01-01T09:16:00.000Z';s.api.terminal(id(2),terminal);
    const result=await s.run();assert.equal(result.status,'incomplete');assert.equal(result.inference,null);assert.deepEqual(result.unknownItemIds,[]);
    assert.deepEqual(result.unansweredItems,[{itemId:'c001',status:terminal}]);await s.run();assert.equal(sends(s.api),2);
  }
});

test('invalid population schemas fail before any request', async t => {
  for(const mutate of [
    p=>{p.auditId=1;},p=>{p.items=[];},p=>{p.items=Array(201).fill(p.items[0]);},p=>{p.sampleSize=0;},p=>{p.sampleSize=13;},
    p=>{p.sampleSize=3;},p=>{p.sampleSize='1';},p=>{p.sampleSize=1.5;},p=>{p.items[1].id=p.items[0].id;},
    p=>{p.items[0].id=1;},p=>{p.items[0].id='constructor';},p=>{p.items[0].details='x'.repeat(81);},
    p=>{p.criterion='x'.repeat(101);},p=>{p.criterion='line\nbreak';},p=>{p.seed='selected';},p=>{p.items[0].code='execute';},
  ]){const input=population(2,1);mutate(input);const s=await setup(t,input);await assert.rejects(s.run());assert.equal(s.api.calls.length,0);}
});

test('state binds complete population and inspector; source ordering alone is immaterial', async t => {
  const s=await setup(t,population(10,2));await s.run();
  for(const mutate of [p=>{p.auditId='changed';},p=>{p.criterion='Different criterion';},p=>{p.sampleSize=3;},p=>{p.items[9].details='Unsampled item changed';},p=>{p.items.pop();}]) {
    const input=structuredClone(s.options.input);mutate(input);await assert.rejects(s.run({input}),/changed audit population/);
  }
  await assert.rejects(s.run({config:{participant:{id:OTHER,label:'Other'}}}),/another connection/);
  await assert.rejects(s.run({token:'other'}),/another connection/);
  const reordered=structuredClone(s.options.input);reordered.items.reverse();assert.equal((await s.run({input:reordered})).status,'pending');assert.equal(sends(s.api),1);
});

test('changed sample or answer order cannot reuse saved request evidence', async t => {
  const s=await setup(t,population(8,3));await decide(s,['conforming','defective']);const original=await s.saved();
  for(const mutate of [state=>{state.sample.drawIndices[0]=7;},state=>{state.sample.drawIndices[2]=6;},
    state=>{state.sample.drawIndices.push(0);},state=>{state.sample.method='seed';},state=>{state.attempts.reverse();},
    state=>{state.attempts[0].itemId='c007';},state=>{state.attempts[1].observation.askerId=OTHER;}]) {
    const state=structuredClone(original);mutate(state);assert.throws(()=>validateState(state,s.options.input));
    await atomicJson(s.directory,'state.json',state);const calls=s.api.calls.length;await assert.rejects(s.run());assert.equal(s.api.calls.length,calls);
  }
});

test('maximum roster and sample fit input, prompts, state, HTTP and report bounds', async t => {
  const input=population(200,12);input.auditId='a'.repeat(40);input.title='t'.repeat(60);input.criterion='c'.repeat(100);
  input.items=input.items.map((item,i)=>({id:`i${String(i).padStart(3,'0')}${'x'.repeat(20)}`,label:'l'.repeat(40),details:'d'.repeat(80)}));
  assert.ok(Buffer.byteLength(JSON.stringify(input,null,2))<65536);
  const s=await setup(t,input);const result=await decide(s,Array(12).fill('conforming'));
  assert.equal(result.inference.upperDefectCount,51);assert.equal(sends(s.api),12);
  for(const q of s.api.questions.values())assert.ok(q.prompt.length<=500);
  assert.ok(Buffer.byteLength(JSON.stringify(await s.saved(),null,2))+4096<1024*1024);
  await localReport(s.directory,input,{save:true});assert.ok((await stat(join(s.directory,'report.json'))).size<1024*1024);
});

test('saved and later observations cannot predate intent or regress across Questions', async t => {
  const s=await setup(t,population(3,2));await s.run();
  s.clock.value='2026-01-01T09:02:00.000Z';await s.run();
  s.clock.value='2026-01-01T09:01:00.000Z';const before=await s.saved();await assert.rejects(s.run(),/regressed/);assert.deepEqual(await s.saved(),before);
  const corrupt=structuredClone(before);corrupt.attempts[0].observation.checkedAt='2026-01-01T08:59:59.000Z';
  assert.throws(()=>validateState(corrupt,s.options.input),/predates/);
  s.clock.value='2026-01-01T09:03:00.000Z';s.api.answer(id(1),'conforming');await s.run();
  s.clock.value='2026-01-01T09:02:30.000Z';await assert.rejects(s.run(),/saved inspection/);assert.equal(sends(s.api),1);
  s.clock.value='2026-01-01T09:04:00.000Z';await s.run();const state=await s.saved();state.attempts[1].createdAt='2026-01-01T09:02:00.000Z';
  assert.throws(()=>validateState(state,s.options.input),/saved inspection/);
});
