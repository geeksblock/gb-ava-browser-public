/**
 * Public surface of the adapter: a bridge client, the Cua-shaped tools, and the
 * two error types a caller must be able to tell apart.
 */

export { BridgeClient, configDirectory, readToken } from "./client.js";
export type { ClientOptions } from "./client.js";
export {
  BridgeError,
  NeedsHumanError,
  classifyStall,
  toAdapterError,
  type NeedsHumanReason,
} from "./errors.js";
export {
  CUA_TOOLS,
  browser_activate_tab,
  browser_click,
  browser_close_tab,
  browser_create_tab,
  browser_download,
  browser_evaluate,
  browser_find_tab,
  browser_key,
  browser_navigate,
  browser_read_page,
  browser_screenshot,
  browser_scroll,
  browser_select,
  browser_session_end,
  browser_session_start,
  browser_session_status,
  browser_tabs,
  browser_type,
  browser_upload,
  browser_wait,
  type CuaToolName,
  type ElementTarget,
  type TabTarget,
  type ToolContext,
} from "./tools.js";
