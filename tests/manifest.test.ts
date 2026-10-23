import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionsDir = join(root, "extensions");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  pi?: { extensions?: string[] };
};

const extensionNames = readdirSync(extensionsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe("pi extension manifest", () => {
  it("lists exactly one existing index.ts entry per extension directory", () => {
    const declared = [...(manifest.pi?.extensions ?? [])].sort();
    const expected = extensionNames.map((name) => `./extensions/${name}/index.ts`).sort();

    expect(declared).toEqual(expected);
    for (const entry of declared) expect(existsSync(join(root, entry))).toBe(true);
  });

  it.each(extensionNames)("%s default-exports an extension factory", async (name) => {
    const module = (await import(join(extensionsDir, name, "index.ts"))) as { default?: unknown };
    expect(typeof module.default).toBe("function");
  });

  it.each(extensionNames)("%s does not import from another extension", (name) => {
    const dir = join(extensionsDir, name);
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const source = readFileSync(join(dir, file), "utf8");
      const relativeImports = [...source.matchAll(/from\s+["'](\.[^"']+)["']/g)].map((m) => m[1]);
      for (const specifier of relativeImports) {
        expect(resolve(dir, specifier).startsWith(dir + "/"), `${name}/${file} imports ${specifier}`).toBe(true);
      }
    }
  });
});
