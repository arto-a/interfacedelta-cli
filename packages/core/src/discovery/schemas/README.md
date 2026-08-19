# Vendored validation artifacts

These files are pinned for deterministic, offline runtime validation. The referenced upstream repositories distribute these artifacts under Apache License 2.0. No upstream copyright or notice block was present inside the JSON artifacts; provenance and license are recorded here and in `docs/standards/`.

`ard-ai-catalog.schema.json` is an exact copy of `ards-project/ard-spec` revision `5fa2f5aef790b478319f6a3b43adf4661b0ed0e0`, path `spec/schemas/ai-catalog.schema.json`, SHA-256 `c55238483a4738e08b250bdd6af1f4dc05a91afe882c649d224d09c19cd8fe09`.

`a2a-v1.schema.json` is an exact copy of the A2A project's published generated JSON Schema bundle captured 2026-08-13, SHA-256 `8e16bb6822202d211fbcc0f36cd6d75420780f35975272bd5ed142a5ccf51123`. The normative A2A 1.0 proto is pinned to v1.0.0 revision `173695755607e884aa9acf8ce4feed90e32727a1`. The generated bundle is non-normative by upstream's own description.

`experimental-mcp-server-card.schema.json` is an exact copy of `modelcontextprotocol/experimental-ext-server-card` revision `526201bbc80231daa40ffcdecfc9da4e54e5dc93`, upstream path `schema.json`, SHA-256 `2c772b51edb367f154771d84ddbae87ddba00a624422c8e46f218a9ac03bf042`. It is a generated JSON Schema 2020-12 artifact from upstream `schema.ts` (SHA-256 `f8321e0ada31f32e372bb715c27f917229d02675d52b4fa9a14909df5905f2e9`). The upstream project is experimental and explicitly not an accepted/official MCP extension at this revision.
