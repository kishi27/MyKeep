import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
let build = "unknown";
try {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (/^[a-f0-9]{40,64}$/i.test(commit)) build = commit.slice(0, 7);
} catch {
  // Source ZIPs may not include Git metadata; do not invent a build ID.
}

export default defineConfig({
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(version),
    "import.meta.env.VITE_BUILD_ID": JSON.stringify(build),
  },
});
