import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { fixLocalLinks } from "../../extensions/local-file-links/index.js";

const cwd = mkdtempSync(join(tmpdir(), "pi-link-test-"));
const local = "zennomi_local/000DEPLOY.md";
function create(name: string) {
  const path = join(cwd, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
  return pathToFileURL(path).href;
}
const file = create(local);
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

describe("inline local file links", () => {
  it.each([local, "/" + local, "./" + local])("falls back to the session directory: %s", href => {
    expect(fixLocalLinks(`[playbook VatLy](${href})`, cwd)).toBe(`[playbook VatLy](${file})`);
  });
  it("prefers the root candidate even if the cwd candidate exists", () => {
    const root = parse(cwd).root;
    const href = relative(root, join(cwd, local));
    create(href);
    expect(fixLocalLinks(`[x](${href})`, cwd)).toBe(`[x](${file})`);
  });
  it("preserves titles, labels, suffixes and unrelated text", () => {
    const spaced = create("folder/notes (v2).md").replace("(v2)", "%28v2%29");
    const before = `[x](<folder/notes (v2).md?tab=1#part> "Title") and [**y**](folder/notes%20%28v2%29.md)`;
    expect(fixLocalLinks(before, cwd)).toBe(`[x](${spaced}?tab=1#part "Title") and [**y**](${spaced})`);
  });
  it("does not rewrite code or images next to real links", () => {
    const examples = ["`[x](" + local + ")`", `![x](${local})`, "~~~md\n[x](" + local + ")\n~~~"].join("\n\n");
    expect(fixLocalLinks(examples + `\n\n[x](${local})`, cwd)).toBe(examples + `\n\n[x](${file})`);
  });
  it.each(["https://example.org/page", "mailto:a@b.test", "//example.org/a", "#section", "?page", file, "missing.md", "%00", "%xx"])("leaves %s alone", href => {
    const text = `[label](${href})`;
    expect(fixLocalLinks(text, cwd)).toBe(text);
  });
});
