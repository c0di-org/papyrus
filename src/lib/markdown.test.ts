import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("renders a checklist item's inline formatting once, not twice", () => {
    const html = renderMarkdown("- [ ] Call **Bob** about the thing");

    expect(html).toContain("<strong>Bob</strong>");
    // The <label> mode used to append the raw Markdown after the rendered text,
    // which the paper editor then serialized straight back into the note.
    expect(html).not.toContain("**Bob**");
    expect(html.match(/about the thing/g)).toHaveLength(1);
  });

  it("closes the tags around a link in a checklist item", () => {
    const html = renderMarkdown("- [ ] Read [the docs](https://example.com)");

    expect(html).toContain('<a href="https://example.com">the docs</a>');
  });

  it("keeps a code span in a checklist item literal", () => {
    const html = renderMarkdown("- [ ] Type `- [ ] ` to start a checklist");

    expect(html).toContain("<code>- [ ] </code>");
    expect(html.match(/to start a checklist/g)).toHaveLength(1);
  });

  it("still marks up the checkboxes themselves", () => {
    const html = renderMarkdown("- [ ] Waiting\n- [x] Done");

    expect(html).toContain('<ul class="contains-task-list">');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked=""');
  });

  it("reopens an empty task as a checkbox, including a completed task", () => {
    const html = renderMarkdown("- [ ]\n- [x]");
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).toContain('checked=""');
  });

  it("leaves task markers in code and escaped text literal", () => {
    const html = renderMarkdown("```\n- [ ]\n```\n\n- \\[ ]");
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("\uFEFF");
  });
});
