# InterfaceDelta CLI

InterfaceDelta checks the agent services your project depends on (MCP servers, A2A agents, OpenAPI services) for interface changes, and tells you deterministically whether each change is breaking. It inspects public HTTPS interfaces locally, compares them with baselines committed to your repository, and fails CI when a configured change appears. Inspection and baseline checks run locally. `status` reads the hosted InterfaceDelta record; `watch` syncs dependencies when explicitly requested. No telemetry is sent. Inspection credentials require an explicit origin binding; hosted reads use their own configured key.

The package is `interfacedelta` 0.8.0 and requires Node.js 22 or newer:

```sh
npm install -g interfacedelta
interfacedelta version
npx interfacedelta inspect https://service.example
```

## Check every dependency

List the services in `.interfacedelta/dependencies.json`. Baseline paths are relative to that file and must stay inside its directory.

```json
{
  "formatVersion": "interfacedelta-dependencies-v1",
  "failOn": "breaking",
  "dependencies": [
    {
      "name": "docs-search",
      "url": "https://mcp.service.example",
      "mcpEndpoint": "https://mcp.service.example/mcp",
      "baseline": "docs-search.json"
    }
  ]
}
```

```sh
interfacedelta baseline          # writes missing baselines; --force replaces all
interfacedelta check             # checks every dependency
interfacedelta check --fail-on breaking,metadata --sarif interfacedelta.sarif
```

A run checks up to 50 dependencies, four at a time. `baseline --only <name>` writes just one dependency's baseline (with `--force` to replace it after reviewing a change you adopt).

## The record in your terminal

```sh
npx interfacedelta status
interfacedelta status --since 2026-11-19T00:00:00Z --fail-on breaking
interfacedelta status --json
```

`status` reads MCP tool names and their source endpoints from the same validated
baselines as `check --dependencies`. It asks only the InterfaceDelta record;
it never scans or calls a dependency. `--dependencies <path>` defaults to
`.interfacedelta/dependencies.json`. Create that file and record baselines with
`interfacedelta baseline` first (that separate command inspects dependencies).

Human output groups tools by server and shows recorded changes, the latest
breaking change since start, missing observations, stale evidence, observed HTTP
402, declared payment, and stored AI readings of money movement or deletion.
Goal summary counts come from the response and include earlier breaking changes
in available history. No recorded change is not proof of no change. History is
bounded to the latest 20 eligible public observations. There are no safety
verdicts or scores. Output follows the CLI's plain-text style (no ANSI colour,
including with `NO_COLOR`). Details link to the atlas.

Each baseline's `generatedAt` supplies `sinceTime`; `--since <RFC3339>` overrides
it for every tool (offsets are normalized to UTC). No baseline fingerprints are
sent: accepted historical capability projections are not guaranteed to match
those used by today's record.

Set `INTERFACEDELTA_AGENT_KEY` for REST reads at
`POST https://interfacedelta.com/api/v1/record/check/goal`. Get a free key with one
request: `POST https://interfacedelta.com/api/v1/agent-keys`. The existing
`--token` bindings are dependency inspection credentials, not Record API keys.
Tools are grouped by start time and sent in batches of at most 50.

Without a key, status calls `check_tools` on
`https://interfacedelta.com/mcp/public` over streamable HTTP. At most five tools
are admitted together, all-or-nothing. If baseline start times differ, provide
`--since` for one shared time or use a key. A quota refusal reports its reset
time. Every tool consumes one Record API request; MCP initialization and the
initialized notification consume no Record API requests. Status never retries
checks automatically or makes a payment.

`--json` writes the signed REST goal response byte-for-byte. Multiple batches
emit separate JSON values separated by a newline (use a streaming JSON parser).
Keyless output preserves the MCP tool's text JSON, including its `result` goal
and unsigned `quota`. Verify the signed goal at `/api/v1/record/check/verify`;
for keyless output, submit only `result`. The per-tool `changedSinceTime` flags
are unsigned. JSON is intended for machines; human output sanitizes network
strings for terminal display. `--api-url <url>` selects an HTTPS origin
(localhost HTTP is allowed for test servers); keys are sent to that origin only
and redirects are refused.

Status exits 0 unless an optional `--fail-on changed|breaking` matches a positive
returned summary count, in which case it exits 1. Usage/configuration errors
(including missing dependencies/baselines or rejected credentials) exit 2.
Unavailable records (network, rate limits, malformed responses or 5xx) exit 3.
No threshold is applied by default. Other `check` policy options do not apply.

## Agent definitions and skills

Use `agent-check` to read the tools configured for an agent, `skills` to find
exact mentions of changed tools in its instructions, and `citations` to compare
pinned sources with their recorded versions. `cite` creates the source pins.
Each command has its own optional failure threshold and SARIF report. The tool
checks read InterfaceDelta's stored record; they never call the configured tools.

### Read an agent configuration (agent-check)

```sh
npx interfacedelta agent-check
interfacedelta agent-check path/to/repo --since 2026-11-19T00:00:00Z
interfacedelta agent-check --config ~/.cursor/mcp.json --fail-on breaking,payment --json
```

Agent definitions list their tools explicitly: one agent gets six MCP servers,
another a shell and an editor. `agent-check` reads the agent's MCP client config
and reports, per configured tool, what InterfaceDelta's record says. It never
calls the configured servers; only the hosted record is read, exactly as
`status` reads it.

Configs supported, detected by content (`mcpServers`, `servers` or
`mcp.servers`): project `.mcp.json`, Claude Desktop
`claude_desktop_config.json`, Cursor `.cursor/mcp.json`, VS Code
`.vscode/mcp.json` and `.vscode/settings.json`. The optional path is a file or
a directory; a directory is searched for the four project files above (default:
the current directory). `--config <file>` forces one file. Your home directory
is never read unless you pass `--include-user-configs`, which also reads the
Claude Desktop, Cursor and VS Code user configs. Env values, headers, args and
tokens in a config are never printed, logged or sent; literal env and header
values, argument values and token fields are additionally registered as redaction
guards. Credential-bearing URLs omit userinfo, queries and fragments in every
output. If a record response echoes a config credential, the command refuses
the report and writes nothing rather than altering signed data. HTTP(S) configs
are read; the released Record Check accepts HTTPS endpoints only, so HTTP
endpoints are listed as `not_checkable`. Stdio servers are listed as `not_checkable_local` with the
command name only. Duplicate definitions are merged by endpoint URL.

Two record steps run per server. First the endpoint's origin goes to
`get_atlas_entry` (view `full`) on `https://interfacedelta.com/mcp/public`.
This released read tool supplies the retained Passport with endpoint URLs and
capabilities linked by `sourceEndpointId`; the configured endpoint URL must match
a recorded endpoint exactly. A host with several services is resolved by trying
the record's candidate target keys. A configured endpoint with no recorded
entry reports the server as `not_observed`. Then the recorded tool names go to
`check_tools` with the same batching, limits and signed responses as `status`:
without a key, one all-or-nothing public MCP goal covers the first five tools
and the rest are listed as `not checked` (with the free-key hint); with
`INTERFACEDELTA_AGENT_KEY`, REST batches of at most 50 tools each.

The default human table shows, per tool, only the fields the goal summary gives: changed,
breaking since start, stale, not observed, removed, requires sign-in, asks for
payment, declared paid, moves money, deletes, sends messages. No verdicts,
scores, or safety words. Without `--since`, the start time is the earliest
first retained observation among the checked servers ("since first observed",
as far as the record's bounded history goes).

`--json` prints `interfacedelta-agent-check-v1`: the configs read, the start
time and its source, per-server status with the recorded endpoint, per-tool
flags, and every signed goal response embedded complete and unmodified
(keyless responses include the unsigned `quota`). `--sarif <file>` writes
SARIF 2.1.0 for code scanning, one result per fact, anchored to the config
file. `--fail-on <list>` takes `breaking`, `changed`, `stale`, `payment`,
`money`, `not_observed` and exits 1 when any listed condition's returned count
is positive (`not_observed` also counts servers with no record entry).

The JSON envelope has these stable fields:

| Field                         | Shape and meaning                                                                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `formatVersion`, `cliVersion` | `interfacedelta-agent-check-v1` and the CLI version                                                                                                                                                           |
| `configs`                     | Config file paths read, in search order                                                                                                                                                                       |
| `sinceTime`, `sinceSource`    | UTC timestamp or null; `--since` or `first-observed`                                                                                                                                                          |
| `transport`                   | `mcp-public` or `rest`                                                                                                                                                                                        |
| `keylessLimit`                | null, or `{limit, checked, unchecked}` when tools are skipped                                                                                                                                                 |
| `summary`                     | Sum of returned goal counts: `checked`, `changedSinceStart`, `breakingSinceStart`, `notObserved`, `stale`, `movesMoneyOrDeletes`, `asksForPayment`; `declaredPaid` is present only when all answers supply it |
| `servers`                     | `{name, config, kind, status, target}` with optional `reason`, `recordedEndpoint`, `firstObservedAt`, `tools`                                                                                                 |
| `goalResponses`               | Ordered `{transport, goal, quota?}` entries containing each complete original signed goal; quota is unsigned                                                                                                  |

Server `kind` is `remote` or `stdio`; `status` is `checked`, `not_observed`,
`not_checkable` or `not_checkable_local`. `target` is the display URL with
credential components removed, or the command basename. Each tool has `name`,
`status` (`observed`, `not_observed`, `removed`, `requires_sign_in`, or
`not_checked`), boolean `changed`, `breakingSinceStart`, `stale`,
`asksForPayment`, `declaredPaid`, `movesMoney`, `deletes`, `sendsMessages`, and
an optional complete signed `check`. False flags on `not_checked` tools are
placeholders, not observations. `breakingSinceStart` per tool reflects its
latest recorded breaking change; the returned goal count can include earlier
breaking changes. The complete embedded objects retain unknown fields and
signatures; the outer envelope and derived flags are unsigned.

Exit codes: 0 no condition matched; 1 a `--fail-on` condition matched; 2
usage/config errors (missing, malformed or empty config, invalid `--since` or
`--fail-on`); 3 record unavailable (network, rate limit or server failure).
No condition is applied by default.

### Find stale lines in agent skills

`interfacedelta skills` checks agent instructions against InterfaceDelta's stored
record. It reads the MCP tools in your project's baselines, fetches their signed
Record Checks through the same client as `status`, and finds exact, case-sensitive
mentions of their names and recorded input names. It never calls those servers or
prints instruction text.

```sh
interfacedelta skills
interfacedelta skills ./agent --include 'guides/**/*.md' --since 2026-11-01T00:00:00Z
interfacedelta skills --json --sarif skills.sarif --fail-on breaking_change,tool_removed,input_not_recorded
interfacedelta skills --mcp-config .mcp.json --dependencies .interfacedelta/dependencies.json
```

The default files are `**/SKILL.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`,
`.cursor/rules/**`, `.github/copilot-instructions.md`, `.claude/skills/**` and
`prompts/**/*.md`, including these layouts in nested projects. Repeat `--include`
to add root-relative globs using `*`, `**` and `?`. Quote globs so your shell does
not expand them. The directory defaults to `.`; `--dependencies` and `--mcp-config`
paths are relative to your current working directory.

An MCP config may use `mcpServers` or `servers`. Only server `url` fields are used;
commands, arguments, headers and environment entries are ignored. URLs must be
HTTPS without credentials, query or fragment. Each config URL needs a baseline
inventory to supply its tool names; an unmatched URL is a configuration error.
Stdio definitions are ignored. No server is started and no sign-in is performed.

The table reports `path:line`, matched term, tool, endpoint and reasons:

| Reason               | Recorded fact                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `tool_changed_since` | The record says the tool changed since `--since`, or its baseline's creation time.                                  |
| `breaking_change`    | The latest recorded change is breaking and at or after that start time.                                             |
| `tool_removed`       | Record Check returns `removed`.                                                                                     |
| `input_not_recorded` | A signed last-change detail explicitly names a removed or renamed input that is absent from the current input list. |
| `asks_for_payment`   | An HTTP 402 payment challenge was observed.                                                                         |
| `not_observed`       | The record has not observed the tool, or requires sign-in.                                                          |

The current signed API exposes input names and the latest change's date and class,
not removed or renamed input names. The command does not guess missing names or
infer renames. It supports `change.last.removedInputs` (string array) and
`change.last.renamedInputs` (`{from,to}` array) only if a signed answer supplies
those optional details. Unknown identifiers in instructions are not findings.
Input names can occur in unrelated prose or refer to another tool: a location is
an exact mention, not proof of a tool call or an invalid instruction.

`--json` returns one `interfacedelta-skills-v1` object with `truncated`, `filesRead`,
`bytesRead`, `checked` (`endpoint`, `tool`, `sinceTime`), `mentions` (`path`, `line`,
`term`, `tool`, `endpoint`, `why`) and `signedAnswers`. Each `signedAnswers` entry is
the **verbatim JSON response string** for one batch, including signatures; parse
that string to verify the signed answer as described under `status`. Derived
locations and reasons are local output, not signed evidence. Keyless entries
include the MCP result wrapper and quota. `--sarif <file>` also writes SARIF 2.1.0
with the instruction file and line for each reason.

Without `--fail-on`, this is report only. A comma-separated list of the above
reasons returns **1** when a matching local mention exists. Exit **0** means no
threshold matched, **2** means usage or configuration error, and **3** means the
record is unavailable. The client uses keyless `check_tools` for at most five
tools with a shared start time, or `INTERFACEDELTA_AGENT_KEY` for REST batches of 50. `--api-url` has the same rules as `status`. Duplicate endpoint/tool pairs use
the earliest baseline time. No recorded change is not proof of no change; the
latest change may not include earlier breaking changes.

The finder shares `check --find-uses`'s directory exclusions and symlink-safe
walker: no symlinks, build outputs, dependencies, or `.interfacedelta` contents.
It reads at most 20,000 candidate files and 64 MiB; files larger than 1 MiB and
binary files are skipped. It keeps at most 20 locations per tool and 200 total.
A reached cap with omitted work sets `truncated: true`. A partial byte-budget read
searches complete lines only. The exported `findSkillFiles` and `scanSkillFiles`
APIs reuse these boundaries and return metadata without file contents.

### Cite the source version a skill was written for

Pin the tool definition or versioned source you used when writing a skill or instruction file:

```sh
interfacedelta cite https://weather.example/mcp get_forecast --file SKILL.md
interfacedelta citations . --fail-on changed,removed,malformed,signature_invalid
interfacedelta citations . --json --sarif citations.sarif
```

`cite` verifies the current signed Record Check, saves the answer and published
public keys in `.interfacedelta/citations/` beside the skill file, and inserts an
invisible HTML comment at its top. With no `--file`, it prints the comment and
saves the evidence in the working directory. Updates preserve the rest of the
file, including CRLF. Commit the evidence and keys alongside the skill.

`citations` finds those comments using the same files and `--include` globs as
`skills`; no baselines are needed. It verifies retained answers offline, then
compares each cited fingerprint with the current stored record. It reports
`current`, `changed` (with the latest recorded class/date when available),
`removed`, `not_observed`, `malformed` or `signature_invalid`. It never prints
instruction lines or calls the cited tool. Keyless checks cover five distinct
tools; `INTERFACEDELTA_AGENT_KEY` enables REST batches of 50.

**Experimental source kinds** extend v1 with `file`, `url` and `git`. Omitted
`kind` still means `mcp-tool`; existing tool citations keep their meaning.
Every kind accepts optional `checked` and `label` metadata.

```sh
interfacedelta cite --file-source docs/research.md --file SKILL.md
interfacedelta cite --url 'https://sources.example/paper?v=2' --file SKILL.md
interfacedelta cite --git 'https://code.example/project.git@cccccccccccccccccccccccccccccccccccccccc:docs/spec.md' --file SKILL.md
interfacedelta citations . --fetch --fail-on changed,missing,unreachable,malformed
```

File sources pin SHA-256 of exact bytes and check offline. Paths are relative to
the checkout root; traversal and symlinks are rejected. `cite --url` fetches once
to pin response bytes. URL checking requires `citations --fetch`: anonymous HTTPS
GETs, up to 3 HTTPS redirects, 10 MiB and 15 seconds per source, concurrency 4,
with a CLI User-Agent. Fetched content is never printed or saved. Git pins require
a full 40- or 64-digit commit; they remain syntax-only even with `--fetch`.
Non-tool results are `current`, `changed`, `missing`, `unreachable`,
`not_checked` or `malformed`. Without `--fetch`, URL/Git pins are `not_checked`.

Default output is report only. `--fail-on` accepts `changed`, `removed`,
`malformed`, `signature_invalid`, `missing`, `unreachable` and `not_checked`
for exit 1; configuration failures return 2 and record failures return 3. JSON
uses `interfacedelta-citations-v1`; SARIF locations are relative to the scan root.
Answer paths are relative to each skill file; `--keys <file>` supplies a separate
trusted published keys file relative to the scan root. Protect that trust input
through review. A matching fingerprint does not prove instructions are correct.

The Action's `citations: 'true'` mode is off by default. Set `check: 'false'` for a
citations-only job and `citations-fail-on` for its threshold. It saves
`.interfacedelta/citations.sarif` for a separate SARIF upload step. See the
[v1 format, verification rules and Action example](docs/skill-citations.md).

## Decision rules, owners and acceptances

The dependencies file is also the repository's agent lockfile: it says what the team decided to do about each kind of change, and who acts on it. Every change gets one decision, `block`, `warn` or `allow`, plus the owner, the attention level, the domains (`product`, `security_compliance`, `finance`) and the next step from InterfaceDelta's decision cards. A run fails when any decision blocks.

```json
{
  "formatVersion": "interfacedelta-dependencies-v1",
  "failOn": "breaking",
  "owner": "@acme/platform",
  "dependencies": [
    {
      "name": "github",
      "url": "https://api.githubcopilot.com",
      "mcpEndpoint": "https://api.githubcopilot.com/mcp/",
      "baseline": "github.json",
      "owner": "@acme/devtools"
    }
  ],
  "rules": [
    {
      "id": "pr-tools",
      "when": { "dependency": "github", "name": "create_*" },
      "then": "block",
      "owner": "@acme/release",
      "note": "The release agent opens pull requests."
    },
    {
      "id": "tool-text",
      "when": { "code": "CAPABILITY_METADATA_CHANGED" },
      "then": "block",
      "owner": "@acme/security"
    },
    {
      "id": "payments",
      "when": { "domain": "finance" },
      "then": "block",
      "owner": "@acme/finance"
    },
    {
      "id": "github-additions",
      "when": { "dependency": "github", "classification": "non_breaking" },
      "then": "allow"
    }
  ],
  "accepted": [
    {
      "dependency": "github",
      "change": "change:4f0c…",
      "reason": "Migrating to get_user",
      "expires": "2026-11-09",
      "by": "@alice"
    }
  ]
}
```

- A decision comes from, in order: an unexpired acceptance of that exact change; the first rule whose `when` matches; otherwise the `failOn` policy (matching changes block, other breaking and indeterminate changes warn, the rest are allowed).
- `when` fields: `dependency`, `classification`, `code` (any compatibility change code), `domain`, and `name` (a capability name or endpoint URL; `*` matches any run of characters). Each takes one value or a list; every field given must match. An empty `when` matches everything, and a rule after it is refused because it could never match.
- Owners are handles or team names such as `@acme/payments` (letters, digits, `.`, `_`, `-`, `/`, optional leading `@`): a rule's `owner`, else the dependency's, else the file's. Nothing is assigned or notified; the CLI and Action report them.
- `name` matches the capability a change is about, including schema and parameter changes (an MCP tool's input schema, an OpenAPI operation's parameter).
- Rules decide what blocks; the reports follow the decisions. Blocked changes are errors, warned ones warnings, and accepted ones notes in SARIF; other allowed changes are left out of the terminal list, annotations and SARIF.
- Typos fail fast: unknown dependencies, change codes, domains, duplicate rule ids and unknown fields are configuration errors.

Accepting a blocked change: `check` prints the command for each blocked change.

```sh
interfacedelta accept github change:4f0c… --reason "Migrating to get_user" --days 14 --by @alice
```

It adds the acceptance to the dependencies file (rewritten as two-space JSON); commit it. An acceptance covers that exact change only: if the service changes again, the new change is decided afresh. Acceptances last at most a year; for a permanent decision write an `allow` rule. An expired acceptance, or one that no longer matches any change, is reported so it can be removed. `baseline` keeps existing files unless `--force` is given, so adding a dependency and rerunning writes only the new baseline.

## Services that need sign-in

Many MCP servers list their tools only to a signed-in client. For servers that accept a static bearer token (for example a GitHub personal access token or a Stripe restricted key), bind the token to the server's origin when you run the CLI:

```sh
export INTERFACEDELTA_TOKEN_GITHUB=...   # from your secret store
interfacedelta check --token https://api.githubcopilot.com=INTERFACEDELTA_TOKEN_GITHUB
```

The binding is `<https-origin>=INTERFACEDELTA_TOKEN_<NAME>`, or `<mcp-endpoint-url>=INTERFACEDELTA_TOKEN_<NAME>` to allow one exact endpoint (prefer this on hosts that serve many tenants under one origin), and can be repeated. It comes only from the command line (or the Action's `tokens` input), never from a repository file, so a repository you check cannot choose which secret is read or where it is sent. Variables must start with `INTERFACEDELTA_TOKEN_`.

A dependency uses the token when its explicit `mcpEndpoint` is the bound endpoint or on the bound origin. A binding that no explicit endpoint matches is a configuration error (exit `2`), so a mistyped origin or a missing `--mcp-endpoint` never produces a quiet public baseline. The token:

- is sent as `Authorization: Bearer` to that MCP endpoint only: never to discovery documents, pages, server cards, other origins, or any redirect target;
- is used for the same passive list calls as without it (no tool calls);
- is kept out of baselines, JSON, SARIF and terminal output. A file that would contain it (because the service echoed it verbatim) is refused, and terminal text replaces it with `***`. This guard matches the exact value only, so a service that echoes an encoded or partial copy is not caught.

Use a token with the narrowest read scope the service offers. OAuth-only servers that need an interactive sign-in are not supported. If the endpoint redirects, set `mcpEndpoint` to the final URL: a redirected request reaches its target without the token, so the CLI refuses it.

Access change codes such as `ACCESS_BECAME_PUBLICLY_OBSERVABLE` are named for public observations. In a signed-in check, an access change (`ACCESS_*`) on the endpoint the token was sent to says so in its explanation ("Observed signed in with the configured token, not as public access"), in the terminal, SARIF and Action annotations; the JSON result carries `authenticated: true` and marks that endpoint's subject `signedIn`. Other endpoints were observed publicly. The classification (breaking or not) is unaffected.

A baseline records whether it was taken signed in, and `check` refuses to compare a signed-in baseline with a public view or the reverse. The signed-in view can include your account's private tool names and descriptions; keep such baselines in a private repository.

The signed-in check passes only when the endpoint answers as a working MCP server. A missing variable, a token the endpoint refuses (HTTP 400 `invalid_token`, 401 or 403), any other HTTP error from the endpoint, a redirected endpoint, or a token that was never sent is a `credentials` error: exit `2`, even with `--on-error warn`. An endpoint that does not answer at all is an inspection error, which `--on-error warn` may downgrade. In a GitHub Actions run for a pull request that receives no secrets (from a fork, a deleted fork, or Dependabot), `check` skips those targets with a warning: they are not checked and never fail the run (a run where every target was skipped reports passed, with the skipped count shown). `inspect` and `baseline` exit `2` there, since they cannot produce anything.

## Commands

```sh
interfacedelta inspect <url> [--mcp-endpoint <url>] [--token <binding>] [--json] [--output <file>]
interfacedelta baseline <url> --output <file> [--mcp-endpoint <url>] [--token <binding>] [--force]
interfacedelta baseline [--dependencies <file>] [--only <name>] [--token <binding>] [--force]
interfacedelta check <url> --baseline <file> [--mcp-endpoint <url>] [options]
interfacedelta check [--dependencies <file>] [options]
interfacedelta accept <dependency> <change-id> --reason <text> (--days <n> | --expires <YYYY-MM-DD>) [--by <who>] [--dependencies <file>]
interfacedelta watch [--dependencies <file>] [--repository <owner/name>] [--ref <branch>] [--force] [--json]
interfacedelta watch --off [--repository <owner/name>] [--ref <branch>]
interfacedelta agent-check [path] [--config <file>] [--include-user-configs] [--since <RFC3339>] [--fail-on <list>] [--json] [--sarif <file>] [--api-url <url>]
interfacedelta version
```

Check options:

- `--fail-on` takes a comma-separated list. `breaking` is the default. `non_breaking`, `indeterminate` and `informational` select those classifications. `metadata` selects changed publisher text and other non-contract metadata on a capability (names, titles, descriptions), which is where tool-description poisoning appears; those changes are classified `informational`, so they fail only when you select `metadata` or `informational`.
- `--on-error fail|warn`. With `warn`, a dependency that cannot be inspected (network failure, timeout, server error) is reported but does not fail the run. Configuration errors (missing or malformed baseline, scope mismatch), credential errors and unexpected internal errors always fail.
- `--json` prints the result as JSON on stdout: `interfacedelta-check-v2` for one URL, `interfacedelta-check-set-v1` for a dependencies file.
- `--sarif <file>` also writes SARIF 2.1.0 for GitHub code scanning. Each result is anchored to the dependency's baseline file and carries a stable fingerprint.
- `--find-uses [dir]` also searches a directory (default: the current one) for likely uses of the names each blocked or warned change touched: tool, prompt and resource names, and the last segment of a changed field path, matched case-sensitively as whole identifiers. The human output gains a "Likely uses" block per change (`path:line term`), and `--json` gains an additive `likelyUses` field next to `decisions`. These are hints, never proof: the scan skips dependency, build and tool directories and symlinks, reads only text files under 1 MiB, stops at 20,000 files or 64 MiB read, and never reports line text. Off by default.

Exit codes are stable: `0` success or policy pass, `1` policy failure, `2` usage, configuration or baseline error, `3` inspection failure. For a dependencies file the highest applies in the order 2, 3 (unless `--on-error warn`), 1.

## Connected repositories (Pro and Team)

Create a **watch token** in [Routing → Watch tokens](https://interfacedelta.com/routing#delivery-tokens) for your repository and branch with `lockfiles:write`. Set its value in the CLI’s existing `INTERFACEDELTA_API_TOKEN` environment variable; in the Action, store it as `INTERFACEDELTA_WATCH_TOKEN` and pass it through `api-token`. Account’s REST API tokens do not grant repository connections.

`check` decides changes when CI runs. `watch` hands the same dependencies file to hosted InterfaceDelta, which checks every dependency continuously, decides each change with the file's own rules, owners and acceptances, and delivers the decision to the owner's channel (Slack, a signed webhook, a GitHub issue or email) before the next build breaks.

```sh
export INTERFACEDELTA_API_TOKEN=...   # a watch token from Routing → Watch tokens, with lockfiles:write
interfacedelta watch
```

Run it on your default branch after the file changes, for example in the same workflow as `check`. The file is validated locally with the same rules as `check` before anything is sent; baselines stay in your repository and are not uploaded, because the hosted service observes each dependency itself (publicly, so a dependency checked signed in with `--token` may look different there).

The repository and branch come from `--repository` and `--ref`, else from GitHub Actions (`GITHUB_REPOSITORY`, `GITHUB_REF_NAME`), else from the clone's `origin` and current branch. A run on a commit older than the one already watched is skipped, so a slow CI run never restores a removed dependency: the CLI checks that the watched commit is an ancestor of the current one with Git, or, in a shallow GitHub Actions checkout, with the GitHub compare API and the job's `GITHUB_TOKEN`. When neither can tell, use `actions/checkout` with `fetch-depth: 0`, or pass `--force` to replace the watched file anyway. The service applies each sync atomically; if another sync lands first, `watch` rereads and retries once.

`watch --off` disconnects the repository; earlier decisions stay in your history. Plan limits apply: a file whose dependencies would exceed your followed-service limit is refused whole, with the counts, and nothing changes. `--json` prints `interfacedelta-watch-v1`.

## Baselines

Baseline files use `interfacedelta-baseline-v2`. They record the canonical Passport (`0.5.0`, `0.6.0` or `0.7.0`), the target scope, the URL the CLI inspected and the validated semantic fingerprint. Baselines from earlier CLI versions are refused with exit code `2`; regenerate them with `interfacedelta baseline`. `check` refuses a baseline made for a different origin, MCP endpoint, watched page or protocol URL.

A service URL with a path (for example `https://service.example/checkout`) watches that page, as hosted InterfaceDelta does: the page's declarative WebMCP forms enter the Passport and the baseline is bound to that page. Paths that look like they carry credentials are refused.

Publisher-provided metadata may include names, descriptions, email-like strings, or other personal information; review it before committing a baseline.

`ci-policy-v2` answers whether deterministic classifications match the configured selectors. It is not a safety, security, trust, risk, compliance, or certification score.

## What the CLI sees

For `inspect`, `baseline`, `check` and policy checks, network behavior is the same constrained scanner used by hosted InterfaceDelta: public HTTPS/443 only, DNS classification and connection pinning, TLS hostname verification, bounded redirects/bodies/requests, no credentials except a bearer token you bind to an MCP server's origin, and passive MCP methods only (`server/discover`, `initialize`, `notifications/initialized`, `tools/list`, `resources/list`, `prompts/list`). It identifies itself as `InterfaceDelta-CLI/<version>` in its user agent and MCP client info. It also reads declarative WebMCP form markup from the origin root page and from a watched page, without running scripts or submitting forms. These inspection commands never call tools, read resources, get prompts, perform OAuth, pay or send payment headers, or enable interactive MCP features. `status` calls only the hosted record read tool or REST goal endpoint described above. Without a bound token, services that require sign-in show only what they publish publicly.

Human output lists every Passport protocol (ARD, A2A, MCP, OpenAPI and experimental WebMCP) and its capability counts. A `Declared` section appears only when there is something to report: MCP tools declaring an MCP Apps UI (never fetched), OpenAPI operations declaring payment (publisher-declared, not verified, nothing paid; no prices are shown) and MCP endpoints that answered HTTP 402. `check` lists up to ten changes per target, each with a deterministic explanation where the retained evidence supports one. For example:

```text
InterfaceDelta compatibility check

Target: https://service.example/
Comparison: changed
Breaking: 1
…
Result: FAILED

Changes
- BLOCK breaking MCP_TOOL_INPUT_SCHEMA_CHANGED mcp.tool create_order — “currency” is now required; before, it could be omitted.
    next: Compare the new input requirements with what your client sends.
```

Human output removes terminal escape/control sequences and bounds remote strings. JSON output uses deterministic serialization with control characters escaped.

## Hosted InterfaceDelta

The CLI compares a current observation with a baseline in your repository. Hosted InterfaceDelta records recurring observations over time and adds what the CLI does not: followed services and email alerts, decision cards on each followed service with AI-written notes, payment-terms and payee-change rules over retained 402 challenges, and the public atlas.

## Export a dependency policy

```sh
interfacedelta policy export --format generic --out policy.json
interfacedelta policy export --format github --include passing --out github-policy.json
interfacedelta policy export --format generic --no-check
```

The command loads `.interfacedelta/dependencies.json` and runs the same live
compatibility checks as `check`, including rules and unexpired acceptances.
`--dependencies <file>`, `--fail-on`, `--on-error` and repeated `--token` bindings
work as they do for `check`. Without `--out`, JSON goes to stdout. An output file
must not already exist. The policy is written even when checks fail; exit codes
remain 0 for passing, 1 for policy failure, 2 for configuration/credential errors,
and 3 for inspection/internal errors, with the same on-error and fork behavior as
`check`.

The generic format is `interfacedelta-allowlist-v1`, with `generatedFrom`,
`servers` and `excluded`. Servers carry a name, protocol, URL, `decision: allow`
and reasons. `--include passing` is the default. Failed or unchecked
URLs always go to `excluded`, including when another entry for that URL passes.
The legacy `--include all` spelling does not bypass this exclusion. Exclusions carry
`decision: review` and reasons. Warnings, errors and blocked changes need review.
An allowed entry means the configured compatibility check passed.

The GitHub export contains `generatedFrom`, `managedSettings` and `excluded`.
Copy **only `managedSettings`** into `copilot/managed-settings.json` in the
enterprise source organization's `.github-private` repository. It contains
`allowedMcpServers: [{ "serverUrl": "https://example.com/mcp" }]`, following
[GitHub's managed settings reference](https://docs.github.com/en/copilot/reference/enterprise-administrators/enterprise-managed-settings).
Both include modes permit only passing entries with an explicit MCP endpoint
(or explicit MCP protocol for library callers). Wildcard URLs are excluded;
matchers are exact URLs. An empty allowlist permits no matched servers. Review
the export before installing it; the command does not change enterprise settings.

`--no-check` reads only the dependencies file, without network requests or
baseline reads. Every entry has decision `review` and reason `not-checked`;
`--include passing` therefore exports no servers, and GitHub exports an empty
allowlist. Check options cannot be combined with `--no-check`.
