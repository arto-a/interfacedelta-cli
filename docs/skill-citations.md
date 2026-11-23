# Versioned source citations v1

A tool citation pins the Record Check fingerprint the author used when writing instructions for an MCP tool. It records a version of the stored tool definition; it does not establish that instructions are correct, observations are fresh, or a tool will behave as declared.

```sh
interfacedelta cite https://weather.example/mcp get_forecast --file SKILL.md
interfacedelta citations . --fail-on changed,removed,malformed,signature_invalid
interfacedelta citations . --json --sarif citations.sarif
```

The original tool form of `cite` uses the signed Record Check client. It never contacts the cited endpoint or calls the cited tool. Without `INTERFACEDELTA_AGENT_KEY`, it uses the public keyless MCP allowance; with a key, it uses REST. The same quotas, batch limits and `--api-url` rules as `status` apply. No inference runs.

## Format

Format v1 is additive. With no `kind`, a citation is `kind="mcp-tool"` and retains its signed tool meaning and original spelling. Explicit `kind="mcp-tool"` is also accepted. The non-tool kinds below are **experimental**.

One HTML comment per endpoint/tool pair, invisible when Markdown renders:

```markdown
<!-- interfacedelta:cite endpoint="https://weather.example/mcp" tool="get_forecast" fingerprint="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" checked="2026-11-22" answer=".interfacedelta/citations/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json" -->
```

For tools, the required attributes are `endpoint`, `tool`, and `fingerprint`; `answer`, `kind`, `checked`, and `label` are optional. Existing citations and tool writer output retain their original spelling. As of the additive source extension, `checked` is optional for every kind. Attribute order is free, names are case sensitive, and values must have matching single or double quotes. Duplicate, unknown or missing attributes are malformed. No HTML entity decoding occurs. The writer uses double quotes, except for labels containing double quotes, which use single quotes. There is no quote escaping; a value cannot contain its enclosing quote.

- `endpoint`: absolute HTTPS URL, at most 2048 characters, without credentials, query, fragment, whitespace, backslashes, quotes, angle brackets or controls. Query-bearing endpoints are deliberately excluded to keep credentials out of committed instructions.
- `tool`: exact name, 1–128 characters, without quotes, angle brackets or controls.
- `fingerprint`: `sha256:` followed by exactly 64 hexadecimal digits. Comparison ignores hex case. Record Check's bare 64-digit fingerprints are normalized to this prefixed spelling without changing the signed answer.
- `checked` (all kinds, optional): real calendar date in `YYYY-MM-DD`, representing the author's UTC check date. It is local metadata, not a signed or independent timestamp.
- `answer`: a contained file path relative to the instruction file's directory, with `/` separators. Absolute paths, empty components, `.` or `..`, URL schemes, colons, backslashes, quotes, angle brackets and controls are rejected. It is never fetched as a URL.
- `label` (all kinds, optional): up to 120 Unicode characters, without `--`, `>`, or controls. Labels are local display metadata, not signed fields.

Every `<!-- interfacedelta:cite` marker is parsed, including broken or unclosed comments. Malformed markers are reported with a path and line; their text is never printed. Examples in scanned instructions count as citations too.

## Experimental file, URL and Git sources

These kinds pin other versioned sources, such as papers, datasets, web pages, documents in this checkout, and other repositories. They do not use Record Check, signatures, API keys, or model calls.

| Kind   | Required attributes             | Optional attributes        |
| ------ | ------------------------------- | -------------------------- |
| `file` | `kind="file"`, `path`, `sha256` | `checked`, `label`         |
| `url`  | `kind="url"`, `uri`, `sha256`   | `checked`, `label`         |
| `git`  | `kind="git"`, `repo`, `commit`  | `path`, `checked`, `label` |

`sha256` is exactly 64 hexadecimal digits without a prefix; comparison ignores hex case. File and Git paths use the same contained path grammar as `answer`: no absolute paths, traversal, empty components, backslashes, colons, quotes, angle brackets or controls. `uri` and `repo` are absolute HTTPS URLs of at most 2048 characters, with no URL credentials, whitespace, backslashes, quotes, angle brackets or controls. Public query strings are allowed; do not put credentials in queries. Unknown, duplicate, unquoted, missing or wrong-kind attributes are malformed.

```markdown
<!-- interfacedelta:cite kind="file" path="docs/research.md" sha256="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" label="Research notes" -->
<!-- interfacedelta:cite kind="url" uri="https://sources.example/paper?v=2" sha256="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" checked="2026-11-22" -->
<!-- interfacedelta:cite kind="git" repo="https://code.example/project.git" commit="cccccccccccccccccccccccccccccccccccccccc" path="docs/spec.md" -->
```

```sh
interfacedelta cite --file-source docs/research.md --file skills/review/SKILL.md
interfacedelta cite --url 'https://sources.example/paper?v=2' --file SKILL.md
interfacedelta cite --git 'https://code.example/project.git@cccccccccccccccccccccccccccccccccccccccc:docs/spec.md' --file SKILL.md
interfacedelta citations . --fetch --fail-on changed,missing,unreachable,malformed
```

File sources are checked offline by hashing the exact file bytes, including binary data, with bounded memory and a 10 MiB size cap, matching URL sources. Larger files report `unreachable` with reason `too_large` before their contents are read. `path` is relative to the checkout root (nearest ancestor containing `.git`), including when the command runs or scans in a subdirectory. If an ancestor cannot be read, checkout discovery falls back to the scan root. Outside a Git checkout, the root is the working directory for `cite`, or the scan directory for `citations`. Every source path component must stay inside that root; symlinks and special files are rejected as `malformed`. Files absent at check time are `missing`; unreadable or concurrently changing files are `unreachable`. Coordinate writes to sources during checks.

`cite --url` makes one bounded source retrieval to compute the hash, following up to three redirects. `citations` contacts cited URLs **only with `--fetch`**; otherwise their status is `not_checked`. Each retrieval uses anonymous plain HTTPS GETs, including redirects: no URL credentials, Authorization header, cookies, API key, or sign-in. It sends `User-Agent: interfacedelta-cli/0.8.0`. Limits are three redirects, all HTTPS, 10 MiB of response body bytes, and 15 seconds total per source (headers, redirects and body). Checks use at most four concurrent source retrievals. A relative redirect is resolved against the previous URL and checked again. The initial host and every redirect are resolved afresh; every returned address must be public. Loopback, RFC 1918 private, CGNAT, link-local, unique-local, unspecified, multicast and their IPv4-mapped forms, plus metadata hostnames, are rejected without a source request. Each HTTPS connection is pinned to the checked address while retaining the original hostname for TLS verification; DNS rebinding cannot substitute another address. Rejections report `unreachable` with reason `blocked_non_public_address`, `blocked_metadata_hostname` or `dns_failed`. Error response bodies are discarded; 404/410 means `missing`, other HTTP errors, network failures, unsafe redirects and limits mean `unreachable`.

The URL hash covers exact response body bytes, with no text decoding, newline conversion or content normalization. The CLI requests `Accept-Encoding: identity` and rejects a response with a different content encoding as `unreachable`, so the stored hash remains independent of transport decompression. Fetched contents are never printed or saved. A matching hash says nothing about the source's trustworthiness or the correctness of instructions based on it.

Git commits must be exactly 40 or 64 hexadecimal digits, never a branch, tag or abbreviated SHA. Git checking is **syntax-only, even with `--fetch`**: the status is `not_checked`. There is no portable plain HTTPS GET endpoint to verify commits across arbitrary hosts. The CLI never clones, runs git, retrieves a Git path, or claims to have confirmed the commit exists.

All writers print the comment, write `checked` as the current UTC date, and optionally insert it with `--file`. Non-tool writers do not store signed evidence, keys or fetched contents. Updates match a file's path, a URL's exact URI, or a Git repository plus optional path; updating the pin replaces that source's old comment. Repeated writes with identical bytes/pin and date are byte-identical, preserve unrelated text/citations and CRLF/BOM, and refuse files with malformed markers. `--file-source`, `--url`, `--git` and tool positionals are mutually exclusive. `--file` remains the destination instruction file.

## Writing and evidence for tools

`cite` requires an observed tool and a valid fingerprint, obtains published public keys from `/api/v1/record/check/keys` on the selected InterfaceDelta origin, and verifies the detached Ed25519 JWS before saving anything. The tool identity must match the requested endpoint and name.

The stored file is the complete signed tool answer, canonically serialized, with only the goal's unsigned `changedSinceTime` sibling removed. Its filename is the SHA-256 of those bytes including the final LF. With `--file`, `.interfacedelta/citations/` is beside that file; otherwise it is under the working directory. The public keys snapshot is saved as `keys.json` in that folder. Newly published keys are merged by `kid` and sorted by `kid`; previously retained kids are never dropped. Conflicting key material for an existing kid or an unreadable/malformed existing snapshot stops the write. Commit both the answer and keys if CI should verify the evidence offline. Previously stored answers remain available when a citation is updated.

`--file` inserts the citation at the top and replaces/moves only comments for the normalized endpoint and exact tool name, while retaining the supplied endpoint spelling. Other text stays byte-identical, including LF or CRLF and a UTF-8 BOM. Repeating a write with the same signed response and UTC date is byte-identical. A new signing time creates a different evidence file. Files with malformed markers must be repaired before `cite` updates them. Symlink or special-file instruction/evidence paths are rejected. The implementation uses the existing bounded local reader (1 MiB per file) and atomic file replacement; concurrent edits to the same file require coordination.

## Checking and verification

`citations [dir]` defaults to `.` and uses the same instruction finder, exclusions, symlink checks, file/byte caps and repeatable `--include <glob>` options as `skills`. It reads no dependency baseline. At most 200 citation results are kept by default; a capped scan reports `truncated: true` and warns in the table and SARIF.

When `answer` is present, its signature is verified locally against adjacent `keys.json`, or an explicit trusted `--keys <file>` relative to the scan root. The published format is `{ "keys": [<public Ed25519 JWK>, ...] }`. Verification requires `alg: EdDSA`, `typ: interfacedelta-record-check+jws`, an exact matching `kid`, an empty detached payload segment, and RFC 8785 canonicalization of every field except `signature`. It also binds the observed answer to the citation's endpoint, name and fingerprint. Missing, unreadable, oversized, malformed, mismatched or tampered evidence/keys produce `signature_invalid`; those entries do not consume current-record requests. No key URL supplied in a citation or answer is followed. The keys snapshot is the local trust input: protect it through review, or supply a separately maintained trusted file with `--keys`. Offline verification proves bytes against those keys, not their provenance or freshness.

Valid citations are deduplicated by normalized endpoint and exact tool name before fetching the current stored record. The shared `status` client limits a keyless invocation to five distinct tools, all-or-nothing; keyed checks batch up to 50. Tool-record requests go to InterfaceDelta, never to cited tool services. URL source retrieval remains separately opt-in with `--fetch`. A record outage stops the command with exit 3; it is not reported as a missing observation.

Tool entries keep their existing statuses:

| Status              | Meaning                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `current`           | Current observed fingerprint matches the citation.                                                                                               |
| `changed`           | Fingerprints differ. `changeClass` and `changedAt` carry the latest recorded change when supplied; they are omitted when no change was recorded. |
| `removed`           | Record Check reports the tool removed.                                                                                                           |
| `not_observed`      | Record Check reports not observed or requires sign-in.                                                                                           |
| `malformed`         | The local citation is invalid.                                                                                                                   |
| `signature_invalid` | Stored evidence could not be verified or did not match the citation.                                                                             |

The latest recorded change class/date is not necessarily the first change since the cited version. A missing recorded change does not prove no change. Citations without `answer` compare the asserted fingerprint but do not prove the author previously received it. Current-record responses use the shared signed status client; `citations` verifies retained evidence offline, while `cite` additionally verifies the newly fetched answer before retaining it.

Non-tool entries use `current` (bytes match), `changed` (bytes differ), `missing` (file absent or HTTP 404/410), `unreachable` (read/network/HTTP error or limit), `not_checked` (URL without `--fetch`, or any Git pin), or `malformed` (invalid syntax or unsafe file path).

## Outputs and exit codes

The tool-only table has location, tool, endpoint, status, change class and change date. For reports containing non-tool sources, the tool/endpoint headings become source/target; source is its label or kind. Tool-only table, JSON and SARIF goldens remain byte-identical. Line text never enters any output. `--json` emits:

```json
{
  "formatVersion": "interfacedelta-citations-v1",
  "truncated": false,
  "filesRead": 1,
  "bytesRead": 250,
  "toolsChecked": 1,
  "citations": [
    {
      "path": "SKILL.md",
      "line": 1,
      "status": "current",
      "citation": {
        "endpoint": "https://weather.example/mcp",
        "tool": "get_forecast",
        "fingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "checked": "2026-11-22"
      },
      "currentFingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  ]
}
```

`citation` holds the attributes for that kind and is omitted for malformed markers; parsed file citations rejected by filesystem checks retain their attributes. Rejected source checks may add a `reason`, also shown in the table and SARIF. File and fetched URL checks add `currentSha256` (bare hex) when bytes were hashed. `toolsChecked` still counts only distinct MCP tools; source reads are not included in the instruction scan byte counts. New SARIF rules appear only when a report has source results, preserving the original tool-only SARIF.

`signature` is `valid` or `invalid` only when evidence was referenced. `--sarif <file>` also saves SARIF 2.1.0 for non-current entries, using clean paths relative to the scan root, `/` separators and URI-encoded components. Relocating the checkout or selecting a different absolute scan root does not change those URIs. Truncation is an execution warning, not a synthetic citation.

Exit 0 means no requested threshold matched (report only by default). Exit 1 means a status selected by `--fail-on changed,removed,malformed,signature_invalid,missing,unreachable,not_checked` was found. Exit 2 means usage/configuration failure. Exit 3 means the current record or published keys were unavailable, or `cite` could not verify the current answer. Source checking failures are statuses, not command-wide exit 3 errors; `cite` source retrieval failures return 3 without modifying the destination. `not_observed` and truncation remain visible but are not fail-on selectors in v1.

## GitHub Action

```yaml
- uses: arto-a/interfacedelta-action@<release-commit-sha>
  id: citations
  with:
    check: 'false'
    citations: 'true'
    citations-fail-on: changed,removed,malformed,signature_invalid
# Optional separate SARIF upload, including after threshold failure:
- uses: github/codeql-action/upload-sarif@v3
  if: always()
  with:
    sarif_file: .interfacedelta/citations.sarif
    category: interfacedelta-citations
```

`citations` defaults to false. Optional inputs are `citations-dir` (inside `GITHUB_WORKSPACE`), `citations-include` (one glob per line), `citations-keys` (relative to that directory), `citations-fail-on`, and `api-url`. Set `INTERFACEDELTA_AGENT_KEY` in the step environment for keyed checks. The mode writes `.interfacedelta/citations.sarif`, sets `citations-sarif-path` and `citations-count`, and emits location-only review notices and a count summary. Action SARIF paths include the selected subdirectory relative to the checkout. The artifact is written before a threshold failure; upload is a separate step requiring code-scanning permissions. This mode does not require a GitHub upload token by itself.

The Action does not enable URL fetching. Its citation mode checks file sources offline and reports URL/Git sources as `not_checked`; the new fail-on statuses are accepted by `citations-fail-on`. Use the CLI with `--fetch` in an explicitly opted-in step for URL checking.
