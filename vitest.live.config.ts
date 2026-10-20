import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.live.test.ts"],
    environment: "node",
    testTimeout: 600_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
