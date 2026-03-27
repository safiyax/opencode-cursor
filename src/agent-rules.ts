import { readFileSync } from "node:fs";
import { errorDetails, logPluginWarn } from "./logger";

const BUNDLED_AGENTS_PATH = new URL("../dist/AGENTS.md", import.meta.url);

let cachedBundledAgentsRule: string | undefined;

export function appendBundledAgentsRule(cloudRule?: string): string | undefined {
  const bundledAgentsRule = getBundledAgentsRule();
  const baseRule = cloudRule?.trim() ?? "";

  if (!bundledAgentsRule) {
    return baseRule || undefined;
  }

  if (!baseRule) {
    return bundledAgentsRule;
  }

  return `${baseRule}\n\n${bundledAgentsRule}`;
}

function getBundledAgentsRule(): string {
  if (cachedBundledAgentsRule !== undefined) {
    return cachedBundledAgentsRule;
  }

  try {
    cachedBundledAgentsRule = readFileSync(BUNDLED_AGENTS_PATH, "utf8").trim();
  } catch (error) {
    logPluginWarn("Failed to load bundled AGENTS.md rule", errorDetails(error));
    cachedBundledAgentsRule = "";
  }

  return cachedBundledAgentsRule;
}
