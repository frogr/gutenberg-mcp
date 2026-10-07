import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GutenbergError } from "../gutenberg.js";

/** A user-fixable input problem found after schema validation. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

/** Successful result: JSON text for any client + structuredContent for clients that use outputSchema. */
export function ok<T extends Record<string, unknown>>(data: T): CallToolResult & { structuredContent: T } {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

/** Error result the model can read and act on, instead of a protocol-level failure. */
export function fail(err: unknown): CallToolResult {
  let text: string;
  if (err instanceof GutenbergError) text = err.toToolMessage();
  else if (err instanceof ToolInputError) text = `Invalid input: ${err.message}`;
  else {
    // Unknown errors are bugs; keep details in the server log, not in the reply.
    console.error("[tool] unexpected error", err);
    text = "Unexpected server error. Retry once; if it happens again, the request may not be supported.";
  }
  return { isError: true, content: [{ type: "text", text }] };
}

/** Wrap a handler so every thrown error becomes a readable tool error. */
export function safe<A>(handler: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await handler(args);
    } catch (err) {
      return fail(err);
    }
  };
}

export function truncate(text: string | undefined | null, max: number): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** "Melville, Herman" -> "Herman Melville". Leaves names without a comma alone. */
export function displayName(name: string): string {
  const parts = name.split(", ");
  if (parts.length !== 2) return name;
  return `${parts[1]} ${parts[0]}`.replace(/\s+\(.*\)$/, "").trim();
}

/** Format lines with right-aligned line numbers: " 813  CHAPTER 1. Loomings." */
export function numberLines(lines: string[], firstLine: number): string {
  const width = String(firstLine + lines.length - 1).length;
  return lines.map((l, i) => `${String(firstLine + i).padStart(width)}  ${l}`).join("\n");
}

export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const bookIdInput = z
  .number()
  .int()
  .min(1)
  .max(999_999)
  .describe("Project Gutenberg book id, e.g. 2701 (Moby Dick) or 1342 (Pride and Prejudice). Find ids with search_books.");

export const chapterRef = z.object({
  index: z.number().describe("Position in get_book's chapter list. Pass as read_passage's chapter."),
  label: z.string(),
  title: z.string().optional(),
  part: z.string().optional(),
});

export const attributionOutput = z.string().describe("Credit line to keep with any quoted text.");

/** Promise.allSettled for one promise. */
export function settle<T>(p: Promise<T>): Promise<PromiseSettledResult<T>> {
  return p.then(
    (value) => ({ status: "fulfilled", value }) as const,
    (reason) => ({ status: "rejected", reason }) as const,
  );
}

/** Reject with a timeout GutenbergError if `p` takes longer than `ms`. `p` itself keeps running. */
export function withGrace<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new GutenbergError("The catalog (Gutendex) is taking too long.", undefined, "timeout", "Retry in a moment; the answer is cached once it arrives.")), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}
