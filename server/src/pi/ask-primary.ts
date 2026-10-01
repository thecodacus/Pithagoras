import { Type } from "typebox";
import { getDb, getDefaultReportTo, type SessionRow } from "../db.js";
import { unscopeKey } from "../agent.js";
import { askQuestion } from "../questions.js";
import { channelSupervisor } from "../channels/supervisor.js";
import { sessions } from "../session-manager.js";
import { getPerson } from "../people.js";

/**
 * Reaching the primary user from a conversation that is not theirs.
 *
 * A colleague hits a wall at every action; the agent can only say "that needs
 * Sam". This turns that into a message they actually receive, and their reply
 * comes back to the colleague who asked — see readAnswer for the return leg.
 *
 * The destination is the same one routines report to. The agent picks neither
 * the recipient nor the route, which is the property worth keeping: a session
 * serving someone else must not be able to choose who hears from it.
 */
export function askPrimaryTool(sessionId: string) {
  return (pi: any): void => {
    pi.registerTool({
      name: "ask_primary",
      label: "Ask the primary user",
      description:
        "Put a question to your primary user on behalf of the person you are talking to. Use it " +
        "when they need something you are not allowed to do, or a decision that is not yours. " +
        "The answer comes back into this conversation later — it does not arrive during this " +
        "turn, so tell them you have asked and leave it there.",
      promptSnippet: "ask_primary — pass a request to your primary user and get an answer back",
      parameters: Type.Object({
        question: Type.String({
          description:
            "The question, written for someone who cannot see this conversation: who is asking, " +
            "what they want, and what you would do if they said yes.",
        }),
        action: Type.Optional(
          Type.String({
            description:
              "When you are asking permission to do one specific thing, the exact thing — the " +
              "shell command verbatim, or the path you would write. Approving authorises this " +
              "and nothing else, so it must be exactly what you intend to run, once. Leave it " +
              "out when you are asking for a decision rather than permission.",
          })
        ),
        actionTool: Type.Optional(
          Type.String({ description: "The tool the action belongs to. Defaults to bash." })
        ),
      }),
      async execute(_id: string, p: any) {
        const question = String(p.question ?? "").trim();
        if (!question) return { output: "Nothing to ask.", isError: true };

        const to = getDefaultReportTo();
        if (!to) {
          return {
            output:
              "There is no way to reach the primary user — no report destination is configured. " +
              "Tell the person you cannot get hold of them.",
            isError: true,
          };
        }

        const session = getDb()
          .prepare("SELECT * FROM sessions WHERE id = ?")
          .get(sessionId) as SessionRow | undefined;
        if (!session?.channel_slug || !session.channel_key) {
          return { output: "This conversation has nowhere to send an answer back to.", isError: true };
        }
        // Whether an answer can be routed back, which is not whether the
        // question is worth asking. Refusing to ask at all because the return
        // leg is missing throws away the part that matters — the question
        // reaching a human — so it only changes what everyone is told.
        // Whether it arrives the moment it is written, or waits for them to
        // speak again. Either way it arrives, so neither the question nor the
        // promise changes — only the timing does.
        const immediate = channelSupervisor.canSend(session.channel_slug);

        const who =
          sessions.currentSpeaker(sessionId) ??
          (session.last_person_key ? getPerson(session.last_person_key) : undefined);
        const row = askQuestion({
          sessionId,
          personKey: who?.key ?? "unknown",
          personName: who?.name ?? "Someone",
          channelSlug: session.channel_slug,
          channelKey: unscopeKey(session.channel_slug, session.channel_key),
          question,
          actionTool: typeof p.actionTool === "string" ? p.actionTool : "bash",
          action: typeof p.action === "string" && p.action.trim() ? p.action.trim() : null,
        });

        try {
          await channelSupervisor.send(
            to.channel,
            to.target,
            `${row.person_name} is asking (via ${session.channel_slug}):\n\n${question}\n\n` +
              (row.action
                ? `It wants to run, exactly once:\n\n    ${row.action}\n\n` +
                  `Approving runs that and nothing else.\n\n`
                : "") +
              (row.action
                ? `Reply "#${row.id} approve" for this once, "#${row.id} always" to permit it from ` +
                  `now on, or "#${row.id} no".`
                : `Reply with "#${row.id} <your answer>" and I will pass it back to them.`) +
              (immediate ? "" : ` That channel cannot be messaged out of the blue, so they will see it the next time they write.`),
            // Only where there is something to approve. A question wanting an
            // opinion needs words, and two buttons would be pretending it does not.
            row.action
              ? [
                  { label: "Approve once", reply: `#${row.id} approve` },
                  { label: "Always allow", reply: `#${row.id} always` },
                  { label: "Deny", reply: `#${row.id} no` },
                ]
              : undefined
          );
        } catch (e) {
          return { output: `Could not reach them: ${(e as Error).message}`, isError: true };
        }

        return {
          output:
            `Asked. Tell ${row.person_name} you have passed it on and that you will come back ` +
            `to them — do not guess at the answer in the meantime.`,
          isError: false,
        };
      },
    });
  };
}
