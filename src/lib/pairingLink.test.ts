// The pairing link lets one computer hand a one-time code to another by URL
// instead of making the person retype a 300-character code. These cover the pure
// string plumbing; the handshake itself is exercised by sync.integration.
import { describe, expect, it } from "vitest";
import {
  PAIRING_LINK_ORIGIN,
  encodePairingLink,
  pairingCodeFromHash,
  pairingCodeFromText,
} from "./pairingLink";

const CODE = "papyrus-pair-v1:eyJ2ZXJzaW9uIjoxLCJzZWNyZXQiOiJhYmMifQ";

describe("pairing links", () => {
  it("puts the code in the fragment so the secret never reaches the web host", () => {
    const link = encodePairingLink(CODE);
    expect(link).toBe(`${PAIRING_LINK_ORIGIN}/#pair=${encodeURIComponent(CODE)}`);
    expect(new URL(link).search).toBe("");
  });

  it("round-trips a link back into the exact code", () => {
    const link = encodePairingLink(CODE, "https://notes.c0di.com");
    expect(pairingCodeFromHash(new URL(link).hash)).toBe(CODE);
  });

  it("normalizes a trailing slash and a custom origin", () => {
    expect(encodePairingLink(CODE, "https://staging.example.com/")).toBe(
      `https://staging.example.com/#pair=${encodeURIComponent(CODE)}`,
    );
  });

  it("accepts a bare code or a pasted link", () => {
    expect(pairingCodeFromText(`  ${CODE}  `)).toBe(CODE);
    expect(pairingCodeFromText(encodePairingLink(CODE))).toBe(CODE);
    expect(pairingCodeFromText("https://notes.c0di.com/?pair=" + encodeURIComponent(CODE) + "&other=1")).toBe(CODE);
  });

  it("returns nothing when the app was opened without a pairing link", () => {
    expect(pairingCodeFromHash("")).toBeNull();
    expect(pairingCodeFromHash("#settings")).toBeNull();
    expect(pairingCodeFromText("")).toBe("");
  });
});
