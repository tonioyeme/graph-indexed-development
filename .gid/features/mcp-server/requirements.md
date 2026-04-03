# MCP Server — Requirements

## Status: ✅ Complete (via packages/mcp/ TypeScript wrapper)

## Implementation
The MCP server is implemented as a **TypeScript thin wrapper** in `packages/mcp/` that:
- Uses `@modelcontextprotocol/sdk` (official MCP SDK)
- Calls the `gid` Rust CLI binary for all operations
- Exposes all gid tools (query, tasks, design, extract, visual, etc.)

This is the correct architecture: TS for MCP protocol handling, Rust for the heavy lifting.

## NOT needed
- A Rust-native MCP server was briefly implemented and reverted — the TS wrapper is sufficient
- `gid mcp` CLI command is not needed — run the TS server directly via `npx`

## Usage
```bash
cd packages/mcp && npx . 
# Or configure in Claude Desktop / Cline settings
```
