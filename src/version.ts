import { readFileSync } from "node:fs";

// dist/version.js 与 package.json 的相对位置恒为 ../package.json
//（npm 包始终包含 package.json，本地构建亦然）
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
