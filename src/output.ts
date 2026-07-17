export const DEFAULT_MAX_OUTPUT_CHARS = 50_000;

export interface Truncated {
  text: string;
  truncated: boolean;
}

/** 头尾保留式截断：头 50% + 标记 + 尾 50%，避免只留头丢掉报错尾部 */
export function truncateHeadTail(
  text: string,
  maxChars: number = DEFAULT_MAX_OUTPUT_CHARS,
): Truncated {
  if (text.length <= maxChars) return { text, truncated: false };
  const head = Math.ceil(maxChars / 2);
  const tail = maxChars - head;
  const omitted = text.length - head - tail;
  return {
    text:
      text.slice(0, head) +
      `\n\n[... truncated ${omitted} chars ...]\n\n` +
      text.slice(text.length - tail),
    truncated: true,
  };
}
