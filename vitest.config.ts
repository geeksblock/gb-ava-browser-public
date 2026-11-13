import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@gb-ava/protocol": fileURLToPath(new URL("./shared/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
