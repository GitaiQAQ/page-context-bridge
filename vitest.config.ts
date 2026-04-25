import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      enabled: true,
      provider: "v8",
      // Multi-project runs execute in parallel; avoid concurrent report directory cleanup.
      cleanOnRerun: false,
      // Only count files that are actually exercised by the current test run.
      // This keeps per-project runs (e.g. `--project userscripts`) from failing coverage thresholds
      // due to unrelated packages being included but not executed.
      all: false,
      reporter: ["text", "text-summary", "html", "lcov"],
      reportsDirectory: "./coverage",
      include: [
        "packages/shared-protocol/src/**/*.ts",
        "packages/page-context-bridge-server/src/**/*.ts",
        "packages/page-context-extension/src/**/*.ts",
        "packages/page-context-userscripts/src/**/*.ts",
        "packages/builtin-tools/src/**/*.ts",
      ],
      exclude: [
        "**/*.test.ts",
        "**/*.browser.test.ts",
        "**/*.d.ts",
        "**/dist/**",
        "**/vendor/**",
      ],
      thresholds: {
        statements: 30,
        branches: 25,
        functions: 30,
        lines: 30,
      },
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
