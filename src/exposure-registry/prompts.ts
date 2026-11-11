import type { PromptSpec } from "../types";

/**
 * The text of an @mcp.prompts entry with its arguments filled in: each `{{key}}` of an input
 * becomes the argument's value (already checked against promptArgsSchema). Other braces stay.
 */
export function renderPrompt(prompt: PromptSpec, args: Record<string, string>): string {
  const keys = new Set(prompt.inputs.map((input) => input.key));
  // One pass over the template, so an argument's own text is never filled in again.
  return prompt.template.replace(/\{\{([^{}]*)\}\}/g, (whole, key: string) =>
    keys.has(key) ? (args[key] ?? "") : whole,
  );
}
