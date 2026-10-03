import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon } from "./Icon";
import { markdownFromPaper, taskCheckbox, saveCaret, restoreCaret, type CaretBookmark } from "../lib/paper";
import { renderMarkdown } from "../lib/markdown";
import { imageFilesFrom, readImageFile } from "../lib/images";

type Menu = { left: number; top: number } | null;
type Props = {
  value: string;
  onChange: (markdown: string) => void;
  onInsertImage: () => Promise<string | null>;
  onNotice?: (message: string) => void;
  autoFocus?: boolean;
};

const blockSelector = "div, p, h1, h2, h3, h4, h5, h6, li, blockquote, pre";
const commitDelay = 120;
const maxCommitDelay = 400;

function closestBlock(node: Node | null) {
  const element = node instanceof HTMLElement ? node : node?.parentElement;
  return element?.closest<HTMLElement>("li") || element?.closest<HTMLElement>(blockSelector) || null;
}

function placeCaretAtEnd(element: HTMLElement) {
  const selection = window.getSelection(); const range = document.createRange();
  range.selectNodeContents(element); range.collapse(false); selection?.removeAllRanges(); selection?.addRange(range);
}

function placeCaretInText(text: Text) {
  const selection = window.getSelection(); const range = document.createRange();
  range.setStart(text, text.data.length); range.collapse(true); selection?.removeAllRanges(); selection?.addRange(range);
}

export default function PaperEditor({ value, onChange, onInsertImage, onNotice, autoFocus = false }: Props) {
  const paper = useRef<HTMLElement>(null);
  const [dragActive, setDragActive] = useState(false);
  // Start unset so a note opened directly into paper mode is rendered on mount.
  const knownValue = useRef<string | null>(null);
  const savedSelection = useRef<Range | null>(null);
  const pendingCommit = useRef<number | null>(null);
  const dirtySince = useRef<number | null>(null);
  const pendingExternalValue = useRef<string | null>(null);
  const menuElement = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [formats, setFormats] = useState({ bold: false, italic: false, list: "", heading: "p" });
  type Snapshot = { html: string; caret: CaretBookmark | null };
  const undoStack = useRef<Snapshot[]>([]);
  const redoStack = useRef<Snapshot[]>([]);
  const lastEdit = useRef({ time: 0, type: "" });
  const [historyState, setHistoryState] = useState({ undo: false, redo: false });
  const composing = useRef(false);

  const snapshot = (): Snapshot | null => paper.current ? { html: paper.current.innerHTML, caret: saveCaret(paper.current) } : null;
  const updateHistory = () => setHistoryState({ undo: undoStack.current.length > 0, redo: redoStack.current.length > 0 });
  const captureEdit = (type = "command") => {
    const now = performance.now();
    const grouped = (type === "insertText" || type === "deleteContentBackward") && lastEdit.current.type === type && now - lastEdit.current.time < 600;
    lastEdit.current = { time: now, type };
    // A typing burst shares one snapshot. Avoid reading the entire innerHTML on
    // every keystroke, especially in notes with embedded images.
    if (grouped) return;
    const before = snapshot(); if (!before) return;
    if (undoStack.current[undoStack.current.length - 1]?.html !== before.html) {
      undoStack.current.push(before);
      if (undoStack.current.length > 100) undoStack.current.shift();
      while (undoStack.current.length > 1 && undoStack.current.reduce((size, entry) => size + entry.html.length, 0) > 16 * 1024 * 1024) undoStack.current.shift();
    }
    redoStack.current = []; updateHistory();
  };
  const travelHistory = (redo = false) => {
    const from = redo ? redoStack.current : undoStack.current;
    const to = redo ? undoStack.current : redoStack.current;
    const next = from.pop(); const before = snapshot();
    if (!next || !before || !paper.current) return;
    to.push(before); paper.current.innerHTML = next.html; paper.current.focus(); restoreCaret(paper.current, next.caret);
    savedSelection.current = null; lastEdit.current = { time: 0, type: "" }; updateHistory(); scheduleCommit(); rememberSelection();
  };

  const applyValue = (next: string) => {
    if (!paper.current) return;
    paper.current.innerHTML = renderMarkdown(next);
    paper.current.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((check) => {
      check.contentEditable = "false"; check.setAttribute("aria-label", "Mark task complete");
    });
    knownValue.current = next;
    pendingExternalValue.current = null;
    undoStack.current = []; redoStack.current = []; savedSelection.current = null; updateHistory();
  };

  useEffect(() => {
    if (!paper.current) return;
    if (knownValue.current === null) { applyValue(value); return; }
    if (value === knownValue.current) {
      // A newer local React update may have caught up after an external value was
      // deferred. Do not leave that superseded external snapshot queued for blur.
      pendingExternalValue.current = null;
      return;
    }
    // The DOM is authoritative for as long as the user is actively editing. Even a
    // legitimate sync refresh must not replace innerHTML under an active caret.
    if (pendingCommit.current !== null || document.activeElement === paper.current) {
      pendingExternalValue.current = value;
      return;
    }
    applyValue(value);
  }, [value]);

  useLayoutEffect(() => { if (autoFocus) paper.current?.focus(); }, []);

  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: MouseEvent) => {
      if (!menuElement.current?.contains(event.target as Node)) setMenu(null);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(null); };
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", dismiss); document.removeEventListener("keydown", escape); };
  }, [menu]);

  // Keep the menu on-screen: opened at the tap point it can run off the right or
  // bottom edge (badly, on a narrow phone). Measure it and nudge it back inside.
  useLayoutEffect(() => {
    if (!menu || !menuElement.current) return;
    const rect = menuElement.current.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(menu.left, window.innerWidth - rect.width - margin));
    const top = Math.max(margin, Math.min(menu.top, window.innerHeight - rect.height - margin));
    if (Math.abs(left - menu.left) > 0.5 || Math.abs(top - menu.top) > 0.5) setMenu({ left, top });
  }, [menu]);

  const commit = () => {
    if (pendingCommit.current !== null) {
      window.clearTimeout(pendingCommit.current);
      pendingCommit.current = null;
    }
    dirtySince.current = null;
    if (!paper.current) return;
    const markdown = markdownFromPaper(paper.current);
    if (markdown === knownValue.current) return;
    // A real local edit wins over an external value that arrived while the caret was
    // active. React/storage will reconcile from this newer local draft instead.
    pendingExternalValue.current = null;
    knownValue.current = markdown;
    onChange(markdown);
  };

  // DOM → Markdown serialization walks the full document. Keep it off the immediate
  // input/keydown path and coalesce a burst of keystrokes, but cap the delay so the
  // React model and autosave never trail a long typing session by more than ~400ms.
  const scheduleCommit = () => {
    const now = performance.now();
    if (dirtySince.current === null) dirtySince.current = now;
    if (pendingCommit.current !== null) window.clearTimeout(pendingCommit.current);
    const elapsed = now - dirtySince.current;
    const delay = elapsed >= maxCommitDelay ? 0 : Math.min(commitDelay, maxCommitDelay - elapsed);
    pendingCommit.current = window.setTimeout(() => {
      pendingCommit.current = null;
      commit();
    }, delay);
  };

  const flushOnBlur = () => {
    commit();
    const pending = pendingExternalValue.current;
    // If the user merely parked the caret while a remote/storage refresh arrived,
    // apply it once focus leaves. If they edited, commit() cleared it and local wins.
    if (pending !== null && pending !== knownValue.current) applyValue(pending);
  };

  useEffect(() => () => {
    if (pendingCommit.current !== null) window.clearTimeout(pendingCommit.current);
  }, []);

  // Insert dropped/pasted images at the caret. `caret` places the caret first (used by
  // drop, where the caret should land where the file was released).
  const insertImageFiles = async (files: File[], caret?: Range | null) => {
    if (!files.length || !paper.current) return;
    paper.current.focus();
    if (caret) {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(caret);
    }
    for (const file of files) {
      try {
        const source = await readImageFile(file);
        if (!paper.current) return;
        captureEdit();
        document.execCommand("insertImage", false, source);
      } catch (error) {
        onNotice?.(error instanceof Error ? error.message : "Could not add that image.");
      }
    }
    scheduleCommit();
  };

  const rememberSelection = () => {
    const selection = window.getSelection();
    if (!paper.current || !selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    const ancestor = range.commonAncestorContainer;
    if (ancestor !== paper.current && !paper.current.contains(ancestor)) return;
    savedSelection.current = range.cloneRange();
    const block = closestBlock(selection.anchorNode);
    const item = block?.closest("li");
    setFormats({ bold: document.queryCommandState("bold"), italic: document.queryCommandState("italic"),
      list: item ? taskCheckbox(item) ? "checklist" : item.parentElement?.tagName === "OL" ? "numbers" : "bullets" : "",
      heading: block && /^H[1-6]$/.test(block.tagName) ? block.tagName.toLowerCase() : "p" });
  };

  const restoreSelection = () => {
    const selection = window.getSelection();
    const range = savedSelection.current;
    if (!selection || !range || !paper.current) return;
    const ancestor = range.commonAncestorContainer;
    if (ancestor !== paper.current && !paper.current.contains(ancestor)) return;
    selection.removeAllRanges(); selection.addRange(range);
  };

  const selectedBlock = () => {
    const selection = window.getSelection();
    let block = closestBlock(selection?.rangeCount ? selection.getRangeAt(0).startContainer : null);
    if (block && paper.current?.contains(block)) return block;
    if (!paper.current) return null;
    // Only wrap loose text into a paragraph when there is no block structure yet.
    // Never collapse existing blocks — that happens when the caret sits outside any
    // block (e.g. right after toggling a checkbox) and would merge the title away.
    if (paper.current.children.length) return null;
    block = document.createElement("p");
    while (paper.current.firstChild) block.append(paper.current.firstChild);
    if (!block.childNodes.length) block.append(document.createElement("br"));
    paper.current.append(block); placeCaretAtEnd(block);
    return block;
  };

  // Every leaf block the current selection touches, in document order. A collapsed
  // caret yields the single block it sits in; a range spanning several lines yields
  // them all — which is what lets one "Checklist" tap convert a whole list.
  const selectedBlocks = (): HTMLElement[] => {
    const selection = window.getSelection();
    if (!paper.current || !selection?.rangeCount) {
      const single = selectedBlock();
      return single ? [single] : [];
    }
    const range = selection.getRangeAt(0);
    if (range.collapsed) { const single = selectedBlock(); return single ? [single] : []; }
    const all = Array.from(paper.current.querySelectorAll<HTMLElement>(blockSelector)).filter((block) => range.intersectsNode(block));
    // Drop container blocks (e.g. a blockquote wrapping selected paragraphs) so we
    // only act on the leaves and never convert the same text twice.
    const leaves = all.filter((block) => block.tagName === "LI" || (!block.closest("li") && !all.some((other) => other !== block && block.contains(other))));
    if (leaves.length) return leaves;
    const single = selectedBlock();
    return single ? [single] : [];
  };

  const ensureCheckbox = (item: HTMLElement, checked = false) => {
    let check = taskCheckbox(item);
    if (!check) {
      check = document.createElement("input"); check.type = "checkbox"; check.contentEditable = "false";
      item.insertBefore(check, item.firstChild);
    }
    check.checked = checked || check.checked;
    check.toggleAttribute("checked", check.checked);
    check.setAttribute("aria-label", "Mark task complete");
    item.classList.add("task-list-item");
  };

  // Build a checklist <li> from any block, carrying its inline content (bold, links,
  // etc.) across rather than flattening to plain text.
  const buildTaskItem = (block: HTMLElement): HTMLLIElement => {
    const item = document.createElement("li"); item.className = "task-list-item";
    const check = document.createElement("input"); check.type = "checkbox"; check.contentEditable = "false";
    const existing = block.querySelector<HTMLInputElement>(':scope > input[type="checkbox"]');
    check.checked = existing?.checked ?? false; check.toggleAttribute("checked", check.checked);
    check.setAttribute("aria-label", "Mark task complete");
    item.append(check);
    const content = Array.from(block.childNodes).filter((node) => !(node instanceof HTMLInputElement && node.type === "checkbox"));
    if (content.some((node) => (node.textContent || "").trim())) content.forEach((node) => item.append(node));
    else item.append(document.createTextNode("\uFEFF"));
    return item;
  };

  // Merge runs of adjacent top-level <ul> siblings so converting several paragraphs
  // yields one checklist rather than a stack of single-item lists.
  const mergeAdjacentLists = (root: HTMLElement) => {
    let child = root.firstElementChild;
    while (child) {
      const next = child.nextElementSibling;
      if (child.tagName === "UL" && next?.tagName === "UL") {
        while (next.firstChild) child.append(next.firstChild);
        next.remove();
        continue;
      }
      child = next;
    }
  };

  // Returns the task items this block produced, so the caller can land the caret
  // on the real conversion rather than hunting for the last checklist in the note.
  const convertBlockToTask = (block: HTMLElement, processedLists: Set<HTMLElement>): HTMLElement[] => {
    const parent = block.parentElement;
    if (block.tagName === "LI" && parent?.tagName === "UL") { ensureCheckbox(block); return [block]; }
    if (block.tagName === "LI" && parent?.tagName === "OL") {
      // A numbered list can't carry checkboxes in Markdown, so convert the whole
      // list to a bulleted checklist (once, however many of its items were caught).
      if (processedLists.has(parent)) return [];
      processedLists.add(parent);
      const list = document.createElement("ul");
      const items = Array.from(parent.children).filter((child) => child.tagName === "LI") as HTMLElement[];
      items.forEach((item) => { ensureCheckbox(item); list.append(item); });
      parent.replaceWith(list);
      return items;
    }
    const list = document.createElement("ul");
    const item = buildTaskItem(block);
    list.append(item);
    block.replaceWith(list);
    return [item];
  };

  const applyChecklist = () => {
    const blocks = selectedBlocks();
    if (!blocks.length || !paper.current) return;
    const processedLists = new Set<HTMLElement>();
    const converted = blocks.flatMap((block) => convertBlockToTask(block, processedLists));
    mergeAdjacentLists(paper.current);
    const last = converted[converted.length - 1];
    if (last?.isConnected) placeCaretAtEnd(last);
  };

  const applyList = (ordered: boolean) => {
    const blocks = selectedBlocks();
    const lists = new Set(blocks.filter((block) => block.tagName === "LI").map((block) => block.parentElement!));
    const tag = ordered ? "OL" : "UL";
    // A checklist is already a UL. Browser toggling would remove the list while
    // leaving its checkboxes behind, so explicitly convert its items first.
    if (lists.size && blocks.every((block) => block.tagName === "LI") &&
      Array.from(lists).some((list) => list.tagName !== tag || Array.from(list.children).some((item) => taskCheckbox(item as HTMLElement)))) {
      for (const list of lists) {
        Array.from(list.children).forEach((item) => { taskCheckbox(item as HTMLElement)?.remove(); item.classList.remove("task-list-item"); });
        if (list.tagName !== tag) {
          const replacement = document.createElement(tag.toLowerCase());
          while (list.firstChild) replacement.append(list.firstChild);
          list.replaceWith(replacement);
        }
      }
      placeCaretAtEnd(blocks[blocks.length - 1]);
    } else document.execCommand(ordered ? "insertOrderedList" : "insertUnorderedList");
  };

  const promoteToChecklist = (block: HTMLElement, text: string, checked = false) => {
    const check = document.createElement("input"); check.type = "checkbox"; check.checked = checked; check.toggleAttribute("checked", checked); check.contentEditable = "false";
    check.setAttribute("aria-label", "Mark task complete");
    // A zero-width cursor host keeps the caret visibly after a fresh checkbox.
    // It is stripped during Markdown serialization.
    const taskText = document.createTextNode(text || "\uFEFF");
    if (block.tagName === "LI" && block.parentElement?.tagName === "UL") {
      block.className = "task-list-item";
      block.replaceChildren(check, taskText);
      placeCaretInText(taskText);
      return;
    }
    const list = document.createElement("ul"); const item = document.createElement("li");
    item.className = "task-list-item";
    item.append(check, taskText); list.append(item); block.replaceWith(list); placeCaretInText(taskText);
  };

  // Keep clipboard actions available in the desktop formatting menu. Touch
  // devices also retain their native long-press selection and paste controls.
  const runClipboard = async (command: "cut" | "copy" | "paste" | "selectall") => {
    if (!paper.current) return;
    if (command === "selectall") {
      const range = document.createRange(); range.selectNodeContents(paper.current);
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      return;
    }
    if (command === "paste") {
      try {
        const text = await navigator.clipboard.readText();
        if (text) { captureEdit(); document.execCommand("insertText", false, text); }
      } catch { onNotice?.("Pasting isn't available here — try a long-press paste."); }
      scheduleCommit();
      return;
    }
    if (command === "cut") captureEdit();
    try { document.execCommand(command); } catch { onNotice?.(command === "cut" ? "Couldn't cut that selection." : "Couldn't copy that selection."); }
    if (command === "cut") scheduleCommit();
  };

  type Command = "p" | "h1" | "h2" | "h3" | "bold" | "italic" | "link" | "code" | "bullets" | "numbers" | "checklist" | "image" | "cut" | "copy" | "paste" | "selectall";

  const useCommand = async (command: Command) => {
    restoreSelection(); paper.current?.focus();
    if (command === "cut" || command === "copy" || command === "paste" || command === "selectall") {
      await runClipboard(command);
      if (command !== "selectall") setMenu(null);
      return;
    }
    captureEdit();
    if (command === "checklist") {
      const blocks = selectedBlocks();
      if (blocks.length && blocks.every((block) => block.tagName === "LI" && taskCheckbox(block))) {
        blocks.forEach((block) => { taskCheckbox(block)?.remove(); block.classList.remove("task-list-item"); });
      } else applyChecklist();
    }
    else if (command === "bullets") applyList(false);
    else if (command === "numbers") applyList(true);
    else if (command === "bold" || command === "italic") document.execCommand(command);
    else if (command === "link") {
      const address = window.prompt("Link address");
      if (address) document.execCommand("createLink", false, address);
    } else if (command === "code") document.execCommand("formatBlock", false, "pre");
    else if (command === "image") {
      const image = await onInsertImage();
      if (image && paper.current) { restoreSelection(); paper.current.focus(); captureEdit(); document.execCommand("insertImage", false, image); }
    } else document.execCommand("formatBlock", false, command);
    setMenu(null); scheduleCommit(); rememberSelection();
  };

  const applyShortcut = () => {
    const selection = window.getSelection();
    if (composing.current || !selection?.isCollapsed) return;
    const block = selectedBlock();
    if (!block || /^(PRE|BLOCKQUOTE)$/.test(block.tagName) || block.querySelector("strong, em, code, a, img")) return;
    const text = (block.textContent || "").replace(/\uFEFF/g, "").replace(/\u00A0/g, " ");
    const heading = /^(P|DIV)$/.test(block.tagName) ? text.match(/^(#{1,3}) $/) : null;
    if (heading) {
      const replacement = document.createElement(`h${heading[1].length}`);
      replacement.append(document.createElement("br")); block.replaceWith(replacement); placeCaretAtEnd(replacement); return;
    }
    const task = text.match(/^(?:- )?\[([ xX])\] $/);
    if (task && !taskCheckbox(block)) {
      promoteToChecklist(block, "", task[1].toLowerCase() === "x"); return;
    }
    if (!/^(P|DIV)$/.test(block.tagName)) return;
    const listMatch = text.match(/^([-*+] |1[.)] )$/);
    if (listMatch) {
      const list = document.createElement(/^[1]/.test(text) ? "ol" : "ul");
      const item = document.createElement("li"); const cursor = document.createTextNode("\uFEFF");
      item.append(cursor); list.append(item); block.replaceWith(list); placeCaretInText(cursor);
    }
  };

  // Extract everything after the caret, preserving links, bold text and nested
  // lists. Enter creates a new unchecked task even when the original was done.
  const continueList = () => {
    const item = selectedBlock(); const selection = window.getSelection();
    if (!item || !selection?.rangeCount) return false;
    const range = selection.getRangeAt(0);
    if (/^H[1-6]$/.test(item.tagName)) {
      if (!item.contains(range.endContainer)) return false;
      captureEdit(); if (!range.collapsed) range.deleteContents();
      const trailing = document.createRange(); trailing.selectNodeContents(item); trailing.setStart(range.startContainer, range.startOffset);
      const paragraph = document.createElement("p"); const cursor = document.createTextNode("\uFEFF");
      paragraph.append(cursor, trailing.extractContents()); item.after(paragraph); placeCaretInText(cursor); return true;
    }
    const li = item.closest("li"); const list = li?.parentElement;
    if (!li || !list || !/^(UL|OL)$/.test(list.tagName)) return false;
    if (!li.contains(range.endContainer)) return false;
    captureEdit();
    if (!range.collapsed) range.deleteContents();
    if (!(li.textContent || "").replace(/\uFEFF/g, "").trim() && !li.querySelector("img, ul, ol")) {
      outdentItem(li); return true;
    }
    const trailing = document.createRange(); trailing.selectNodeContents(li); trailing.setStart(range.startContainer, range.startOffset);
    const next = document.createElement("li"); const cursor = document.createTextNode("\uFEFF");
    if (taskCheckbox(li)) { ensureCheckbox(next); next.append(cursor); }
    else next.append(cursor);
    next.append(trailing.extractContents());
    next.querySelectorAll(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]').forEach((check) => { if (check !== taskCheckbox(next)) check.remove(); });
    list.insertBefore(next, li.nextSibling); placeCaretInText(cursor); return true;
  };

  const outdentItem = (item: HTMLLIElement) => {
    const list = item.parentElement!; const parentItem = list.parentElement?.closest("li");
    if (parentItem) {
      // Following siblings remain children of this item, preserving their order.
      if (item.nextElementSibling) {
        const children = document.createElement(list.tagName.toLowerCase());
        while (item.nextElementSibling) children.append(item.nextElementSibling);
        item.append(children);
      }
      parentItem.after(item); if (!list.children.length) list.remove(); return;
    }
    const tail = list.cloneNode(false) as HTMLElement;
    if (list.tagName === "OL") tail.setAttribute("start", String(Number(list.getAttribute("start") || 1) + Array.from(list.children).indexOf(item) + 1));
    while (item.nextElementSibling) tail.append(item.nextElementSibling);
    const paragraph = document.createElement("p"); const cursor = document.createTextNode("\uFEFF");
    taskCheckbox(item)?.remove(); paragraph.append(cursor);
    const nested = Array.from(item.children).filter((child) => /^(UL|OL)$/.test(child.tagName));
    nested.forEach((child) => child.remove());
    while (item.firstChild) paragraph.append(item.firstChild);
    item.remove(); list.after(paragraph); let after: Element = paragraph;
    for (const child of nested) { after.after(child); after = child; }
    if (tail.children.length) after.after(tail);
    if (!list.children.length) list.remove(); placeCaretInText(cursor);
  };

  const indentSelection = (outdent = false) => {
    const selection = window.getSelection(); const item = closestBlock(selection?.anchorNode || null)?.closest("li");
    if (!item || !paper.current?.contains(item)) return false;
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const bookmark = range ? { start: range.startContainer, startOffset: range.startOffset, end: range.endContainer, endOffset: range.endOffset } : null;
    if (!outdent && !item.previousElementSibling) return true;
    captureEdit();
    if (outdent) outdentItem(item);
    else {
      const previous = item.previousElementSibling!; const tag = item.parentElement!.tagName;
      let nested = Array.from(previous.children).reverse().find((child) => child.tagName === tag);
      if (!nested) { nested = document.createElement(tag.toLowerCase()); previous.append(nested); }
      nested.append(item);
    }
    // Moving an existing node can collapse live Ranges. Place the caret back in
    // its content rather than letting the next keystroke land in its old parent.
    if (bookmark && bookmark.start.isConnected && bookmark.end.isConnected) {
      const restored = document.createRange(); restored.setStart(bookmark.start, bookmark.startOffset); restored.setEnd(bookmark.end, bookmark.endOffset);
      selection?.removeAllRanges(); selection?.addRange(restored);
    }
    else if (item.isConnected) placeCaretAtEnd(item);
    scheduleCommit(); rememberSelection(); return true;
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    // Cmd/Ctrl+N is handled by App at the window level and does not naturally move
    // focus first. Force a blur here so the old note's DOM is committed before App
    // swaps in the fresh note; ordinary pointer navigation already blurs naturally.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
      paper.current?.blur();
      return;
    }
    if (event.nativeEvent.isComposing) return;
    if (/^(Arrow|Home|End|Page)/.test(event.key)) lastEdit.current = { time: 0, type: "" };
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); travelHistory(event.shiftKey); return; }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y") { event.preventDefault(); travelHistory(true); return; }
    if (event.key === "Tab" && indentSelection(event.shiftKey)) { event.preventDefault(); return; }
    if (event.key === "Enter" && !event.shiftKey && continueList()) { event.preventDefault(); scheduleCommit(); rememberSelection(); }
    if (event.key === "Backspace") {
      const selection = window.getSelection(); const item = closestBlock(selection?.anchorNode || null)?.closest("li");
      if (!item || !selection?.isCollapsed || !selection.rangeCount) return;
      const range = selection.getRangeAt(0).cloneRange(); range.selectNodeContents(item); range.setEnd(selection.anchorNode!, selection.anchorOffset);
      if (!range.toString().replace(/\uFEFF/g, "")) { event.preventDefault(); captureEdit(); outdentItem(item); scheduleCommit(); rememberSelection(); }
    }
  };

  useEffect(() => {
    const changed = () => { if (document.activeElement === paper.current) rememberSelection(); };
    const beforeInput = (event: InputEvent) => {
      if (event.inputType === "historyUndo" || event.inputType === "historyRedo") { event.preventDefault(); travelHistory(event.inputType === "historyRedo"); }
      // Software keyboards often send beforeinput without an Enter keydown.
      else if (event.inputType === "insertParagraph" && !composing.current && continueList()) { event.preventDefault(); scheduleCommit(); rememberSelection(); }
      else if (!composing.current) captureEdit(event.inputType);
    };
    const host = paper.current;
    host?.addEventListener("beforeinput", beforeInput);
    document.addEventListener("selectionchange", changed);
    return () => { host?.removeEventListener("beforeinput", beforeInput); document.removeEventListener("selectionchange", changed); };
  }, []);

  const tool = (command: Command, label: string, content: ReactNode, active = false) =>
    <button type="button" title={label} aria-label={label} aria-pressed={active} className={active ? "active" : ""} onClick={() => void useCommand(command)}>{content}</button>;

  return <>
    <div className="paper-toolbar" role="toolbar" aria-label="Text formatting" onMouseDown={(event) => { if ((event.target as HTMLElement).closest("button")) { rememberSelection(); event.preventDefault(); } }}>
      <div className="paper-toolbar-group">
        <button type="button" className="text-style-button" aria-label="Text style and more formatting" aria-expanded={!!menu} title="Text style and more formatting" onClick={(event) => { rememberSelection(); const rect = event.currentTarget.getBoundingClientRect(); setMenu(menu ? null : { left: rect.left, top: rect.bottom + 6 }); }}><span>{formats.heading === "p" ? "Text" : formats.heading.toUpperCase()}</span><Icon name="chevronDown" size={14} /></button>
        {tool("bold", "Bold", <b>B</b>, formats.bold)}
        {tool("italic", "Italic", <i>I</i>, formats.italic)}
      </div>
      <div className="paper-toolbar-group">
        {tool("checklist", "Checklist", <Icon name="checklist" />, formats.list === "checklist")}
        {tool("bullets", "Bulleted list", <Icon name="list" />, formats.list === "bullets")}
        {tool("numbers", "Numbered list", <Icon name="numbers" />, formats.list === "numbers")}
        <button type="button" className="desktop-list-indent" aria-label="Outdent list item" title="Outdent (Shift+Tab)" disabled={!formats.list} onClick={() => { restoreSelection(); paper.current?.focus(); indentSelection(true); }}><Icon name="outdent" /></button>
        <button type="button" className="desktop-list-indent" aria-label="Indent list item" title="Indent (Tab)" disabled={!formats.list} onClick={() => { restoreSelection(); paper.current?.focus(); indentSelection(); }}><Icon name="indent" /></button>
      </div>
      <div className="paper-toolbar-group paper-history">
        <button type="button" aria-label="Undo" title="Undo (⌘Z / Ctrl+Z)" disabled={!historyState.undo} onClick={() => travelHistory()}><Icon name="undo" /></button>
        <button type="button" aria-label="Redo" title="Redo (⌘⇧Z / Ctrl+Shift+Z)" disabled={!historyState.redo} onClick={() => travelHistory(true)}><Icon name="redo" /></button>
      </div>
    </div>
    <div className="paper-scroll">
    <article
      className={`paper-editor markdown-preview${dragActive ? " drag-active" : ""}`}
      ref={paper}
      contentEditable
      role="textbox"
      aria-label="Note body"
      aria-multiline="true"
      suppressContentEditableWarning
      spellCheck
      data-placeholder="Begin with a thought…"
      onDragOver={(event: ReactDragEvent) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        if (!dragActive) setDragActive(true);
      }}
      onDragLeave={(event: ReactDragEvent) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragActive(false);
      }}
      onDrop={(event: ReactDragEvent) => {
        const files = imageFilesFrom(event.dataTransfer);
        setDragActive(false);
        if (!files.length) return;
        event.preventDefault();
        const point = document.caretRangeFromPoint?.(event.clientX, event.clientY) ?? null;
        void insertImageFiles(files, point);
      }}
      onPaste={(event: ReactClipboardEvent) => {
        const files = imageFilesFrom(event.clipboardData);
        if (!files.length) return;
        event.preventDefault();
        void insertImageFiles(files);
      }}
      onFocus={() => { document.execCommand("defaultParagraphSeparator", false, "p"); rememberSelection(); }}
      onCompositionStart={() => { captureEdit("composition"); composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; scheduleCommit(); }}
      onInput={(event) => {
        // A checkbox toggle bubbles an input event whose caret sits outside any block;
        // running the shortcut pass there would reflow the document. It commits via onClick.
        if ((event.target as HTMLElement).matches('input[type="checkbox"]')) return;
        applyShortcut(); scheduleCommit();
      }}
      onBlur={flushOnBlur}
      onKeyDown={handleKeyDown}
      onKeyUp={rememberSelection}
      onMouseUp={() => { lastEdit.current = { time: 0, type: "" }; rememberSelection(); }}
      onPointerDown={(event) => {
        // Ticking a checkbox shouldn't pull focus into the editable text — on a
        // phone that pops the keyboard and drops the caret onto the tapped line
        // (often the title). Suppressing pointerdown keeps focus and the caret put;
        // the box still flips on click, which we persist below.
        if ((event.target as HTMLElement).matches('input[type="checkbox"]')) event.preventDefault();
      }}
      onClick={(event) => {
        if (!(event.target as HTMLElement).matches('input[type="checkbox"]')) return;
        const checkbox = event.target as HTMLInputElement;
        checkbox.checked = !checkbox.checked; captureEdit("checkbox"); checkbox.checked = !checkbox.checked;
        checkbox.toggleAttribute("checked", checkbox.checked); scheduleCommit();
      }}
      onContextMenu={(event) => { if (window.matchMedia("(pointer: coarse)").matches) return; event.preventDefault(); rememberSelection(); setMenu({ left: event.clientX, top: event.clientY }); }}
    />
    </div>
    {menu && <div className="paper-menu" ref={menuElement} style={{ left: menu.left, top: menu.top }} onMouseDown={(event) => event.preventDefault()}>
      <div className="paper-menu-section"><button onClick={() => void useCommand("cut")}>Cut</button><button onClick={() => void useCommand("copy")}>Copy</button><button onClick={() => void useCommand("paste")}>Paste</button><button onClick={() => void useCommand("selectall")}>Select all</button></div>
      <div className="paper-menu-section"><button onClick={() => void useCommand("p")}>Paragraph</button><button onClick={() => void useCommand("h1")}>Heading 1</button><button onClick={() => void useCommand("h2")}>Heading 2</button><button onClick={() => void useCommand("h3")}>Heading 3</button></div>
      <div className="paper-menu-section"><button onClick={() => void useCommand("checklist")}>Checklist</button><button onClick={() => void useCommand("bullets")}>Bulleted list</button><button onClick={() => void useCommand("numbers")}>Numbered list</button></div>
      <div className="paper-menu-section"><button disabled={!formats.list} onClick={() => { restoreSelection(); paper.current?.focus(); indentSelection(); setMenu(null); }}>Indent list item</button><button disabled={!formats.list} onClick={() => { restoreSelection(); paper.current?.focus(); indentSelection(true); setMenu(null); }}>Outdent list item</button></div>
      <div className="paper-menu-section"><button onClick={() => void useCommand("bold")}><b>Bold</b></button><button onClick={() => void useCommand("italic")}><i>Italic</i></button><button onClick={() => void useCommand("link")}>Link…</button><button onClick={() => void useCommand("code")}>Code block</button><button onClick={() => void useCommand("image")}>Add image…</button></div>
    </div>}
  </>;
}
