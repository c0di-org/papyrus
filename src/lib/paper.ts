// The paper editor stores ordinary Markdown. Keep list structure and inline
// formatting intact when the browser splits/wraps editable blocks.
export function inlineMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent || "")
    .replace(/\uFEFF/g, "").replace(/([\\`*_\[\]<>])/g, "\\$1");
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const element = node as HTMLElement;
  const children = Array.from(element.childNodes).map(inlineMarkdown).join("");
  switch (element.tagName) {
    case "STRONG": case "B": return `**${children}**`;
    case "EM": case "I": return `*${children}*`;
    case "S": case "DEL": case "STRIKE": return `~~${children}~~`;
    case "CODE": {
      const text = element.textContent || "";
      const fence = "`".repeat(Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length)) + 1);
      const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
      return `${fence}${pad}${text}${pad}${fence}`;
    }
    case "A": return `[${children}](${element.getAttribute("href") || ""})`;
    case "IMG": return `![${element.getAttribute("alt") || "Image"}](${element.getAttribute("src") || ""})`;
    case "BR": return "\n";
    case "INPUT": return "";
    default: return children;
  }
}

export function taskCheckbox(item: HTMLElement) {
  return item.querySelector<HTMLInputElement>(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]');
}

function listMarkdown(list: HTMLElement): string {
  const start = Number(list.getAttribute("start") || 1);
  return Array.from(list.children).filter((child) => child.tagName === "LI").map((child, index) => {
    const item = child as HTMLElement;
    const checkbox = taskCheckbox(item);
    const marker = list.tagName === "OL" ? `${start + index}. ` : "- ";
    const prefix = marker + (checkbox ? `[${checkbox.checked ? "x" : " "}] ` : "");
    let content = "";
    for (const node of Array.from(item.childNodes)) {
      if (node instanceof HTMLElement && /^(UL|OL)$/.test(node.tagName)) {
        content = content.trimEnd() + "\n" + listMarkdown(node).trimEnd() + "\n";
      } else if (node instanceof HTMLElement && /^(P|DIV|PRE|BLOCKQUOTE)$/.test(node.tagName)) {
        content += blockMarkdown(node);
      } else content += inlineMarkdown(node);
    }
    // A checkbox contributes to the first line's width, but continuation lines
    // align with the list marker's content column (including nested lists).
    const lines = content.trim().split("\n");
    return prefix + lines[0] + lines.slice(1).map((line) => `\n${" ".repeat(marker.length)}${line}`).join("");
  }).join("\n") + "\n\n";
}

function blockMarkdown(element: HTMLElement): string {
  const inline = () => Array.from(element.childNodes).map(inlineMarkdown).join("").trim();
  switch (element.tagName) {
    case "H1": case "H2": case "H3": case "H4": case "H5": case "H6":
      return `${"#".repeat(Number(element.tagName[1]))} ${inline()}\n\n`;
    case "UL": case "OL": return listMarkdown(element);
    case "PRE": {
      const text = element.textContent?.replace(/\n$/, "") || "";
      const fence = "`".repeat(Math.max(2, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length)) + 1);
      const language = element.querySelector("code")?.className.match(/language-([\w+-]+)/)?.[1] || "";
      return `${fence}${language}\n${text}\n${fence}\n\n`;
    }
    case "BLOCKQUOTE": {
      const content = element.children.length ? markdownFromPaper(element) : inline();
      return content.split("\n").map((line) => `> ${line}`).join("\n") + "\n\n";
    }
    case "HR": return "---\n\n";
    case "TABLE": {
      const rows = Array.from(element.querySelectorAll("tr"));
      if (!rows.length) return "";
      const cells = rows.map((row) => Array.from(row.children).map((cell) => inlineMarkdown(cell).trim().replace(/\|/g, "\\|")));
      return [cells[0], cells[0].map(() => "---"), ...cells.slice(1)].map((row) => `| ${row.join(" | ")} |`).join("\n") + "\n\n";
    }
    case "DIV": {
      // Browsers create divs for Enter and pasted content. Include their loose
      // text as well as nested blocks; children-only serialization lost it.
      return markdownFromPaper(element) + "\n\n";
    }
    default: return `${inline()}\n\n`;
  }
}

export function markdownFromPaper(root: HTMLElement): string {
  let result = "";
  let loose = "";
  const flush = () => {
    // markdown-it puts newline text nodes between rendered blocks. They are
    // layout whitespace, not additional blank paragraphs in the user's note.
    if (loose.trim()) result += loose + "\n\n";
    loose = "";
  };
  for (const node of Array.from(root.childNodes)) {
    if (node instanceof HTMLElement && /^(P|DIV|H[1-6]|UL|OL|PRE|BLOCKQUOTE|HR|TABLE)$/.test(node.tagName)) {
      flush(); result += blockMarkdown(node);
    } else loose += inlineMarkdown(node);
  }
  flush();
  return result.trimEnd();
}

export type CaretBookmark = { start: number[]; startOffset: number; end: number[]; endOffset: number };

export function saveCaret(root: HTMLElement): CaretBookmark | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const path = (node: Node) => {
    const parts: number[] = [];
    while (node !== root && node.parentNode) {
      parts.unshift(Array.from(node.parentNode.childNodes).indexOf(node as ChildNode));
      node = node.parentNode;
    }
    return parts;
  };
  return { start: path(range.startContainer), startOffset: range.startOffset, end: path(range.endContainer), endOffset: range.endOffset };
}

export function restoreCaret(root: HTMLElement, bookmark: CaretBookmark | null) {
  if (!bookmark) return;
  const find = (path: number[]) => path.reduce<Node | undefined>((node, index) => node?.childNodes[index], root);
  const start = find(bookmark.start); const end = find(bookmark.end);
  if (!start || !end) return;
  const range = document.createRange();
  range.setStart(start, Math.min(bookmark.startOffset, start.nodeType === Node.TEXT_NODE ? start.textContent!.length : start.childNodes.length));
  range.setEnd(end, Math.min(bookmark.endOffset, end.nodeType === Node.TEXT_NODE ? end.textContent!.length : end.childNodes.length));
  const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
}
