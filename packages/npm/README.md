# Bellamente

Bellamente is local-first memory for AI agents. This npm package installs the
`bella` launcher, which downloads and runs the matching GitHub release binary
for your platform.

```sh
npm install -g bellamente
bella doctor
bella
```

The launcher verifies the downloaded binary against `SHA256SUMS.txt` from the
same release before executing it.
