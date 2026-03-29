import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const distDir = resolve(rootDir, "dist");
const agentsSourcePath = resolve(rootDir, "AGENTS.md");
const agentsDestPath = resolve(distDir, "AGENTS.md");

rmSync(distDir, { recursive: true, force: true });

const tsc = spawnSync("tsc", ["-p", "tsconfig.json"], {
  cwd: rootDir,
  stdio: "inherit",
});

if (tsc.status !== 0) {
  process.exit(tsc.status ?? 1);
}

mkdirSync(distDir, { recursive: true });
cpSync(agentsSourcePath, agentsDestPath);
