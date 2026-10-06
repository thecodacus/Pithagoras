import { readPiSettings } from "../pi-settings.js";
import { bashSpawnHook, fileOperations } from "./exec.js";
import { prepareFolder } from "./apply.js";
import { sandboxOn, sandboxPolicy, sandboxSupport } from "./policy.js";

/**
 * pi's own tools again, under the same names, with what they do to the system
 * done as the sandbox user: bash through its spawn hook, read, write, edit, ls
 * and grep's reading through their pluggable operations. A tool of an
 * extension with a built-in's name takes the built-in's place, so the agent
 * sees the same tools it always had. find has nothing to hand over: its search
 * is fd, which the portal points at the sandbox (apply.ts).
 *
 * The options pi gives its built-ins come from its settings, so a shell, a
 * command prefix or the image resizing set there still apply.
 *
 * The chat's folder is made writable for the sandbox first, where a rule says
 * so: see prepareFolder.
 *
 * Whether to is decided each time the extension is loaded, not when the chat
 * started: switching the sandbox on or off reloads the open chats, and each
 * then gets the tools that fit (the built-ins come back where nothing takes
 * their place).
 */
export async function sandboxTools(pi: any, cwd: string): Promise<(ext: any) => void> {
  if (sandboxOn()) await prepareFolder(sandboxPolicy(), sandboxSupport(), cwd);
  return (ext: any) => {
    if (!sandboxOn()) return;
    const ids = sandboxSupport().ids!;
    const ops = fileOperations(ids);
    const settings = readPiSettings() as { shellCommandPrefix?: string; shellPath?: string; images?: { autoResize?: boolean } };
    ext.registerTool(pi.createBashToolDefinition(cwd, {
      spawnHook: bashSpawnHook(ids),
      ...(settings.shellCommandPrefix ? { commandPrefix: settings.shellCommandPrefix } : {}),
      ...(settings.shellPath ? { shellPath: settings.shellPath } : {}),
    }));
    ext.registerTool(pi.createReadToolDefinition(cwd, { operations: ops.read, autoResizeImages: settings.images?.autoResize ?? true }));
    ext.registerTool(pi.createWriteToolDefinition(cwd, { operations: ops.write }));
    ext.registerTool(pi.createEditToolDefinition(cwd, { operations: ops.edit }));
    ext.registerTool(pi.createLsToolDefinition(cwd, { operations: ops.ls }));
    ext.registerTool(pi.createGrepToolDefinition(cwd, { operations: ops.grep }));
  };
}
