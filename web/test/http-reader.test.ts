import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpDirReader } from "../lib/reader";

afterEach(() => vi.unstubAllGlobals());

describe("HttpDirReader", () => {
  it("lists entries from the encoded server path", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify([{ name: "run one", isDir: true }]), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(new HttpDirReader().list("alpha/run one")).resolves.toEqual([
      { name: "run one", isDir: true },
    ]);
    expect(fetchMock).toHaveBeenCalledWith("/api/fs/list?path=alpha%2Frun+one");
  });

  it("reads text and mtime from the server endpoint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ text: "contents", mtimeMs: 1234 }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(new HttpDirReader().readText("alpha/run-details/final.md")).resolves.toEqual({
      text: "contents",
      mtimeMs: 1234,
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/fs/read?path=alpha%2Frun-details%2Ffinal.md");
  });

  it("returns null for missing files and fetch failures", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(new HttpDirReader().readText("missing")).resolves.toBeNull();

    fetchMock.mockRejectedValue(new Error("offline"));
    await expect(new HttpDirReader().readText("missing")).resolves.toBeNull();
  });
});
