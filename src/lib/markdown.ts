import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";

// No `label`/`labelAfter`: that mode drops the item's last inline token and
// re-emits the item's *raw* Markdown inside a <label>, so any checklist item
// carrying inline formatting rendered its text twice ("Call **Bob** about the
// thing" → "Call Bob Call **Bob** about the thing"), and a link left an unclosed
// <a>. The paper editor serializes the DOM back to Markdown, so that duplication
// saved itself into the note. Nothing styles the label — the checkbox is clickable
// on its own — so the wrapper only ever cost us.
const markdown = new MarkdownIt({ html: false, linkify: true, typographer: true, breaks: true }).use(taskLists, {
  enabled: true,
});

// Markdown parsers trim an empty task's trailing space. Give only empty list
// items a cursor host before the task plugin runs, so a newly continued task
// reopens as a checkbox. Its Markdown remains the portable "- [ ]" marker.
markdown.core.ruler.before("github-task-lists", "empty-task-items", (state) => {
  for (let index = 2; index < state.tokens.length; index++) {
    const token = state.tokens[index];
    if (token.type !== "inline" || state.tokens[index - 1].type !== "paragraph_open" ||
      state.tokens[index - 2].type !== "list_item_open" || !/^\[[ xX]\]$/.test(token.content)) continue;
    const text = token.children?.[0];
    if (text?.type !== "text") continue;
    token.content += " \uFEFF"; text.content += " \uFEFF";
  }
});

export function renderMarkdown(source: string) {
  return markdown.render(source);
}

export function renderedText(source: string) {
  const div = document.createElement("div");
  div.innerHTML = renderMarkdown(source);
  return div.textContent || "";
}
