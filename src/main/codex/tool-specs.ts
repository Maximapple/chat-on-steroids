/**
 * The model-visible text of Codex's tool specs, copied verbatim from
 * `codex-rs/core/src/tools/handlers/shell_spec.rs`, `view_image_spec.rs` and
 * `apply_patch_spec.rs`.
 *
 * These strings are the tools' actual contract with the model, so they live in one place and are
 * quoted exactly. Where Codex switches on `cfg!(windows)` this switches on `process.platform`,
 * which is the same decision made at run time instead of compile time.
 */

import { defaultUserShell, isWindowsPowerShell5 } from './shell.js';

const IS_WINDOWS = process.platform === 'win32';

/**
 * Whether the shell `exec_command` will actually launch is the one without `&&` and `||`.
 *
 * Not the same question as "is this Windows": `defaultUserShell()` resolves `pwsh.exe` first and
 * only falls back to `powershell.exe`, so on a machine with PowerShell 7 installed the operators
 * work and telling the model otherwise would cost it a working line. Resolved once here, the same
 * way and from the same function the exec surface resolves it.
 */
const LAUNCHES_WINDOWS_POWERSHELL_5 = IS_WINDOWS && isWindowsPowerShell5(defaultUserShell().shellPath);

/** `windows_shell_guidance()`. */
export const WINDOWS_SHELL_GUIDANCE = `Windows safety rules:
- Do not compose destructive filesystem commands across shells. Do not enumerate paths in PowerShell and then pass them to \`cmd /c\`, batch builtins, or another shell for deletion or moving. Use one shell end-to-end, prefer native PowerShell cmdlets such as \`Remove-Item\` / \`Move-Item\` with \`-LiteralPath\`, and avoid string-built shell commands for file operations.
- Before any recursive delete or move on Windows, verify the resolved absolute target paths stay within the intended workspace or explicitly named target directory. Never issue a recursive delete or move against a computed path if the final target has not been checked.
- When using \`Start-Process\` to launch a background helper or service, pass \`-WindowStyle Hidden\` unless the user explicitly asked for a visible interactive window. Use visible windows only for interactive tools the user needs to see or control.`;

export const EXEC_COMMAND_DESCRIPTION = IS_WINDOWS
  ? `Runs a command in a PTY, returning output or a session ID for ongoing interaction.\n\n${WINDOWS_SHELL_GUIDANCE}`
  : 'Runs a command in a PTY, returning output or a session ID for ongoing interaction.';

/**
 * Codex's text is 'Shell command to execute.' on every platform. Two measured things are added.
 *
 * The first is conditional, because the condition is real: when the resolved shell is Windows
 * PowerShell 5.1 there is no `&&` or `||` in the parser at all, and the recorded sessions show the
 * model reaching for them anyway and getting a parse error that names the token without saying the
 * feature is missing. The app repairs the common shapes on the way through — see
 * `normalizePowerShellOperators` — but the repair is deliberately narrow, so the constraint is also
 * stated where the model can act on it. On a machine with PowerShell 7 the sentence is dropped
 * rather than left to mislead.
 *
 * The second holds everywhere: 109 of the recorded exec calls were a file being read through the
 * shell. `read` returns the same bytes with a size header, a line count, decoded UTF-8 and a
 * bounded payload, none of which the shell gives, and it works without the exec capability.
 *
 * Both live on the parameter rather than only in the session instructions because the tool list is
 * re-sent every turn, while the instructions are read once at the start of a chat.
 */
export const EXEC_COMMAND_CMD_DESCRIPTION = LAUNCHES_WINDOWS_POWERSHELL_5
  ? 'Shell command to execute. To read a file, use the read tool instead. This shell is Windows PowerShell 5.1, which has no && or ||: use the cmds array for a sequence, or A; if ($?) { B }.'
  : 'Shell command to execute. To read a file, use the read tool instead.';

export const EXEC_COMMAND_CMDS_DESCRIPTION =
  'Sequential shell commands to run in one shell session. Use this for related checks instead of separate exec_command calls. Each command gets a labeled output section and exit code; all commands run after ordinary non-zero exits, and the overall exit code is the first non-zero code.';

export const EXEC_COMMAND_WORKDIR_DESCRIPTION = 'Working directory for the command. Defaults to the turn cwd.';

export const EXEC_COMMAND_TTY_DESCRIPTION =
  'True allocates a PTY for the command; false or omitted uses plain pipes.';

export const EXEC_COMMAND_YIELD_TIME_DESCRIPTION = IS_WINDOWS
  ? 'Maximum time to wait before returning a session ID for a still-running command. Commands that finish sooner return immediately. For ordinary commands, omit this parameter to use the 10000 ms default. Effective range on Windows is 250-30000 ms.'
  : 'Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms.';

/**
 * `max_output_tokens` is deliberately not exposed, which is a divergence from Codex's surface.
 *
 * Upstream the knob is worth having, because the caller's context is the thing it protects. Here
 * the consumer is ChatGPT, which drops a tool result over roughly 10,000 tokens on its own before
 * the model ever reads it. Raising the budget above that therefore bought nothing: the app spent
 * the time collecting and truncating output that was discarded a layer later, and the model spent
 * a parameter and a guess on every call to get it. Recorded sessions show both halves of the
 * waste — requests of 30000 that could not survive, and requests of 1000 and 2000 hand-tuned
 * against a limit the caller could not see.
 *
 * So the budget is fixed at `DEFAULT_MAX_OUTPUT_TOKENS`, which is what omitting the parameter has
 * always resolved to. The runtime layer below still takes `maxOutputTokens` — the capability is
 * intact and `EXEC_OUTPUT_CEILING_POLICY` is still the ceiling over it — only the model-facing
 * surface stops asking for a number it cannot spend.
 *
 * The parameter is still *accepted*, and that is not politeness. These schemas are `.strict()`,
 * and ChatGPT caches a connector's tool definitions: every conversation opened against an older
 * schema keeps sending the key it was shown. Dropping it outright turned those calls into
 * `Unrecognized key: "max_output_tokens"` — the whole command refused, no output, in chats that
 * had done nothing wrong. A retired knob is a presentation concern, and the graceful answer is to
 * take the key, ignore its value and say so in the notes, so the model stops sending it because it
 * was told, not because its command failed.
 */
/**
 * Deliberately terse. `tools/list` is re-sent every turn and the exec schema is measured against a
 * discovery-size budget, so a retired parameter must not spend the room a live one needs. The full
 * reasoning is above; the model only has to learn that sending it does nothing.
 */
export const MAX_OUTPUT_TOKENS_DESCRIPTION =
  'Ignored; still accepted so older cached schemas keep working. Omit it.';

/** The note a call that still sends the retired budget gets back, once, alongside its output. */
export const MAX_OUTPUT_TOKENS_RETIRED_NOTE =
  'max_output_tokens is retired and was ignored; output uses the fixed 10000-token budget. Omit the parameter.';

export const EXEC_COMMAND_SHELL_DESCRIPTION = "Shell binary to launch. Defaults to the user's default shell.";

export const EXEC_COMMAND_LOGIN_DESCRIPTION =
  IS_WINDOWS
    ? 'True loads the shell profile; false disables it. Defaults to false on Windows for deterministic, faster commands.'
    : 'True runs the shell with -l/-i semantics; false disables them. Defaults to true.';

export const WRITE_STDIN_DESCRIPTION =
  'Writes characters to an existing unified exec session and returns recent output.';

export const WRITE_STDIN_SESSION_ID_DESCRIPTION = 'Identifier of the running unified exec session.';

export const WRITE_STDIN_CHARS_DESCRIPTION =
  'Bytes to write to stdin. Defaults to empty, which polls without writing.';

export const WRITE_STDIN_YIELD_TIME_DESCRIPTION =
  'Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls wait up to 5000-300000 ms by default but return early when the first output arrives.';

/**
 * `APPLY_PATCH_LARK_GRAMMAR` (`core/src/tools/handlers/apply_patch.lark`).
 *
 * On Codex this grammar *is* the schema: `apply_patch` is `ToolSpec::Freeform`, so the model is
 * given the grammar and emits raw patch text against it. MCP advertises JSON object schemas only,
 * so the grammar moves into the description -- otherwise the model would lose the exact syntax
 * spec that Freeform hands it.
 */
export const APPLY_PATCH_LARK_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF`;

/**
 * Codex's description is "The `apply_patch` tool can be used to edit files. This is a FREEFORM
 * tool, so do not wrap the patch in JSON."
 *
 * The second sentence cannot survive the move to MCP -- here the patch *is* carried in JSON, as
 * the single `patch` string -- so it is replaced by the truth about this transport and followed by
 * the grammar the Freeform spec would otherwise supply. That substitution is the only adaptation;
 * the grammar, the parser, the matching, the update semantics and the output format are the ported
 * Codex ones.
 */
export const APPLY_PATCH_DESCRIPTION = `The \`apply_patch\` tool can be used to edit files. Pass the patch text as the \`patch\` string; everything else about the format below is unchanged.

The patch must match this grammar:

${APPLY_PATCH_LARK_GRAMMAR}`;

export const APPLY_PATCH_ARGUMENT_DESCRIPTION =
  'The patch text, from *** Begin Patch through *** End Patch, exactly as the grammar describes it.';
