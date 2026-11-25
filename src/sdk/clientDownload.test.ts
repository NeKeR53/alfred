import { afterEach, describe, expect, it, vi } from "vitest";
import { type ClientDownload, client } from "./index";
import { ALFRED_MESSAGE, type FrameRequest } from "./protocol";

describe("client(id).download", () => {
  afterEach(() => vi.restoreAllMocks());

  it("demande un fichier temporaire borné en taille et rend son chemin", async () => {
    const sent: FrameRequest[] = [];
    const temporary = {
      path: "/espace/.alfred/tmp/downloads/a-episode.mp3",
      name: "episode.mp3",
      mime: "audio/mpeg",
      size: 19,
      sha256: "ab",
    };
    vi.spyOn(window.parent, "postMessage").mockImplementation((message: unknown) => {
      const request = message as FrameRequest;
      sent.push(request);
      const result: ClientDownload = { status: 200, ok: true, headers: {}, file: null, temporary };
      window.dispatchEvent(
        new MessageEvent("message", {
          source: window,
          data: { alfred: ALFRED_MESSAGE, kind: "response", id: request.id, result },
        }),
      );
    });

    const reponse = await client("episodes", { instance: "maison" }).download("/p/episode.mp3", {
      temporary: true,
      maxSize: 50 * 1024 * 1024,
      query: { t: 1 },
    });

    expect(reponse.temporary?.path).toBe(temporary.path);
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe("clients.download");
    expect(sent[0].params).toEqual({
      client: "episodes",
      instance: "maison",
      path: "/p/episode.mp3",
      temporary: true,
      maxSize: 50 * 1024 * 1024,
      query: { t: 1 },
    });
  });
});
