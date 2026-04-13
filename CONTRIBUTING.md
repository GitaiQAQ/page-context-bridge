# Contributing to Page Context Bridge

Thank you for your interest in contributing! This document provides guidelines and information for contributors.

## Development Setup

1. Clone the repository
2. Install dependencies: `pnpm install`
3. Run type checking: `pnpm typecheck`
4. Build all packages: `pnpm build`
5. Run tests: `pnpm test`

## Project Structure

This is a pnpm monorepo with three packages:

```
packages/
├── shared-protocol/              # Shared JSON-RPC 2.0 protocol library
│   └── src/
│       ├── index.ts              # RpcPeer, message types, manifest types
│       └── index.test.ts         # Protocol unit tests
├── chrome-mcp-bridge-server/     # Node.js MCP bridge server
│   └── src/
│       ├── index.ts              # Server entry: WebSocket, SSE/stdio MCP, builtin tools
│       ├── schema.ts             # JSON Schema → Zod converter
│       ├── schema.test.ts        # Schema conversion tests
│       ├── page-tool-routing.ts  # Tool name routing utility
│       └── page-tool-routing.test.ts
└── chrome-mcp-extension/         # Chrome Extension (Manifest V3)
    └── src/
        ├── background.ts              # Service worker: WebSocket, tool discovery
        ├── content-script-core.ts     # Builtin tool implementations
        ├── content-script.ts          # Content script entry point
        ├── sidepanel-main.ts          # Side panel UI
        ├── popup-main.ts              # Popup UI
        ├── runtime-rpc.ts             # Chrome runtime JSON-RPC adapter
        ├── page-tool-registry.ts      # Page tool normalization
        ├── page-tool-visibility.ts    # Tool preference hierarchy
        ├── context-manifest-diff.ts   # Manifest diff
        ├── context-manifest-filter-debug.ts  # Filter debugging
        ├── builtin-tool-filtering.ts  # Builtin tool filter
        ├── example-page-core.ts       # Demo page implementation
        ├── example-page-main.ts       # Demo page entry
        └── *.browser.test.ts          # Extension unit tests (jsdom)
```

### Package Dependencies

```
@page-context/shared-protocol   (no dependencies — foundational)
        ↑                ↑
        │                │
page-context-mcp-bridge   page-context-bridge-extension
  (bridge server)           (Chrome extension)
```

## Common Commands

| Command | Description |
|---------|-------------|
| `pnpm install` | Install all dependencies |
| `pnpm build` | Build all packages |
| `pnpm typecheck` | Type check all packages |
| `pnpm test` | Run all tests |
| `pnpm mcp` | Start MCP bridge server |
| `pnpm mcp:dev` | Start MCP bridge server in dev mode |
| `pnpm dev` | Start extension dev preview (Playwright) |

## Code Style

- Use TypeScript with strict type checking (`"strict": true` in tsconfig)
- Follow existing code patterns and naming conventions
- Add comments for complex architectural decisions (e.g., reconnection logic, epoch-based connection management)
- Keep functions small and focused on single responsibilities
- Use pure functions where possible (see `page-tool-registry.ts`, `context-manifest-diff.ts` as examples)

## Testing

The project uses Vitest with two test environments:

- **Node tests**: `shared-protocol/src/**/*.test.ts`, `chrome-mcp-bridge-server/src/**/*.test.ts`
- **Browser tests**: `chrome-mcp-extension/src/**/*.browser.test.ts` (jsdom environment)

Run tests:

```bash
pnpm test
```

### Test Conventions

- Pure logic modules should have comprehensive unit tests
- Test files are colocated with source files (`*.test.ts` or `*.browser.test.ts`)
- Browser tests use jsdom to simulate the DOM environment

## Pull Request Process

1. Fork the repository
2. Create a feature branch from `main`
3. Make your changes
4. Ensure type checking passes: `pnpm typecheck`
5. Ensure all tests pass: `pnpm test`
6. Submit a pull request with a clear description of the changes

## Architecture Principles

- **Separation of Concerns**: Extension core remains generic and business-agnostic
- **Protocol-Based**: Communication happens through well-defined JSON-RPC 2.0 protocol
- **Namespace Filtering**: Page capabilities can be filtered at every level (builtin → tab → namespace → instance → tool)
- **MCP Compatibility**: Page tools/resources/skills are compiled into standard MCP objects

## Security Awareness

- The `execute_js` tool executes arbitrary JavaScript — be cautious when modifying its behavior
- Always use `escapeHtml()` when rendering user-generated content in HTML
- Never commit API keys, tokens, or secrets
- Keep CORS configuration appropriate for local development

## Reporting Issues

When reporting bugs or requesting features:

- Use the GitHub issue tracker
- Provide clear reproduction steps
- Include browser version and extension version
- For bugs, include console errors and network requests if relevant

## License

By contributing to this project, you agree that your contributions will be licensed under the MIT License.
