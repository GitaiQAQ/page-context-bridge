import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      enabled: false,
    },
    projects: [
      {
        test: {
          name: "node",
          include: [
            "packages/shared-protocol/src/**/*.test.ts",
            "packages/chrome-mcp-bridge-server/src/**/*.test.ts",
          ],
          environment: "node",
        },
      },
      {
        test: {
          name: "browser",
          include: ["packages/chrome-mcp-extension/src/**/*.browser.test.ts"],
          environment: "jsdom",
        },
      },
    ],
  },
});
