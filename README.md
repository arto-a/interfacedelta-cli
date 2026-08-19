# InterfaceDelta CLI

InterfaceDelta inspects public HTTPS agent interfaces locally, creates a deliberate canonical Passport baseline, and checks current observations with deterministic compatibility rules. The CLI does not call the hosted InterfaceDelta API, upload baselines, create monitors, accept credentials, or send telemetry.

The initial package is `interfacedelta` 0.1.0 and requires Node.js 22 or newer. Until npm publication completes, install from a reviewed local package artifact; after publication use:

```sh
npm install -g interfacedelta
interfacedelta version
npx interfacedelta inspect https://service.example
```

## Commands

```sh
interfacedelta inspect https://service.example [--mcp-endpoint https://service.example/mcp] [--json]
interfacedelta baseline https://service.example --output .interfacedelta/passport.json
interfacedelta check https://service.example --baseline .interfacedelta/passport.json
interfacedelta check https://service.example --baseline .interfacedelta/passport.json --fail-on breaking,indeterminate
interfacedelta version
```

Baseline files use `interfacedelta-baseline-v1`. They include the canonical Passport, target scope, and validated semantic fingerprint. Existing output is refused unless `--force` is deliberate. Publisher-provided metadata may include names, descriptions, email-like strings, or other personal information; review it before committing a baseline.

`ci-policy-v1` fails on `breaking` by default. `indeterminate`, `non_breaking`, and `informational` pass; `indeterminate` can be opted into failure. This gate answers whether deterministic classifications violate configured policy. It is not a safety, security, trust, risk, compliance, or certification score.

Exit codes are stable: `0` success/policy pass, `1` valid policy failure, `2` usage/configuration/baseline error, and `3` inspection/internal execution failure.

Network behavior is the same constrained scanner used by hosted InterfaceDelta: public HTTPS/443 only, DNS classification and connection pinning, TLS hostname verification, bounded redirects/bodies/requests, no credentials, and passive MCP methods only (`server/discover`, `initialize`, `notifications/initialized`, `tools/list`, `resources/list`, `prompts/list`). It never calls tools, reads resources, gets prompts, performs OAuth, or enables interactive MCP features.

Human output removes terminal escape/control sequences and bounds remote strings. JSON uses deterministic serialization with control characters escaped.

Hosted monitoring remains distinct: the CLI compares a current observation with a baseline in your repository, while hosted InterfaceDelta records recurring public observations over time.

## Publishing status

The initial `0.1.0` package was published through an interactive, policy-compliant manual release. The repository includes a tokenless OIDC workflow, but npm trusted-publisher configuration is currently deferred and the workflow is deliberately manual and gated. It is not operational until the trusted-publisher relationship is configured.

Future releases require either repairing the maintainer account's WebAuthn/passkey flow and configuring the existing OIDC publisher, or a separately human-approved temporary manual method that complies with npm policy at that time. This project does not use or recommend a permanent token-based publishing workflow.
