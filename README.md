# PingRoom quality sampling

Draw a random sample from a fixed roster, ask one named inspector to classify
those items in PingRoom, and estimate the population's defect count. The starter
saves the sample before asking anything and uses exact integer arithmetic for a
95% finite-population confidence set.

## Try it offline

Requires Node.js 22 or newer on macOS or Linux with private persistent storage.
Choose **Use this template**, clone your repository, then run:

```sh
npm ci
npm test
npm run demo
```

The demo audits three reading cards, then shows an Unknown classification
blocking inference. It uses the real SDK with an in-memory HTTP transport, needs
no credentials, makes no network requests, and removes its temporary state.
Installation requires npm access. Live phone delivery is not tested.

## Prepare and connect

```sh
cp examples/audit.json audit.json
cp config.example.json config.json
npm run validate
npm run connect
npm run inspect
```

Edit `audit.json` before starting. Supply a unique `auditId`, title, fixed binary
`criterion`, `sampleSize`, and the **complete** finite roster of items. Each item
has a unique `id`, `label`, and `details` telling the inspector what to examine.
The starter does not fetch or inspect the underlying item itself. Keep those
records unchanged for the audit. Use harmless local examples while adapting it.

Population size is 1–200; sample size is 1–12 and cannot exceed the population.
`validate` checks inputs without credentials, state changes, or API calls. Sample
size must be fixed before inspection; the starter does not choose it for a target
precision or acceptance rule.

Install [PingRoom](https://pingroom.io/i), approve the pairing link, and choose a
**standard private room** containing the inspector. Review the server-defined
agent-feature grant shown during pairing and delegate access to that room.
Normal permissions and quotas apply. The inspector may be the connecting account
or another member.

`inspect` lists member UUIDs and lookup names. Verify the intended person in the
app and put their exact UUID and a local label in `config.json`. Names alone do
not establish identity. One configured inspector handles the entire sample.

Pairing saves private `.pingroom/credentials.json` and reuses its saved link while
pending. It does not overwrite an existing connection. If creation is uncertain
or the link expires, inspect Connected Agents and resolve or revoke the old robot
before archiving `.pingroom/pairing.json` for new setup.

Alternatively, copy `.env.example` to `.env` and set **both** `PINGROOM_TOKEN` and
`PINGROOM_ROOM`. A complete pair overrides saved credentials; partial or blank
pairs fail. Defining either shell variable selects the entire shell pair, without
borrowing from `.env`. Paths resolve from this project directory.

## Inspect and export

```sh
npm start          # Ask the next sampled item, or read the current Question once.
# Answer in PingRoom, then rerun:
npm start
npm run status     # Read saved evidence without credentials or network.
npm run report     # Also write private .sampling/report.json.
```

On the first run, code sorts IDs, draws uniformly from the remaining items with
`crypto.randomInt`, and saves all draw indices before any Question. Those indices
reconstruct the exact sample from the canonical roster. There is no live seed or
sample override. Each invocation creates or reads at most one Question; only one
is active at a time, with a 15-minute lifetime. No scheduler is installed.

The inspector chooses **Conforming**, **Defective**, or **Unknown**. Unknown is an
explicit response. Unasked, pending, expired, cancelled, invalid, and uncertain
outcomes remain separate. None becomes conforming. Other sampled items may still
be inspected, but no item is replaced and terminal requests are never reissued
within the audit. Restarts reuse the original sample.

The report includes input/sample hashes, draw indices, item IDs, classification,
Question ID, responder UUID, asking registration, and answer/observation times.
`unknownItemIds` identifies explicit Unknown answers; `unansweredItems` lists
items without a valid answer. Completed evidence replays locally as a historical
report, without checking current access or changes to the underlying records.

`inference` stays `null` unless every sampled item has a valid binary label. Even
for partial results, `deterministicDefectBounds` reports `[observed defects,
population size − observed conforming]`, assuming those classifications are
correct. These bounds are not a confidence interval.

## Read the statistical result

For population size `N`, sample size `n`, and observed defect count `x`, the
hypergeometric probability for a hypothetical population defect count `K` is
`P(X=j) = C(K,j) C(N−K,n−j) / C(N,n)`. See the
[NIST hypergeometric distribution reference](https://itl.nist.gov/div898/software/dataplot/refman2/ch8/hypcdf.pdf).

Code retains each integer `K` from 0 through `N` when both inclusive tails
`P(X≤x)` and `P(X≥x)` are at least `1/40`. BigInt combinations compare exact
numerators; equality is retained. This inversion produces a conservative 95%
confidence set. The report provides all `acceptedDefectCounts`, count bounds,
exact fraction bounds, and the observed sample fraction `x/n`.

Under the sampling assumptions, this method covers the fixed true count in at
least 95% of repeated random samples. It does not assign a 95% probability to the
particular population count after observation. A census returns the exact count.
Zero defects among 12 sampled from 200 yields count bounds **0–51**; it does not
show that the batch is defect-free.

Coverage assumes a complete fixed roster, one uniform sample without replacement,
and accurate classification under a fixed criterion. It does not account for
missing roster items, inspection errors, changing records, substituted samples,
or rerunning audits until a desirable result appears. The report applies only to
this population, not future batches, and never approves a release.

## Resume and recover

Private state binds the full input hash, sample, inspector configuration, room,
and credential fingerprint. Input roster order is immaterial; other changes fail.
Before each POST, code saves and syncs the exact payload, TTL, correlation, and
idempotency key. A crash, lost/malformed response, or failed save may leave
`create_unknown`. Later runs do not repeat that POST or continue to another item.

```sh
npm run find-id
npm run recover -- EXACT_QUESTION_UUID
```

`find-id` reads up to 200 recent Questions and lists matching
candidates. No match does not prove creation failed. Locate the original ID in
the originating robot's history or saved response if needed. Recovery reads that
exact ID and validates the request, sample, room, target, asking registration,
and timestamps before attaching it. Reads require the original registration.

Answers require the named server-authenticated responder and an exact option.
Answer/resolution times must agree and fall within the Question's lifetime.
Expiry may be recorded at or after the deadline. Observation times cannot regress;
implausible future times fail, allowing 60 seconds of clock skew.

Do not delete state, edit the sample, or use a second checkout to retry an audit.
Keep uncertain records while investigating. After resolving active/uncertain work,
archive the entire `.sampling/` directory to start a new population
with a new audit ID. Preserve old evidence; there is no automatic migration.

Exit codes for `start`/`recover`: `0` complete binary sample; `2` incomplete sample
or newly observed expired/cancelled/invalid answer; `3` ready/pending/interrupted;
`4` uncertain creation; `1` errors. Unknown may leave `ready` while other items
remain; the final incomplete result exits `2`. Local commands exit `0` when
readable; inspect their JSON status.

## Adapt and verify

`src/engine.js` exports `step` for workflow runners. `src/model.js` owns sampling,
validation, attribution, and inference. Keep these rules in application code; no
AI service is required. Text never becomes commands or fetched URLs. The injected
`draw` function is only for reproducible offline tests; live integrations must
use the default cryptographic draw. Saved state is not tamper-evident proof of
randomness against someone who controls the filesystem.

Audit IDs allow 40 characters; item IDs allow 24, beginning with a lowercase
letter and using lowercase letters, digits, `_`, or `-`. Prototype item IDs are
rejected. Text is printable ASCII with no outer spaces: title 60, criterion 100,
item label 40, details 80, inspector label 60 characters. Input is capped at
64 KiB, config at 16 KiB, state/reports at 1 MiB, and HTTP bodies at 512 KiB.

Writes use private temporary files, file sync, rename, and directory sync. A
per-directory lock excludes concurrent commands. After a crash, inspect
`.sampling/.lock/owner.json` or `.pingroom/.lock/owner.json`, confirm its owner has
stopped, then remove only that stale lock. Restore corrupt state from a valid
backup. Local persistence and server idempotency do not promise distributed
exactly-once execution.

Credentials, local inputs, state, and reports are ignored by Git. Files use `0600`
and directories `0700` on POSIX; keep backups private. The
[official SDK](https://github.com/pingroom/sdk) is pinned to `0.7.0`, with a lockfile
and 14-day minimum release age. Requests use the official API origin, reject
redirects, and have a five-second deadline through body consumption. Tests include
independent exhaustive small-population coverage checks and run on Node 22/24.

Unlike [label agreement](https://github.com/pingroom/starter-label-agreement),
which compares assessors on selected items, this workflow uses a random sample
to infer a finite population's defect count. MIT licensed; see [LICENSE](LICENSE).
