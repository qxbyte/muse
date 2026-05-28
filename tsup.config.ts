import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.tsx",
    index: "src/index.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
  shims: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
  external: [
    // Ink 在运行时使用 require 解析依赖，强制 external 避免打包问题
    "react",
    "ink",
    "ink-spinner",
    "ink-text-input",
  ],
});
