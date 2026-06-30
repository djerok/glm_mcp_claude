# Contributing to glm-mcp-claude

Thanks for helping out! This project makes GLM usable as a cheap, full-capability subagent
inside Claude Code. Contributions of all sizes are welcome — bug reports, docs, new routing
rules, provider adapters, and fixes.

## Ways to contribute
- **Report a bug** → open an issue with the Bug report template.
- **Request a feature** → open an issue with the Feature request template.
- **Send a fix/feature** → open a Pull Request (see below).
- **Improve the routing rules** → the decision logic lives in
  [`glm-mcp/src/router.js`](glm-mcp/src/router.js) and the inference in
  [`hooks/glm_subagent_router.mjs`](hooks/glm_subagent_router.mjs). The research behind the
  weights is in [`docs/`](docs/).

## Project layout
```
glm-mcp/src/index.js      MCP tool registrations (glm_delegate, glm_agent, glm_recommend, glm_status)
glm-mcp/src/router.js     GLM-vs-Opus decision logic (pure, unit-testable)
glm-mcp/src/glmClient.js  GLM Anthropic-format API client (serialized + retries)
glm-mcp/src/glmAgent.js   GLM file-agent loop (read/write/edit/bash, diff, dry-run)
agents/glm.md             the GLM subagent definition
hooks/glm_subagent_router.mjs  the auto-delegation PreToolUse hook
install.mjs / uninstall.mjs     installer / uninstaller
```

## Dev setup
```bash
git clone https://github.com/djerok/glm_mcp_claude.git
cd glm_mcp_claude/glm-mcp
npm install
cp .env.example .env   # add a GLM_API_KEY for live tests
npm run smoke          # offline checks + one live call if a key is set
```

## Testing your change
- **Router logic:** `node --input-type=module -e "import {recommend} from './glm-mcp/src/router.js'; console.log(recommend({taskType:'frontend'}))"`
- **Hook inference:** pipe a sample payload:
  `echo '{"tool_input":{"subagent_type":"general-purpose","prompt":"write a regex"}}' | node hooks/glm_subagent_router.mjs`
- **MCP server boots + lists tools:** see the snippet in the README troubleshooting section.
- **Installer (safe):** `node install.mjs --claude-dir ./.test-home --no-register --skip-npm` then inspect `./.test-home`.

## Pull Request guidelines
1. Branch off `main`: `git checkout -b feat/short-name`.
2. Keep changes focused; match the existing code style (no build step, ESM, no heavy deps).
3. **Never commit secrets.** No real API keys, no `.env`. `.gitignore` enforces this — double-check `git diff --staged`.
4. Update docs/README if behavior changes.
5. Describe what changed and how you tested it in the PR (the template prompts you).

## Reporting security issues
Don't open a public issue for anything that exposes credentials or enables abuse. Contact the
maintainer privately (GitHub profile) first.

## License
By contributing, you agree your contributions are licensed under the repository's [MIT License](LICENSE).
