import { buildRuntimeInstructions } from "./RuntimeInstructions.ts";

const T3_CODE_BROWSER_TOOL_INSTRUCTIONS = `

## T3 Code collaborative browser

You are running inside T3 Code. The \`t3-code\` MCP server is the product-native collaborative browser shared with the user. When it exposes \`preview_*\` tools, prefer those tools for browser navigation, inspection, interaction, screenshots, and recordings.

For browser work, first call \`preview_status\`. If no automation-capable preview is attached, call \`preview_open\` before concluding that the browser is unavailable. Then use \`preview_navigate\`, \`preview_snapshot\`, and the focused interaction tools. Prefer snapshot-provided locators over coordinates.

Do not switch to global browser skills, Chrome, Node REPL browser automation, standalone Playwright, or agent-browser merely because the preview is initially closed or a first call fails. Use an alternative browser system only when the T3 preview tools are absent, the user explicitly requests another browser, or \`preview_open\` returns an explicit unsupported/unavailable error. A failed T3 preview tool call should be inspected and retried with corrected arguments when the error is actionable.
`;

const T3_CODE_DEVICE_TOOL_INSTRUCTIONS = `

## T3 Code devices

The \`t3-code\` MCP server also exposes \`device_*\` tools for iOS Simulators and Android Emulators on this environment. For mobile verification, call \`device_list\`, then \`device_open\` so the user can watch the device in their Device panel; its result explains how to drive the device. Driving happens through the \`agent-device\` CLI, which is on PATH. Keep the host config and session flags returned by \`device_open\` on every command so concurrent devices stay independent: prefer \`agent-device snapshot -i\` refs over coordinates, and use \`device_screenshot\` when you need to see the screen. Do not call simctl, adb, xcrun, or serve-sim directly while these tools are present. If \`device_list\` reports a platform as unavailable, say so instead of trying another route.
`;

export interface T3CodeToolAvailability {
  readonly browser: boolean;
  readonly device: boolean;
}

const normalizeAvailability = (
  availability: boolean | T3CodeToolAvailability,
): T3CodeToolAvailability =>
  typeof availability === "boolean" ? { browser: availability, device: false } : availability;

/**
 * Each block is omitted entirely when its tools aren't attached. Describing
 * `preview_*` or `device_*` tools that aren't in the turn's tool list would be
 * worse than saying nothing: the instructions actively steer the model away
 * from Playwright, agent-browser, and raw simctl/adb, so leaving them in would
 * talk it out of the only automation it still has.
 */
const browserToolInstructions = (availability: boolean | T3CodeToolAvailability): string => {
  const tools = normalizeAvailability(availability);
  return `${tools.browser ? T3_CODE_BROWSER_TOOL_INSTRUCTIONS : ""}${
    tools.device ? T3_CODE_DEVICE_TOOL_INSTRUCTIONS : ""
  }`;
};

const codexDefaultModeDeveloperInstructions = (
  browserToolsAvailable: boolean | T3CodeToolAvailability,
): string => `<collaboration_mode># Collaboration Mode: Default

You are now in Default mode. Any previous instructions for other modes (e.g. Plan mode) are no longer active.

Your active mode changes only when new developer instructions with a different \`<collaboration_mode>...</collaboration_mode>\` change it; user requests or tool descriptions do not change mode by themselves. Known mode names are Default and Plan.

## request_user_input availability

Use the \`request_user_input\` tool only when it is listed in the available tools for this turn.

In Default mode, strongly prefer making reasonable assumptions and executing the user's request rather than stopping to ask questions. If you absolutely must ask a question because the answer cannot be discovered from local context and a reasonable assumption would be risky, ask the user directly with a concise plain-text question. Never write a multiple choice question as a textual assistant message.
${browserToolInstructions(browserToolsAvailable)}
</collaboration_mode>`;

export interface CodexRuntimeInfo {
  readonly model: string;
  readonly reasoningEffort: string;
}

export function buildCodexDeveloperInstructions(
  runtime: CodexRuntimeInfo,
  /**
   * Whether the `t3-code` MCP server is attached to this turn. Callers derive
   * it from the session's actual MCP configuration rather than re-reading the
   * setting, so the prompt cannot claim tools the turn doesn't have.
   */
  browserToolsAvailable: boolean | T3CodeToolAvailability = true,
): string {
  const base = codexDefaultModeDeveloperInstructions(browserToolsAvailable);
  return `${base}

${buildRuntimeInstructions({ harness: "Codex", ...runtime })}`;
}
