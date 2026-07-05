# Bellamente

Bellamente is local-first memory for AI agents. This npm package installs the
`bella` launcher, which downloads and runs the matching GitHub release binary
for supported Windows x64 and Linux x64 machines.

```sh
npm install -g bellamente
bella doctor
bella
```

The launcher verifies the downloaded binary against `SHA256SUMS.txt` from the
same release before executing it.

Agent docs start at https://the-little-ai-company.github.io/bellamente/llms.txt.
Use the `bella` CLI, local HTTP API, or OpenAI-compatible proxy directly; MCP via
`bella mcp` is planned soon.
