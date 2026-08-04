import path from "node:path";
import { execSync } from "node:child_process";
import { defineConfig } from "vite";

/** 当前 git 短提交号（构建期注入；非 git 环境 fallback "unknown"） */
function buildHash(): string {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

export default defineConfig(({ mode }) => {
  const isDev = mode === "development";
  return {
    // 构建期常量：注入"构建时间点 + git 提交号"，供调试面板「版本」TD 显示。
    // dev watch 每次重建会刷新时间（构建时刻），生产 build 即发布版本时刻
    define: {
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
      __BUILD_HASH__: JSON.stringify(buildHash()),
    },
    build: {
      target: "node22",
      ssr: true,
      lib: {
        formats: ["es"],
        entry: "src/main.ts",
      },
      sourcemap: isDev,
      watch: isDev
        ? {
            clearScreen: true,
            include: ["src/**/*.ts"],
          }
        : null,
      rolldownOptions: {
        output: {
          minify: !isDev,
          cleanDir: !isDev,
          dir: "dist",
          entryFileNames: "bundle.js",
        },
      },
    },
    resolve: {
      alias: [{ find: "@", replacement: path.resolve(import.meta.dirname, "src") }],
    },
  };
});
