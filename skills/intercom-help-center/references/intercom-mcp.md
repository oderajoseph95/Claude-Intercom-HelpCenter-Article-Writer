# Optional: Intercom's MCP server as a read path

This plugin talks to Intercom's REST API with an API token. That is what makes whole-help-center snapshots, unattended CI runs and capped, reviewed publishing possible.

If the user already has Intercom's own MCP server connected in Claude Code (`https://mcp.intercom.com/mcp`, OAuth sign-in), you may use its read tools to look up an individual article or conversation while you work, for example to check how customers phrase a question before choosing an article title. Treat it as an extra, interactive read path:

- The audit, the snapshot, the pre-write check and publishing still go through the scripts and the API token. Their guarantees (every page read, zero writes in the audit, the cap, drift checks, approved plans) only hold there.
- Do not write articles through the MCP server. Anything published that way bypasses the plan, the review, the cap and the drift check.
- Per Intercom's page, the MCP server is available to US-hosted workspaces; EU and AU workspaces use the API path only.

**Untested:** this plugin's selftest does not exercise the MCP server. Treat anything read through it as a hint to verify, not as the snapshot of record.
