import { createHash, randomInt } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const ROOM = /^[A-Z0-9]{12}$/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => record(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value);
const line = (value, max) => typeof value === 'string' && value.length <= max && /^[\x20-\x7e]+$/.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}



export function validateInput(input) {
  if (!keys(input, ['auditId', 'title', 'criterion', 'sampleSize', 'items']) || !word(input.auditId) || !line(input.title, 60)
    || !line(input.criterion, 100) || !Array.isArray(input.items) || input.items.length < 1 || input.items.length > 200
    || !Number.isInteger(input.sampleSize) || input.sampleSize < 1 || input.sampleSize > Math.min(12, input.items.length)) throw new Error('Provide an audit ID, title, criterion, one to 200 items, and a sample size from one to min(12, population size).');
  const ids = new Set();
  for (const item of input.items) {
    if (!keys(item, ['id', 'label', 'details']) || !word(item.id) || item.id.length > 24 || ids.has(item.id)
      || ['constructor', 'prototype', '__proto__'].includes(item.id) || !line(item.label, 40) || !line(item.details, 80)) throw new Error('Items require unique bounded IDs and printable single-line labels and details.');
    ids.add(item.id);
  }
  return { ...structuredClone(input), items: structuredClone(input.items).sort((a, b) => compare(a.id, b.id)) };
}

export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id)
    || !line(config.participant.label, 60)) throw new Error('Config requires an exact inspector UUID and label.');
  return structuredClone(config);
}

export function sampleFor(rawInput, sample) {
  const input = validateInput(rawInput);
  if (!keys(sample, ['method', 'drawIndices']) || sample.method !== 'crypto_random_int_without_replacement'
    || !Array.isArray(sample.drawIndices) || sample.drawIndices.length !== input.sampleSize) throw new Error('Invalid saved random sample.');
  const remaining = [...input.items];
  return sample.drawIndices.map((index) => {
    if (!Number.isInteger(index) || index < 0 || index >= remaining.length) throw new Error('Invalid saved sample draw index.');
    return remaining.splice(index, 1)[0];
  });
}

/** Injected draw is for offline tests only; the CLI always uses crypto.randomInt. */
export function drawSample(rawInput, draw = randomInt) {
  const input = validateInput(rawInput);
  const sample = { method: 'crypto_random_int_without_replacement', drawIndices: Array.from({ length: input.sampleSize }, (_, i) => draw(input.items.length - i)) };
  sampleFor(input, sample);
  return sample;
}

export const sampleHash = (input, sample) => hash({ inputHash: hash(validateInput(input)), sample });

export function requestFor(rawInput, config, sample, itemId, attemptId) {
  const input = validateInput(rawInput), item = sampleFor(input, sample).find((item) => item.id === itemId);
  if (!item || !isId(attemptId)) throw new Error('Invalid sampled item or attempt.');
  const key = `sampling-${attemptId}`;
  const prompt = `${input.title}\nCriterion: ${input.criterion}\nItem ${item.id}: ${item.label}\n${item.details}\nInspect this exact item. Choose Conforming or Defective against the criterion, or Unknown if you cannot classify it.`;
  if (prompt.length > 500) throw new Error('Inspection prompt exceeds 500 characters.');
  return { prompt, context: `Sample ${sampleHash(input, sample).slice(0, 20)}`,
    options: [['conforming', 'Conforming'], ['defective', 'Defective'], ['unknown', 'Unknown']].map(([value, label]) => ({ value, label, style: 'default' })),
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL, correlation_id: key,
    data: { input_hash: hash(input), sample_hash: sampleHash(input, sample), item_id: itemId, attempt_id: attemptId }, idempotencyKey: key };
}

export function validateState(state, rawInput) {
  const input = validateInput(rawInput);
  if (!keys(state, ['version', 'inputHash', 'sample', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || !/^[0-9a-f]{64}$/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > input.sampleSize || iso(state.startedAt) !== state.startedAt) throw new Error('Invalid state or changed audit population. Restore the original input and configuration.');
  validateConfig(state.config);
  const items = sampleFor(input, state.sample), ids = new Set(), questionIds = new Set(); let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'itemId', 'createdAt', 'request', 'questionId', 'status', 'observation']) || !isId(attempt.id) || ids.has(attempt.id)
      || attempt.itemId !== items[index].id || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, state.sample, attempt.itemId, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) throw new Error('Invalid saved inspection request or sample order.');
    ids.add(attempt.id); previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId); validateObservation(attempt.observation, attempt.status, attempt.request);
      if (attempt.observation.checkedAt < attempt.createdAt) throw new Error('Observation predates its saved creation intent.');
      previous = attempt.observation.checkedAt;
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS) throw new Error('Question predates its saved creation intent.');
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) throw new Error('Only the last sampled item may have an active Question.');
  }
  return state;
}

export function choose(n, k) {
  if (!Number.isInteger(n) || !Number.isInteger(k) || n < 0 || n > 200) throw new Error('Invalid combination arguments.');
  if (k < 0 || k > n) return 0n;
  k = Math.min(k, n - k); let result = 1n;
  for (let i = 1; i <= k; i++) result = result * BigInt(n - k + i) / BigInt(i);
  return result;
}

/** Invert both inclusive 2.5% hypergeometric tails using exact integers. */
export function confidenceSet(N, n, x) {
  if (!Number.isInteger(N) || N < 1 || N > 200 || !Number.isInteger(n) || n < 1 || n > Math.min(12, N)
    || !Number.isInteger(x) || x < 0 || x > n) throw new Error('Invalid finite-population observations.');
  const denominator = choose(N, n), acceptedDefectCounts = [];
  for (let K = 0; K <= N; K++) {
    let lower = 0n, upper = 0n;
    for (let j = 0; j <= n; j++) {
      const weight = choose(K, j) * choose(N - K, n - j);
      if (j <= x) lower += weight;
      if (j >= x) upper += weight;
    }
    if (lower * 40n >= denominator && upper * 40n >= denominator) acceptedDefectCounts.push(K);
  }
  if (!acceptedDefectCounts.length) throw new Error('Empty confidence set.');
  return { method: 'exact_equal_tailed_hypergeometric_inversion', confidenceLevel: 0.95, populationSize: N, sampleSize: n, observedDefects: x,
    acceptedDefectCounts, lowerDefectCount: acceptedDefectCounts[0], upperDefectCount: acceptedDefectCounts.at(-1),
    populationFractionBounds: { lowerNumerator: acceptedDefectCounts[0], upperNumerator: acceptedDefectCounts.at(-1), denominator: N },
    sampleDefectFraction: { numerator: x, denominator: n } };
}

export function report(state, rawInput) {
  const input = validateInput(rawInput); validateState(state, input);
  const inspections = sampleFor(input, state.sample).map((item) => {
    const attempt = state.attempts.find((attempt) => attempt.itemId === item.id), answer = attempt?.observation?.answer;
    return { itemId: item.id, label: item.label, status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
      choice: answer?.value ?? null, questionId: attempt?.questionId ?? null, attemptId: attempt?.id ?? null,
      responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null,
      askerId: attempt?.observation?.askerId ?? null, observedAt: attempt?.observation?.checkedAt ?? null };
  });
  const active = inspections.find((item) => ['create_unknown', 'pending'].includes(item.status));
  const conforming = inspections.filter((item) => item.choice === 'conforming').length, defective = inspections.filter((item) => item.choice === 'defective').length;
  const complete = conforming + defective === input.sampleSize;
  const status = active?.status ?? (inspections.some((item) => item.status === 'unasked') ? 'ready' : complete ? 'complete' : 'incomplete');
  return { auditId: input.auditId, title: input.title, criterion: input.criterion, inputHash: hash(input), sampleHash: sampleHash(input, state.sample),
    status, startedAt: state.startedAt, participant: state.config.participant, populationSize: input.items.length, sampleSize: input.sampleSize,
    sample: state.sample, inspections, observedCounts: { conforming, defective },
    unknownItemIds: inspections.filter((item) => item.choice === 'unknown').map((item) => item.itemId),
    unansweredItems: inspections.filter((item) => item.status !== 'answered').map(({ itemId, status }) => ({ itemId, status })),
    deterministicDefectBounds: { lower: defective, upper: input.items.length - conforming, basis: 'observed_classifications_assumed_correct' },
    inference: complete ? confidenceSet(input.items.length, input.sampleSize, defective) : null,
    assumptions: ['The supplied roster is the complete fixed finite population.', 'The recorded sample was drawn once, uniformly without replacement.', 'The inspector applies the fixed criterion accurately to the sampled items.'],
    decision: 'No automated release decision. Historical report for this population only.' };
}


function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['value', 'label', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || !request.options.some((option) => option.value === answer.value && option.label === answer.label)
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved inspection evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered inspections must not contain classification evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || q.is_handoff !== false
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || q.results !== null || q.text_input !== null || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== request.options.length
    || q.options.some((option, index) => option?.value !== request.options[index].value || option?.label !== request.options[index].label
      || option?.primary !== false || option?.destructive !== false)) throw new Error('Question does not match the saved sampled item, room, or inspector.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.text !== null || answer.responder?.id !== request.target_user_id
        || !request.options.some((option) => option.value === answer.value && option.label === answer.label)) throw new Error('Invalid answer.');
      observation.answer = { value: answer.value, label: answer.label, responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}


export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
