# Bellamente

Bellamente is local-first memory for AI agents. This Python package installs the
`bella` launcher, which downloads and runs the matching GitHub release binary
for supported Windows x64 and Linux x64 machines.

```sh
pipx install bellamente
bella doctor
bella
```

You can also use `uvx bellamente doctor`. The launcher verifies the downloaded
binary against `SHA256SUMS.txt` from the same release before executing it.
`uvx` is a one-shot run; use `pipx install bellamente` when you want `bella`
to stay on your PATH.

Agent docs start at https://the-little-ai-company.github.io/bellamente/llms.txt.
Use the `bella` CLI, local HTTP API, or OpenAI-compatible proxy directly; MCP via
`bella mcp` is planned soon.
