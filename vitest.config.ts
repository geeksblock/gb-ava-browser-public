import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@gb-ava/protocol": fileURLToPath(new URL("./shared/src/index.ts", import.meta.url)),
    },
  },
  // The build identity is injected by scripts/build.mjs in a real bundle; tests
  // get a fixed stamp so build-aware code can be exercised without a build step.
  define: {
    __AVA_BUILD_ID__: JSON.stringify("test-build"),
    __AVA_BUILD_AT__: JSON.stringify("2026-01-01T00:00:00.000Z"),
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
