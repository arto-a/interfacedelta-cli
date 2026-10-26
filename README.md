# InterfaceDelta CLI

InterfaceDelta checks the agent services your project depends on (MCP servers, A2A agents, OpenAPI services) for interface changes, and tells you deterministically whether each change is breaking. It inspects public HTTPS interfaces locally, compares them with baselines committed to your repository, and fails CI when a configured change appears. The CLI does not call the hosted InterfaceDelta API, upload baselines, create monitors, or send telemetry, and it sends a credential only when you bind one to an MCP server's origin on the command line.

The package is `interfacedelta` 0.2.0 and requires Node.js 22 or newer:

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
interfacedelta version
```

Check options:

- `--fail-on` takes a comma-separated list. `breaking` is the default. `non_breaking`, `indeterminate` and `informational` select those classifications. `metadata` selects changed publisher text and other non-contract metadata on a capability (names, titles, descriptions), which is where tool-description poisoning appears; those changes are classified `informational`, so they fail only when you select `metadata` or `informational`.
- `--on-error fail|warn`. With `warn`, a dependency that cannot be inspected (network failure, timeout, server error) is reported but does not fail the run. Configuration errors (missing or malformed baseline, scope mismatch), credential errors and unexpected internal errors always fail.
- `--json` prints the result as JSON on stdout: `interfacedelta-check-v2` for one URL, `interfacedelta-check-set-v1` for a dependencies file.
- `--sarif <file>` also writes SARIF 2.1.0 for GitHub code scanning. Each result is anchored to the dependency's baseline file and carries a stable fingerprint.

Exit codes are stable: `0` success or policy pass, `1` policy failure, `2` usage, configuration or baseline error, `3` inspection failure. For a dependencies file the highest applies in the order 2, 3 (unless `--on-error warn`), 1.

## Baselines

Baseline files use `interfacedelta-baseline-v2`. They record the canonical Passport (`0.5.0`), the target scope, the URL the CLI inspected and the validated semantic fingerprint. Baselines from earlier CLI versions are refused with exit code `2`; regenerate them with `interfacedelta baseline`. `check` refuses a baseline made for a different origin, MCP endpoint, watched page or protocol URL.

A service URL with a path (for example `https://service.example/checkout`) watches that page, as hosted InterfaceDelta does: the page's declarative WebMCP forms enter the Passport and the baseline is bound to that page. Paths that look like they carry credentials are refused.

Publisher-provided metadata may include names, descriptions, email-like strings, or other personal information; review it before committing a baseline.

`ci-policy-v2` answers whether deterministic classifications match the configured selectors. It is not a safety, security, trust, risk, compliance, or certification score.

## What the CLI sees

Network behavior is the same constrained scanner used by hosted InterfaceDelta: public HTTPS/443 only, DNS classification and connection pinning, TLS hostname verification, bounded redirects/bodies/requests, no credentials except a bearer token you bind to an MCP server's origin, and passive MCP methods only (`server/discover`, `initialize`, `notifications/initialized`, `tools/list`, `resources/list`, `prompts/list`). It identifies itself as `InterfaceDelta-CLI/<version>` in its user agent and MCP client info. It also reads declarative WebMCP form markup from the origin root page and from a watched page, without running scripts or submitting forms. It never calls tools, reads resources, gets prompts, performs OAuth, pays or sends payment headers, or enables interactive MCP features. Without a bound token, services that require sign-in show only what they publish publicly.

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

The CLI compares a current observation with a baseline in your repository. Hosted InterfaceDelta records recurring observations over time and adds what the CLI does not: monitors and email alerts, decision cards on each monitor with AI-written notes, payment-terms and payee-change rules over retained 402 challenges, and the public atlas.
