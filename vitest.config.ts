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
            "packages/page-context-bridge-server/src/**/*.test.ts",
          ],
          environment: "node",
        },
      },
      {
        test: {
          name: "browser",
          include: ["packages/page-context-extension/src/**/*.browser.test.ts"],
          environment: "jsdom",
        },
      },
      {
        test: {
          name: "userscripts",
          include: ["packages/page-context-userscripts/src/**/*.test.ts"],
          environment: "jsdom",
        },
      },
    ],
  },
});
