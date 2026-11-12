import { describe, expect, it } from "vitest";
import { sealNetwork } from "./sealNetwork";

describe("cadre isolé", () => {
  it("n’offre plus WebRTC au code d’un module, même réassigné", () => {
    const fake = { RTCPeerConnection: class {} } as unknown as Window & typeof globalThis;
    sealNetwork(fake);
    expect((fake as unknown as Record<string, unknown>).RTCPeerConnection).toBeUndefined();
    expect(() => {
      (fake as unknown as Record<string, unknown>).RTCPeerConnection = class {};
    }).toThrow();
    expect((fake as unknown as Record<string, unknown>).webkitRTCPeerConnection).toBeUndefined();
  });
});
