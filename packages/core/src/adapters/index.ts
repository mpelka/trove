import type { Adapter } from "./types.ts";
import { claudeCodeAdapter } from "./claude-code.ts";
import { geminiCliAdapter } from "./gemini-cli.ts";

/** All registered adapters. New agents are added here — nothing above this line changes. */
export const adapters: Adapter[] = [claudeCodeAdapter, geminiCliAdapter];

export function getAdapter(agentId: string): Adapter | undefined {
  return adapters.find((a) => a.agentId === agentId);
}

export * from "./types.ts";
export { claudeCodeAdapter, geminiCliAdapter };
