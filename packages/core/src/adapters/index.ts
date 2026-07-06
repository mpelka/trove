import type { Adapter } from "./types.ts";
import { claudeCodeAdapter } from "./claude-code.ts";
import { geminiCliAdapter } from "./gemini-cli.ts";
import { copilotAdapter } from "./copilot.ts";
import { antigravityAdapter } from "./antigravity.ts";
import { chatgptWebAdapter } from "./chatgpt-web.ts";
import { claudeWebAdapter } from "./claude-web.ts";

/** All registered adapters. New agents are added here — nothing above this line changes. */
export const adapters: Adapter[] = [
  claudeCodeAdapter,
  geminiCliAdapter,
  copilotAdapter,
  antigravityAdapter,
  chatgptWebAdapter,
  claudeWebAdapter,
];

export function getAdapter(agentId: string): Adapter | undefined {
  return adapters.find((a) => a.agentId === agentId);
}

export * from "./types.ts";
export {
  claudeCodeAdapter,
  geminiCliAdapter,
  copilotAdapter,
  antigravityAdapter,
  chatgptWebAdapter,
  claudeWebAdapter,
};
