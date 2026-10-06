import type { PortalEvent } from './api';
import { SHELL_TOOL } from './tool-activity';
import { toolArgsOf, toolNameOf } from './tool-payload';
/** Match direct browser tools and the MCP adapter's wrapped browser calls. */
export function latestBrowserActivity(events: PortalEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type !== 'tool_execution_start') continue;
    const name = toolNameOf(event.payload), input = toolArgsOf(event.payload) ?? {};
    if (/(^|[_.])browser[_.]/i.test(name) || name === 'mcp' && ['server', 'connect', 'tool', 'describe'].some(k => typeof input[k] === 'string' && /browser/i.test(input[k]))) return event.seq;
  }
  return 0;
}

export function latestTerminalActivity(events: PortalEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'tool_execution_start' && SHELL_TOOL.test(toolNameOf(event.payload))) return event.seq;
  }
  return 0;
}
