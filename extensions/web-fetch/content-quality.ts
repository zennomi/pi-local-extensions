export interface ContentQualityOptions {
  partial?: boolean;
  targetStatus?: number;
}

export interface ContentQuality {
  thin: boolean;
  blocked: boolean;
  textChars: number;
  reason?: string;
}

const BLOCK_PAGE_SIGNATURES = [
  /you(?:'|’)ve been blocked/i,
  /just a moment/i,
  /checking your browser/i,
  /enable javascript/i,
  /access denied/i,
  /\bcaptcha\b/i,
  /attention required/i,
  /target url returned error/i,
];

function markdownText(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<https?:\/\/[^>]+>/gi, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/```[\s\S]*?```/g, (value) => value.replace(/```[^\n]*\n?|```/g, " "))
    .replace(/<[^>]+>/g, " ")
    .replace(/[#*_~>`|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Estimates whether a provider returned useful page content or a block/shell page. */
export function assessContent(
  markdown: string,
  options: ContentQualityOptions = {},
): ContentQuality {
  const text = markdownText(markdown);
  const textChars = text.length;
  const thin = textChars < 400;

  if (options.partial) {
    return { thin, blocked: true, textChars, reason: "partial content" };
  }
  if (typeof options.targetStatus === "number" && options.targetStatus >= 400) {
    return { thin, blocked: true, textChars, reason: `target returned HTTP ${options.targetStatus}` };
  }
  if (textChars < 2_000) {
    const signature = BLOCK_PAGE_SIGNATURES.find((pattern) => pattern.test(text));
    if (signature) {
      return { thin, blocked: true, textChars, reason: "block or challenge page" };
    }
  }

  return { thin, blocked: false, textChars };
}
