import { analyzeMarkdown } from './markdown.mjs';
import { readLayout, selectionRange, makePlan, ownedStyle, canStyle } from './native-plan.mjs';

const protectedNames = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock', 'HTMLTag']);

/** Native input gestures only. The adapter owns all listeners and decoration. */
export function createFenceInput(editor) {
  let disposed = false, transforming = false, intent = null, timer = null, timerWindow = null;

  function resetRoot() {
    if (timer !== null) timerWindow.clearTimeout(timer);
    intent = null; timer = null; timerWindow = null;
  }
  const composing = event => event?.isComposing || event?.keyCode === 229 || editor.isComposing();
  const inRoot = event => {
    const root = editor.getRootElement();
    return root && event?.target && root.contains(event.target) ? root : null;
  };
  const rangeSelection = selection => selection?.isCollapsed?.() &&
    typeof selection.insertParagraph === 'function' && typeof selection.insertText === 'function';
  const clearOwnedStyle = selection => {
    if (ownedStyle(selection?.style)) selection.setStyle('');
    return selection;
  };
  const blockOf = (selection, root) => {
    const anchor = selection?.anchor?.getNode();
    const block = anchor?.getType() === 'paragraph' ? anchor : anchor?.getParent();
    return block?.getType() === 'paragraph' && block.getParent()?.getKey() === root.getKey() ? block : null;
  };
  function ordinaryBlock(block) {
    if (block?.getType() !== 'paragraph' || block.getParent()?.getType() !== 'root') return false;
    // Chips, text refs, inline elements, explicit styles and native code format
    // belong to their host. Never split or move those nodes to make a fence.
    return block.getChildren().every(node => node.getType() === 'linebreak' || node.getType() === 'tab' ||
      (canStyle({ type: node.getType(), node }) && !node.hasFormat('code') && !/[\r\n]/.test(node.getTextContent())));
  }
  function nativeBreak(layout, at, blockKey) {
    return layout.leaves.find(leaf => leaf.type === 'linebreak' && leaf.from === at && leaf.parentKey === blockKey)?.node;
  }
  /** Select a resident source boundary, including an empty native paragraph. */
  function selectOffset(root, layout, at, end = false) {
    const blocks = layout.blocks.filter(block => block.from <= at && at <= block.to);
    const block = (end ? blocks.at(-1) : blocks.find(block => block.from === at) ?? blocks[0]);
    const node = block && root.getChildren().find(child => child.getKey() === block.key);
    if (node?.getType() !== 'paragraph') return null;
    const leaves = layout.leaves.filter(leaf => leaf.parentKey === block.key);
    const text = end
      ? [...leaves].reverse().find(leaf => leaf.type === 'text' && leaf.from < at && at <= leaf.to)
      : leaves.find(leaf => leaf.type === 'text' && leaf.from <= at && at < leaf.to);
    if (text && !/[\r\n]/.test(text.text)) return text.node.select(at - text.from, at - text.from);
    const boundary = leaves.find(leaf => leaf.type === 'linebreak' && leaf.from === at) ??
      leaves.find(leaf => leaf.type === 'linebreak' && leaf.to === at);
    if (boundary) {
      const index = boundary.node.getIndexWithinParent() + Number(at === boundary.to);
      return node.select(index, index);
    }
    if (at === block.from) return node.selectStart();
    if (at === block.to) return node.selectEnd();
    return null;
  }

  /** Capture observer. Let Lexical commit the user's third backtick itself. */
  function beforeInput(event) {
    resetRoot();
    if (disposed || composing(event) || event.defaultPrevented || event.inputType !== 'insertText' || event.data !== '`') return false;
    const element = inRoot(event);
    if (!element) return false;
    const state = editor.getEditorState();
    const next = state.read(() => {
      const root = state._nodeMap.get('root'), selection = state._selection;
      if (!root || !rangeSelection(selection) || selection.hasFormat('code') ||
        (selection.style !== '' && !ownedStyle(selection.style))) return null;
      const block = blockOf(selection, root);
      if (!ordinaryBlock(block)) return null;
      const layout = readLayout(root), range = selectionRange(selection, layout);
      if (!range || range.from !== range.to) return null;
      const at = range.to, from = layout.text.lastIndexOf('\n', at - 1) + 1;
      if (layout.text.slice(from, at) !== '``' || (at < layout.text.length && layout.text[at] !== '\n')) return null;
      const bounds = layout.bounds.get(block.getKey());
      // Only native BRs or paragraph gaps are line boundaries. A pasted LF
      // inside a TextNode is source text, not a native line to restructure.
      const before = from > bounds.from ? nativeBreak(layout, from - 1, block.getKey()) : null;
      const after = at < bounds.to ? nativeBreak(layout, at, block.getKey()) : null;
      if ((from > bounds.from && !before) || (at < bounds.to && !after)) return null;
      const parsed = analyzeMarkdown(layout.text);
      if (parsed.limited || [...parsed.literals, ...parsed.nodes.filter(node => protectedNames.has(node.name))]
        .some(node => node.from < at && node.to > from)) return null;
      return { element, blockKey: block.getKey(), text: layout.text, at, from,
        beforeKey: before?.getKey(), afterKey: after?.getKey() };
    });
    if (!next) return false;
    intent = next; timerWindow = element.ownerDocument.defaultView;
    // The resident beforeinput update can commit in a microtask after capture.
    // A task timer admits that commit, but never a later paste or draft restore.
    timer = timerWindow.setTimeout(() => { if (intent === next) resetRoot(); }, 0);
    return true;
  }

  /** Runs in the adapter's resident root transform, before applyPlan/history. */
  function transform(root) {
    if (disposed || transforming || !intent) return false;
    const captured = intent; resetRoot();
    if (editor.isComposing() || editor.getRootElement() !== captured.element) return false;
    const selection = editor._pendingEditorState?._selection;
    if (!rangeSelection(selection)) return false;
    const layout = readLayout(root), range = selectionRange(selection, layout);
    const expected = `${captured.text.slice(0, captured.at)}\`${captured.text.slice(captured.at)}`;
    const block = blockOf(selection, root);
    if (layout.text !== expected || !range || range.from !== captured.at + 1 || range.to !== range.from ||
      block?.getKey() !== captured.blockKey || !ordinaryBlock(block)) return false;
    const marker = layout.leaves.filter(leaf => leaf.parentKey === captured.blockKey &&
      leaf.from < captured.at + 1 && leaf.to > captured.from);
    if (!marker.length || marker.some(leaf => !canStyle(leaf) || leaf.from < captured.from || leaf.to > captured.at + 1) ||
      marker.map(leaf => leaf.text).join('') !== '```') return false;
    const before = captured.beforeKey && nativeBreak(layout, captured.from - 1, captured.blockKey);
    const after = captured.afterKey && nativeBreak(layout, captured.at + 1, captured.blockKey);
    if ((captured.beforeKey && before?.getKey() !== captured.beforeKey) ||
      (captured.afterKey && after?.getKey() !== captured.afterKey)) return false;
    transforming = true;
    try {
      let opener = block;
      if (before) {
        // Swap one BR for one paragraph gap. Leaving the BR in the prefix
        // would add an extra empty source line before the opening fence.
        before.remove();
        opener = clearOwnedStyle(marker[0].node.select(0, 0)).insertParagraph();
      }
      if (after) {
        // Preserve a later native line outside the new block, with one LF.
        after.remove();
        const last = marker.at(-1).node;
        clearOwnedStyle(last.select(last.getTextContentSize(), last.getTextContentSize())).insertParagraph();
      }
      const body = clearOwnedStyle(opener.selectEnd()).insertParagraph();
      const closing = clearOwnedStyle(body.selectStart()).insertParagraph();
      clearOwnedStyle(closing.selectStart()).insertText('```');
      clearOwnedStyle(body.selectStart());
      return true;
    } finally { transforming = false; }
  }

  function exitTarget(root, selection) {
    if (!rangeSelection(selection) || !blockOf(selection, root)) return null;
    const layout = readLayout(root), range = selectionRange(selection, layout);
    if (!range || range.from !== range.to) return null;
    const plan = makePlan(layout.text);
    if (plan.limited) return null;
    const fence = plan.fenceLines.find(item => item.hasBody && item.body.from <= range.to && range.to <= item.body.to);
    if (!fence) return null;
    const blocks = root.getChildren(), touched = layout.blocks.filter(block => block.from <= fence.close.to && block.to >= fence.open.from);
    if (touched.some(block => !ordinaryBlock(blocks.find(node => node.getKey() === block.key)))) return null;
    const closingBlock = layout.blocks.find(block => block.from <= fence.close.from && fence.close.to <= block.to);
    if (!closingBlock) return null;
    // Existing source after the close must start at an actual resident line.
    // Embedded text newlines do not supply a native caret target.
    const after = fence.close.to < layout.text.length ? fence.close.to + 1 : null;
    if (after !== null && !layout.blocks.some(block => block.from === after && block.type === 'paragraph') &&
      !nativeBreak(layout, fence.close.to, closingBlock.key)) return null;
    return { layout, fence, after, at: range.to };
  }

  /** Capture Shift+Enter: line break first, then leave an empty final line. */
  function keydown(event) {
    resetRoot();
    if (disposed || composing(event) || event.defaultPrevented || event.repeat || event.key !== 'Enter' || !event.shiftKey ||
      event.ctrlKey || event.metaKey || event.altKey || event.getModifierState?.('AltGraph') || !inRoot(event)) return false;
    const state = editor.getEditorState();
    const target = state.read(() => exitTarget(state._nodeMap.get('root'), state._selection));
    if (!target) return false;
    let handled = false;
    editor.update(() => {
      const pending = editor._pendingEditorState, root = pending?._nodeMap.get('root');
      const current = root && exitTarget(root, pending._selection);
      if (!current || current.layout.text !== target.layout.text || current.at !== target.at) return;
      const body = current.layout.text.slice(current.fence.body.from, current.fence.body.to);
      const lastBreak = body.lastIndexOf('\n');
      const leaving = current.at === current.fence.body.to && lastBreak >= 0 && !/\S/.test(body.slice(lastBreak + 1));
      if (!leaving) {
        if (typeof pending._selection.insertLineBreak !== 'function') return;
        pending._selection.insertLineBreak(); handled = true; return;
      }
      if (typeof pending._selection.removeText !== 'function') return;
      const end = selectOffset(root, current.layout, current.fence.body.to, true);
      if (!end) return;
      const point = { key: end.anchor.key, offset: end.anchor.offset, type: end.anchor.type };
      const remove = selectOffset(root, current.layout, current.fence.body.from + lastBreak);
      if (!remove) return;
      remove.focus.set(point.key, point.offset, point.type); remove.removeText();
      // Only the final blank body line is removed. Reproject the remaining
      // resident nodes because native deletion can merge paragraph boundaries.
      const layout = readLayout(root);
      const fence = makePlan(layout.text).fenceLines.find(item => item.from === current.fence.from);
      if (!fence) { handled = true; return; }
      const after = fence.close.to < layout.text.length ? fence.close.to + 1 : null;
      let selection;
      if (after !== null) selection = selectOffset(root, layout, after);
      else {
        selection = selectOffset(root, layout, fence.close.to, true);
        if (!selection) { handled = true; return; }
        const paragraph = clearOwnedStyle(selection).insertParagraph();
        selection = paragraph?.selectStart();
      }
      if (selection) clearOwnedStyle(selection);
      handled = true;
    }, { discrete: true, tag: 'history-push' });
    if (!handled) return false;
    event.preventDefault(); event.stopImmediatePropagation();
    return true;
  }

  return {
    beforeInput, keydown, transform, resetRoot,
    dispose() { if (disposed) return; disposed = true; resetRoot(); },
  };
}
