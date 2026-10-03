// With `npm run dev` and a disposable Playwright CLI browser session open:
// playwright-cli -s=pad-ux run-code "$(cat scripts/check-editor-ux.js)"
// Uses the browser's real selection, contenteditable, input and IndexedDB APIs.
async (page) => {
  await page.reload();
  await page.locator(".list-skeleton").waitFor({ state: "hidden" });
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const testTitle = `UX regression note ${Date.now()}`;
  const body = page.getByRole("textbox", { name: "Note body" });
  const button = (name) => page.getByRole("button", { name, exact: true });
  const markdown = () => body.evaluate(async (el) => (await import("/src/lib/paper.ts")).markdownFromPaper(el));
  const caret = (index, word) => body.evaluate((el, { index, word }) => {
    const item = el.querySelectorAll("li")[index];
    const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && word && !node.data.includes(word)) node = walker.nextNode();
    const range = document.createRange();
    range.setStart(node, word ? node.data.indexOf(word) : node.data.length); range.collapse(true);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); el.focus();
  }, { index, word });
  await page.getByRole("complementary").getByRole("button", { name: "New note", exact: true }).click();
  await body.focus();
  await page.keyboard.type("# ");
  assert(await body.locator("h1").count() === 1, "Heading shortcut did not promote");
  await page.keyboard.type(testTitle); await page.keyboard.press("Enter");
  await button("Checklist").click(); await page.keyboard.type("Plan dinner");
  await caret(0, "dinner"); await page.keyboard.press("Enter");
  assert((await markdown()).includes("- [ ] Plan\n- [ ] dinner"), "Enter lost or misplaced trailing checklist text");
  await page.keyboard.press("Meta+z");
  assert((await markdown()).includes("- [ ] Plan dinner"), "Undo did not restore the split item");
  await page.keyboard.press("Meta+Shift+z");
  assert((await markdown()).includes("- [ ] Plan\n- [ ] dinner"), "Redo did not repeat the split");
  await page.keyboard.press("Meta+z"); await caret(0);
  await page.keyboard.press("Enter"); await page.keyboard.type("Buy groceries");
  await caret(1, "groceries"); await page.keyboard.press("Tab");
  assert((await markdown()).includes("  - [ ] Buy groceries"), "Indent did not retain nested Markdown");
  await page.keyboard.type("fresh ");
  assert((await markdown()).includes("Buy fresh groceries"), "Indent moved the caret from its text offset");
  await page.keyboard.press("Shift+Tab");
  assert(!(await markdown()).includes("  - [ ] Buy"), "Outdent did not restore a sibling item");
  await caret(1); await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
  assert(await body.locator("li").count() === 2, "Empty Enter did not exit the checklist");
  await page.keyboard.type("After the list");
  assert((await markdown()).endsWith("After the list"), "Typing after the list landed in the wrong block");
  await body.getByRole("checkbox").first().click();
  assert((await markdown()).includes("- [x] Plan dinner"), "Checkbox toggle was not serialized");
  await button("Undo").click();
  assert((await markdown()).includes("- [ ] Plan dinner"), "Checkbox undo did not restore unchecked state");
  await button("Redo").click();
  assert((await markdown()).includes("- [x] Plan dinner"), "Checkbox redo did not restore checked state");
  // Enter from an Android/software keyboard that sends no keydown.
  await caret(1);
  await body.evaluate((el) => el.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertParagraph", bubbles: true, cancelable: true })));
  assert(await body.locator("li").count() === 3, "Software keyboard Enter did not continue the list");
  await button("Undo").click();
  const savedBody = await markdown();
  await page.waitForFunction(async ({ expected, title }) => {
    const { api } = await import("/src/lib/api.ts");
    const notes = await api.listNotes("all", title);
    if (!notes[0]) return false;
    return (await api.getNote(notes[0].id))?.body === expected;
  }, { expected: savedBody, title: testTitle });
  await page.getByRole("complementary").getByRole("button", { name: "New note", exact: true }).click();
  assert(await button("Undo").isDisabled(), "Undo history leaked into a different note");
  await page.getByRole("complementary").getByRole("button", { name: testTitle, exact: true }).click();
  await body.getByRole("heading", { name: testTitle, exact: true }).waitFor();
  assert(await markdown() === savedBody, `Save and reopen changed the document: ${JSON.stringify({ expected: savedBody, actual: await markdown() })}`);
  await caret(1); await button("Bulleted list").click();
  assert(await body.getByRole("checkbox").count() === 0, "Checklist to bullets left orphaned checkboxes");
  assert(await body.locator("ul > li").count() === 2, "Checklist to bullets removed the list");
  await button("Numbered list").click();
  assert(await body.locator("ol > li").count() === 2, "Bullets to numbers changed the items");
  await button("Checklist").click();
  assert(await body.getByRole("checkbox").count() === 2, "Numbered list to checklist lost items");
  await button("Undo").click(); await button("Undo").click(); await button("Undo").click();
  assert(await markdown() === savedBody, "Undo did not restore list conversions and checked state");
  await page.getByRole("textbox", { name: "Search notes" }).fill("does-not-exist-ux-check");
  await page.getByText("No matching notes", { exact: true }).waitFor();
  await button("Clear search").first().click();
  await page.getByRole("complementary").getByRole("button", { name: testTitle, exact: true }).waitFor();
  await button(`Actions for ${testTitle}`).click();
  await button("Open").waitFor(); await page.keyboard.press("Escape");
  const roundTrips = await page.evaluate(async () => {
    const { renderMarkdown } = await import("/src/lib/markdown.ts");
    const { markdownFromPaper } = await import("/src/lib/paper.ts");
    const fixtures = [
      "- Parent\n  - Child\n    - Grandchild\n- Sibling",
      "- [ ] Parent\n  - [x] Child\n- [x] Done",
      "4. Four\n5. Five\n   - Child",
      "- [ ] Call **Bob** about [the docs](https://example.com)\n- [x] Type `- [ ] `",
      "> **Bold** and *italic*\n>\n> - One\n> - Two",
      "```ts\nconst code = `literal`;\n```",
      "| Heading | Other |\n| --- | --- |\n| a \\| b | c |",
      "- First paragraph\n\n  Second paragraph\n\n  - Nested\n\n- Next item",
      "# Heading\n\nLiteral \\*stars\\* and \\[brackets\\].",
    ];
    for (const source of fixtures) {
      const root = document.createElement("article"); root.innerHTML = renderMarkdown(source);
      const serialized = markdownFromPaper(root);
      const reopened = document.createElement("article"); reopened.innerHTML = renderMarkdown(serialized);
      const shape = (el) => Array.from(el.querySelectorAll("ul,ol,li,p,h1,strong,em,a,code,pre,blockquote,th,td,input")).map((node) => [node.tagName, node.getAttribute("start"), node.tagName === "INPUT" ? node.checked : node.textContent.trim()]);
      if (JSON.stringify(shape(root)) !== JSON.stringify(shape(reopened))) throw new Error(`Markdown round trip changed structure: ${source}\nSerialized: ${serialized}`);
    }
    const loose = document.createElement("article"); loose.innerHTML = "<div>First line</div><div>Second line</div>";
    if (markdownFromPaper(loose) !== "First line\n\nSecond line") throw new Error("Browser divs lost their text");
    return fixtures.length + 1;
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await button("Checklist").isVisible(), "Checklist action is hidden on a phone");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert(!overflow, "Phone layout overflows horizontally");
  await page.waitForFunction(() => !document.querySelector(".rail").getAnimations().length && !document.querySelector(".note-pane").getAnimations().length);
  await page.screenshot({ path: "output/playwright/editor-mobile.png" });
  await button("Back to notes").click();
  await button(`Actions for ${testTitle}`).click(); await button("Open").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("complementary").getByRole("button", { name: testTitle, exact: true }).click();
  await page.setViewportSize({ width: 1120, height: 760 });
  await page.screenshot({ path: "output/playwright/editor-desktop.png" });
  await body.evaluate((el) => {
    const childList = document.createElement("ul");
    childList.innerHTML = '<li class="task-list-item"><input type="checkbox" checked contenteditable="false">Nested completed task</li>';
    el.querySelectorAll("li")[1].append(childList);
  });
  await caret(1, "groceries"); await page.keyboard.press("Enter");
  assert(await body.getByRole("checkbox").count() === 4, "Splitting a parent removed a nested checkbox");
  assert((await markdown()).includes("  - [x] Nested completed task"), "Splitting a parent lost a nested task's checked state");
  await button("Undo").click();
  return { result: "Passed", flows: "headings, checklist split/continue/exit, nested lists, cursor, undo/redo, software keyboard, autosave/reopen, search, note actions, phone layout", markdownRoundTrips: roundTrips };
}
