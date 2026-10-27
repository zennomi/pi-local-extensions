import { describe, expect, it } from "vitest";
import { assessContent } from "../../extensions/web-fetch/content-quality.js";

describe("assessContent", () => {
  it("recognizes a Reddit block page", () => {
    const result = assessContent(
      "# Reddit\n\nYou've been blocked by network security.\n\nPlease log in to continue.",
    );

    expect(result).toMatchObject({ thin: true, blocked: true, reason: "block or challenge page" });
  });

  it("recognizes a Cloudflare challenge", () => {
    const result = assessContent("# Just a moment...\n\nChecking your browser before accessing the site.");

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("block or challenge page");
  });

  it("does not reject a long article that mentions captcha", () => {
    const article = `${"This is useful article content about browser automation. ".repeat(45)}\n\nThe captcha discussion is included as background.`;
    const result = assessContent(article);

    expect(result.textChars).toBeGreaterThanOrEqual(2_000);
    expect(result).toMatchObject({ thin: false, blocked: false });
  });

  it("counts meaningful text rather than image and link URLs", () => {
    const result = assessContent(
      `![A very large image description](https://example.com/${"image/".repeat(80)}file.png)\n\n[Documentation](https://example.com/${"path/".repeat(80)}page)`,
    );

    expect(result.textChars).toBe("Documentation".length);
    expect(result.thin).toBe(true);
  });

  it("marks partial static extraction as blocked", () => {
    expect(assessContent("A short shell", { partial: true })).toMatchObject({
      blocked: true,
      reason: "partial content",
    });
  });

  it("marks a target HTTP error as blocked", () => {
    expect(assessContent("A response body", { targetStatus: 403 })).toMatchObject({
      blocked: true,
      reason: "target returned HTTP 403",
    });
  });
});
