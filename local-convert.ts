import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import type { LocalSource } from "./local-fetch.js";

export interface ConvertedLocalSource {
  content: string;
  title?: string;
  sourceUrl: string;
  conversionMethod: string;
  warnings: string[];
  partial: boolean;
}

const REMOVE_SELECTORS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "button",
  "[hidden]",
  '[aria-hidden="true"]',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
];

function titleFromDocument(document: Document): string | undefined {
  return document.querySelector("meta[property='og:title']")?.getAttribute("content")?.trim() || document.title.trim() || undefined;
}

function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeUrls(root: Element, document: Document, retainImages: boolean): void {
  for (const anchor of root.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href");
    if (!href) continue;
    const resolved = new URL(href, document.baseURI).toString();
    if (isSafeHttpUrl(resolved)) anchor.setAttribute("href", resolved);
    else anchor.removeAttribute("href");
  }
  for (const image of root.querySelectorAll("img")) {
    if (!retainImages) {
      image.remove();
      continue;
    }
    const src = image.getAttribute("src");
    if (!src) {
      image.remove();
      continue;
    }
    const resolved = new URL(src, document.baseURI).toString();
    if (isSafeHttpUrl(resolved)) image.setAttribute("src", resolved);
    else image.remove();
  }
}

function turndownHtml(root: Element, document: Document, retainImages: boolean): string {
  normalizeUrls(root, document, retainImages);
  const turndown = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "_",
  });
  turndown.use(gfm);
  return turndown.turndown(root as unknown as HTMLElement).replace(/\n{3,}/g, "\n\n").trim();
}

function removeChrome(root: ParentNode): void {
  for (const selector of REMOVE_SELECTORS) {
    for (const node of root.querySelectorAll(selector)) node.remove();
  }
}

function scopedContent(document: Document): Element {
  return (
    document.querySelector("main article") ??
    document.querySelector("article") ??
    document.querySelector("main") ??
    document.querySelector('[role="main"]') ??
    document.body
  );
}

function likelyClientSideShell(document: Document, text: string): boolean {
  const root = document.querySelector("#root, #app, [data-reactroot], #__next");
  const hasFrameworkPayload = Boolean(document.querySelector("script#__NEXT_DATA__, script[type='application/json'][data-sveltekit-fetched]"));
  return text.trim().length < 240 && Boolean(root || hasFrameworkPayload);
}

function extractHtml(source: Extract<LocalSource, { kind: "html" }>, retainImages: boolean): ConvertedLocalSource {
  // JSDOM does not execute scripts or load subresources under these defaults.
  const dom = new JSDOM(source.html, { url: source.sourceUrl });
  const document = dom.window.document;
  const title = source.title ?? titleFromDocument(document);
  const scoped = scopedContent(document);
  const scopedText = scoped.textContent ?? "";
  const warnings = [...source.warnings];
  let partial = likelyClientSideShell(document, scopedText);
  let method = `${source.conversionMethod} scoped extraction`;

  const contentRoot = scoped.cloneNode(true) as Element;
  removeChrome(contentRoot);

  let content = turndownHtml(contentRoot, document, retainImages);
  if (content.length < 160) {
    const article = new Readability(document.cloneNode(true) as Document, {
      charThreshold: 80,
      maxElemsToParse: 10_000,
    }).parse();
    if (article?.content) {
      const articleDom = new JSDOM(article.content, { url: source.sourceUrl });
      content = turndownHtml(articleDom.window.document.body, articleDom.window.document, retainImages);
      method = `${source.conversionMethod} Readability`;
      if (article.title && !title) warnings.push(`Extracted article: ${article.title}`);
    }
  }

  if (likelyClientSideShell(document, content)) {
    partial = true;
    warnings.push("This appears to be a client-rendered page; static fallback content may be incomplete.");
  }
  if (content.length === 0) {
    throw new Error("Local fallback: static HTML contained no extractable text.");
  }
  return { content: title ? `# ${title}\n\n${content}\n` : `${content}\n`, title, sourceUrl: source.sourceUrl, conversionMethod: method, warnings, partial };
}

/** Converts a direct Markdown or safely parsed static HTML fallback into model-ready Markdown. */
export function convertLocalSource(source: LocalSource, retainImages: boolean): ConvertedLocalSource {
  if (source.kind === "markdown") {
    const content = source.content.trim();
    if (!content) throw new Error("Local fallback: source returned no Markdown content.");
    return {
      content: `${content}\n`,
      title: source.title,
      sourceUrl: source.sourceUrl,
      conversionMethod: source.conversionMethod,
      warnings: source.warnings,
      partial: false,
    };
  }
  return extractHtml(source, retainImages);
}
