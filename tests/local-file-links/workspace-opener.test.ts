import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { openProjectFile, workspaceLinkWidget } from "../../extensions/local-file-links/workspace-opener.js";

const cwd = "/work/My Project";
const file = "/other/folder/guide (draft) & notes.md";
const target = pathToFileURL(file).href;
const cli = "/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide";

describe("Antigravity workspace routing", () => {
  it("sends the session folder and decoded filename to the same CLI invocation", async () => {
    const run = vi.fn(async () => {}), lookup = vi.fn(async () => cli);
    expect(await openProjectFile(target, cwd, lookup, run)).toBe(true);
    expect(lookup).toHaveBeenCalledWith(file);
    expect(run).toHaveBeenCalledExactlyOnceWith(cli, ["--new-window", cwd, file]);
  });
  it.each(["https://example.com", "file://remote/tmp/file", "file:///bad%2Fname"])("leaves %s to Pi", async url => {
    const lookup = vi.fn(), run = vi.fn();
    expect(await openProjectFile(url, cwd, lookup, run)).toBe(false);
    expect(lookup).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  });
  it("preserves Pi handling when the default app differs or cannot be determined", async () => {
    const run = vi.fn();
    for (const lookup of [async () => undefined, async () => { throw Error("unavailable"); }]) {
      expect(await openProjectFile(target, cwd, lookup, run)).toBe(false);
    }
    expect(run).not.toHaveBeenCalled();
  });
  it("hooks only file clicks, delegates unhandled links unchanged, and restores on dispose", async () => {
    const open = vi.fn(), host = { openUrl: open as (url: string) => void }, warn = vi.fn();
    const route = vi.fn(async () => false);
    const widget = workspaceLinkWidget(host, cwd, warn, route);
    const installed = host.openUrl;
    expect(widget.render()).toEqual([]); expect(host.openUrl).toBe(installed);
    host.openUrl("https://example.com"); expect(route).not.toHaveBeenCalled();
    host.openUrl(target + "#part"); await Promise.resolve();
    expect(route).toHaveBeenCalledWith(target + "#part", cwd);
    expect(open.mock.calls).toEqual([["https://example.com"], [target + "#part"]]);
    widget.dispose(); expect(host.openUrl).toBe(open);
  });
  it("does not default-open a second window after an IDE launch or launch error", async () => {
    const open = vi.fn(), host = { openUrl: open as (url: string) => void }, warn = vi.fn();
    const route = vi.fn().mockResolvedValueOnce(true).mockRejectedValueOnce(Error("cli failed"));
    const widget = workspaceLinkWidget(host, cwd, warn, route);
    host.openUrl(target); host.openUrl(target);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    expect(open).not.toHaveBeenCalled(); widget.dispose();
  });
});
