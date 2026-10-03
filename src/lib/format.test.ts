import { describe, expect, it } from "vitest";
import { plainPreview, previewFromMarkdown } from "./format";

describe("note previews", () => {
  it("omits embedded image data and displays link text", () => {
    expect(plainPreview("![Photo](data:image/png;base64,SECRET_IMAGE_DATA) Read [the docs](https://example.com)."))
      .toBe("Read the docs.");
  });

  it("limits a long note preview and skips its title", () => {
    const preview = previewFromMarkdown("# Title\n\n" + "A useful sentence. ".repeat(100));
    expect(preview).not.toContain("Title");
    expect(preview.length).toBe(155);
  });

  it("keeps task text without its checkbox markup", () => {
    expect(previewFromMarkdown("# Shopping\n\n- [ ] Bread\n- [x] Coffee")).toBe("Bread Coffee");
  });
});
