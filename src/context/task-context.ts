import type { ModelMessage, SubtaskSpec } from "../contracts.js";

/** A caller-resolved document that may be injected into one task's prompt. */
export interface ContextDocument {
  ref: string;
  content: string;
}

/**
 * Build a new message array for one task. Only documents whose references are
 * explicitly listed on the task (and, when supplied, in allowedRefs) are
 * included. The helper never reads another task's transcript or memory.
 */
export function buildTaskMessages(
  task: SubtaskSpec,
  documents: readonly ContextDocument[] = [],
  allowedRefs: readonly string[] = task.contextRefs,
): ModelMessage[] {
  const taskRefs = new Set(task.contextRefs);
  const permittedRefs = new Set(allowedRefs.filter((ref) => taskRefs.has(ref)));
  const seenRefs = new Set<string>();
  const selected: ContextDocument[] = [];

  for (const document of documents) {
    if (
      permittedRefs.has(document.ref) &&
      !seenRefs.has(document.ref) &&
      typeof document.content === "string"
    ) {
      seenRefs.add(document.ref);
      selected.push(document);
    }
  }

  const toolList = task.allowedTools.length > 0
    ? task.allowedTools.join(", ")
    : "none";
  const contextBlock = selected.length > 0
    ? selected.map(({ ref, content }) => `### Context ${ref}\n${content}`).join("\n\n")
    : "No context documents were provided.";

  return [
    {
      role: "system",
      content: [
        "You are completing one isolated task in a bounded agent runtime.",
        `You may call only these tools: ${toolList}.`,
        "Use only the task instructions and explicitly supplied context below.",
      ].join(" "),
    },
    {
      role: "user",
      content: [
        `Task: ${task.title}`,
        `Task ID: ${task.taskId}`,
        "Instructions:",
        task.instructions,
        "Authorized context:",
        contextBlock,
      ].join("\n\n"),
    },
  ];
}
