// One-time pairing links.
//
// A pairing code is ~300 characters of base64url — fine for a QR code, miserable
// to retype. A pairing link wraps the same code in a URL another computer can
// simply open: `notes.c0di.com/#pair=<code>`.
//
// The code travels in the URL *fragment*, which browsers never send to the web
// host, so the pairing secret stays out of server logs, caches, and referrers.
// The joining app reads it and then strips it from the address bar.

// Where shared links should point. The installed app's own origin (`tauri://…`)
// is not reachable from another computer, so links default to the public web app.
export const PAIRING_LINK_ORIGIN = "https://notes.c0di.com";

// Build the link to hand to another computer. Callers on the web pass their own
// origin so staging and local builds round-trip without leaving the site.
export function encodePairingLink(code: string, origin: string = PAIRING_LINK_ORIGIN): string {
  return `${origin.replace(/\/+$/, "")}/#pair=${encodeURIComponent(code)}`;
}

// People paste whatever they were handed — a bare code or a whole link. Accept
// both so “copy link” and “paste the code” are the same gesture.
export function pairingCodeFromText(raw: string): string {
  const value = raw.trim();
  const match = value.match(/[#?&]pair=([^&\s]+)/);
  if (!match) return value;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return value;
  }
}

// Read the code from a URL fragment (`#pair=…`), or null when Pad was opened
// normally. URLSearchParams already percent-decodes the value.
export function pairingCodeFromHash(hash: string): string | null {
  const raw = new URLSearchParams(hash.replace(/^#/, "")).get("pair");
  if (!raw) return null;
  return pairingCodeFromText(raw) || null;
}
