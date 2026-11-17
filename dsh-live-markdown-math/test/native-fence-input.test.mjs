import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { setupDOM, settle } from './dom.mjs';
import { runtimePath, loadNativeRuntime, createFixture } from './native-runtime.mjs';
import { createFenceInput } from '../src/native-fence-input.mjs';
import { readLayout, selectionRange, applyPlan, makePlan, ownedStyle } from '../src/native-plan.mjs';

const dom = setupDOM();
const api = runtimePath ? loadNativeRuntime() : null;
after(() => dom.window.close());
const native = (name, fn) => test(name, { skip: !api && 'Set DSH_NATIVE_RUNTIME to a reviewed conversation client' }, fn);

function snapshot(f) {
  return f.editor.getEditorState().read(() => {
    const root = api.getRoot(), layout = readLayout(root), selection = api.getSelection();
    return {
      source: layout.text, range: selectionRange(selection, layout), style: selection?.style,
      blocks: root.getChildren().map(node => ({ key: node.getKey(), type: node.getType(), text: node.getTextContent(),
        children: node.getChildren().map(child => ({ key: child.getKey(), type: child.getType(), text: child.getTextContent(), style: child.getStyle?.() })) })),
    };
  });
}
async function fixture(text = '', { preview = false, ...options } = {}) {
  const f = createFixture(api, { text, ...options }), input = createFenceInput(f.editor);
  const observed = [], keys = [];
  let transforms = 0, changed = 0, deferred = false, commitTag;
  const before = event => observed.push(input.beforeInput(event));
  const key = event => keys.push(input.keydown(event));
  // A DOM-less browser supplies no default text mutation. This capture seam
  // commits through the resident RangeSelection after our real beforeinput
  // observer, then stops the otherwise duplicate native event handler.
  const commit = event => {
    if (event.inputType !== 'insertText' || event.data === null) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const update = () => f.editor.update(() => (api.getSelection() ?? api.getRoot().selectEnd()).insertText(event.data),
      { discrete: !deferred, ...(commitTag ? { tag: commitTag } : {}) });
    if (deferred) queueMicrotask(update); else update();
  };
  const off = f.editor.registerNodeTransform(f.editor._nodes.get('root').klass, root => {
    transforms++; if (input.transform(root)) changed++;
    if (preview) applyPlan(root, makePlan(readLayout(root).text));
  });
  f.root.addEventListener('beforeinput', before, true);
  f.root.addEventListener('beforeinput', commit, true);
  f.root.addEventListener('keydown', key, true);
  await settle();
  return { ...f, input, observed, keys,
    get transforms() { return transforms; }, get changed() { return changed; },
    set deferred(value) { deferred = value; }, set commitTag(value) { commitTag = value; },
    dispose() {
      off(); input.dispose(); f.root.removeEventListener('beforeinput', before, true);
      f.root.removeEventListener('beforeinput', commit, true); f.root.removeEventListener('keydown', key, true); f.dispose();
    },
  };
}
function type(f, text, options = {}) {
  for (const data of text) f.root.dispatchEvent(new dom.window.InputEvent('beforeinput', {
    inputType: 'insertText', data, bubbles: true, cancelable: true, ...options,
  }));
}
function shiftEnter(f, options = {}) {
  const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true, ...options });
  f.root.dispatchEvent(event); return event;
}
function selectAt(f, at, to = at) {
  f.editor.update(() => {
    const root = api.getRoot(), layout = readLayout(root);
    const point = value => {
      const block = layout.blocks.find(block => block.from === value) ?? layout.blocks.find(block => block.from <= value && value <= block.to);
      const node = root.getChildren().find(node => node.getKey() === block?.key);
      const leaf = layout.leaves.find(leaf => leaf.parentKey === block?.key && (leaf.type === 'text' || leaf.type === 'tab') && leaf.from <= value && value <= leaf.to);
      if (leaf) return { node: leaf.node, offset: value - leaf.from, type: 'text' };
      const br = layout.leaves.find(leaf => leaf.parentKey === block?.key && leaf.type === 'linebreak' && (leaf.from === value || leaf.to === value));
      return { node, offset: br ? br.node.getIndexWithinParent() + Number(value === br.to) : value === block?.from ? 0 : node.getChildrenSize(), type: 'element' };
    };
    const from = point(at), end = point(to), selection = from.node.select(from.offset, from.offset);
    selection.focus.set(end.node.getKey(), end.offset, end.type);
  }, { discrete: true });
}
function inlineSource(f, text) {
  f.editor.update(() => {
    const root = api.getRoot(); root.clear(); root.append(api.createParagraph());
    root.selectEnd().insertRawText(text);
  }, { discrete: true });
}
function paragraphSource(f, text) {
  f.editor.update(() => {
    const root = api.getRoot(); root.clear();
    for (const line of text.split('\n')) {
      root.append(api.createParagraph()); root.selectEnd().insertRawText(line);
    }
  }, { discrete: true });
}
function selectBodyEnd(f) {
  const fence = makePlan(snapshot(f).source).fenceLines[0];
  assert.ok(fence?.hasBody, 'the fixture has a complete fence body');
  selectAt(f, fence.body.to);
}
const collapsedAt = at => ({ from: at, to: at, anchor: at, focus: at });

native('third backtick closes immediately into three native paragraphs at body offset four', async () => {
  const f = await fixture();
  try {
    const nativeRoot = f.editor.getRootElement();
    type(f, '`'); assert.equal(snapshot(f).source, '`'); assert.equal(f.changed, 0);
    type(f, '`'); assert.equal(snapshot(f).source, '``'); assert.equal(f.changed, 0);
    const openerKey = snapshot(f).blocks[0].key;
    type(f, '`');
    const state = snapshot(f);
    assert.equal(state.source, '```\n\n```');
    assert.equal(f.runtime.projection.clipboardText, '```\n\n```');
    assert.deepEqual(state.range, collapsedAt(4));
    assert.deepEqual(f.runtime.projection.selection, { start: 4, end: 4 });
    assert.deepEqual(state.blocks.map(block => block.type), ['paragraph', 'paragraph', 'paragraph']);
    assert.deepEqual(state.blocks.map(block => block.text), ['```', '', '```']);
    assert.equal(state.blocks[0].key, openerKey, 'the existing opening paragraph survives');
    assert.ok(state.blocks.every(block => block.children.every(child => child.type === 'text')), 'no same-paragraph double BR');
    assert.equal(f.editor.getRootElement(), nativeRoot);
    assert.deepEqual(f.observed, [false, false, true]); assert.equal(f.changed, 1);
    for (let i = 0; i < 4; i++) f.editor.update(() => api.getRoot().markDirty(), { discrete: true });
    assert.equal(f.changed, 1, 'recursive root passes consume no second gesture');
    assert.deepEqual(snapshot(f), state);
    type(f, '正文'); assert.equal(snapshot(f).source, '```\n正文\n```');
    assert.deepEqual(snapshot(f).range, collapsedAt(6));
  } finally { f.dispose(); }
});

for (const source of ['``\nafter', 'before\n``', 'before\n``\nafter']) {
  native(`closure keeps existing native paragraphs around ${JSON.stringify(source)}`, async () => {
    const f = await fixture(source);
    try {
      selectAt(f, source.indexOf('``') + 2);
      const before = snapshot(f), markerIndex = before.blocks.findIndex(block => block.text === '``');
      type(f, '`');
      const expected = source.replace('``', '```\n\n```'), state = snapshot(f);
      assert.equal(state.source, expected);
      assert.deepEqual(state.range, collapsedAt(source.indexOf('``') + 4));
      assert.equal(state.blocks[markerIndex].key, before.blocks[markerIndex].key);
      for (const block of before.blocks.filter(block => block.text !== '``')) {
        assert.deepEqual(state.blocks.find(next => next.key === block.key), block, 'unrelated paragraph identity and contents survive');
      }
      assert.equal(f.changed, 1);
    } finally { f.dispose(); }
  });
}

for (const source of ['before\n``', 'before\n\n``', '\n``', 'before\n``\nafter']) {
  native(`a native BR before the opener becomes exactly one paragraph gap: ${JSON.stringify(source)}`, async () => {
    const f = await fixture();
    try {
      inlineSource(f, source); selectAt(f, source.indexOf('``') + 2);
      const prefixKey = snapshot(f).blocks[0].key;
      type(f, '`');
      const state = snapshot(f), expected = source.replace('``', '```\n\n```');
      assert.equal(state.source, expected, 'there is no extra empty fence row');
      assert.equal(f.runtime.projection.clipboardText, expected);
      assert.deepEqual(state.range, collapsedAt(source.indexOf('``') + 4));
      assert.equal(state.blocks[0].key, prefixKey);
      const opener = state.blocks.find(block => block.text === '```');
      assert.ok(opener); assert.equal(opener.children.some(child => child.type === 'linebreak'), false);
      assert.deepEqual(state.blocks.slice(state.blocks.indexOf(opener), state.blocks.indexOf(opener) + 3).map(block => block.text), ['```', '', '```']);
      assert.equal(f.changed, 1);
    } finally { f.dispose(); }
  });
}

native('a deferred native commit retains the capture intent until the next task', async () => {
  const f = await fixture('``');
  try {
    f.deferred = true; type(f, '`');
    assert.equal(f.observed.at(-1), true);
    await settle();
    assert.equal(snapshot(f).source, '```\n\n```'); assert.deepEqual(snapshot(f).range, collapsedAt(4));
    assert.equal(f.changed, 1);
  } finally { f.dispose(); }
});

native('manual closure of an unfinished code block never adds another fence', async () => {
  for (const source of ['```\ncode\n``', '~~~\ncode\n``', '````\ncode\n``', '> ```\n> code\n> ``']) {
    const f = await fixture(source);
    try {
      type(f, '`'); assert.equal(snapshot(f).source, `${source}\``);
      assert.equal(f.observed.at(-1), false); assert.equal(f.changed, 0);
    } finally { f.dispose(); }
  }
});

native('an independent line after an earlier complete code block can open a new block', async () => {
  const source = '```\nold\n```\n``', f = await fixture(source);
  try {
    type(f, '`'); assert.equal(snapshot(f).source, `${source}\`\n\n\`\`\``);
    assert.equal(f.changed, 1);
  } finally { f.dispose(); }
});

native('inline, indented, ranged, formatted, literal and foreign native content stays source', async () => {
  for (const source of ['word``', ' ``', '\\``', '```\n``\n```', '<div>\n``', '$$\n``', '`inline\n``\nend`']) {
    const f = await fixture(source);
    try {
      const at = source.indexOf('``', source.startsWith('```') ? 4 : 0) + 2;
      selectAt(f, at); type(f, '`');
      assert.equal(snapshot(f).source, `${source.slice(0, at)}\`${source.slice(at)}`);
      assert.equal(f.changed, 0);
    } finally { f.dispose(); }
  }
  for (const kind of ['range', 'code', 'style', 'text-ref', 'chip']) {
    const f = await fixture('``', { lexicon: new Map([['@', ['ref']]]) });
    try {
      f.editor.update(() => {
        const paragraph = api.getRoot().getFirstChild(), node = paragraph.getFirstChild();
        if (kind === 'range') node.select(0, 2);
        if (kind === 'code') { node.setFormat('code'); node.selectEnd(); }
        if (kind === 'style') { node.setStyle('color: red'); node.selectEnd(); }
        if (kind === 'text-ref') {
          const ref = new api.TextRefNode('@ref'); node.insertBefore(ref);
          const selection = ref.selectEnd(); selection.insertLineBreak(); node.selectEnd();
        }
        if (kind === 'chip') {
          const chip = new api.ReferenceChipNode({ source: 'file', ref: 'fixture.md', label: 'fixture.md', clipboardText: '@fixture.md' });
          node.insertBefore(chip); paragraph.select(1, 1).insertLineBreak(); node.selectEnd();
        }
      }, { discrete: true });
      const before = snapshot(f).source; type(f, '`');
      assert.equal(f.observed.at(-1), false, kind); assert.equal(f.changed, 0, kind);
      assert.equal(snapshot(f).source, kind === 'range' ? '`' : `${before}\``);
    } finally { f.dispose(); }
  }
});

native('paste, draft restore and programmatic insertions never create a typing gesture', async () => {
  const f = await fixture('``');
  try {
    f.runtime.paste('`'); assert.equal(snapshot(f).source, '```'); assert.equal(f.changed, 0);
    f.runtime.setDraft('``');
    f.editor.update(() => api.getSelection().insertText('`'), { discrete: true });
    assert.equal(snapshot(f).source, '```'); assert.equal(f.changed, 0);
    for (const source of ['```', '```\nraw', '```\n\n```']) {
      f.runtime.setDraft(source); assert.equal(snapshot(f).source, source); assert.equal(f.changed, 0);
    }
    f.runtime.setDraft('``');
    f.root.dispatchEvent(new dom.window.InputEvent('beforeinput', { inputType: 'insertFromPaste', data: '`', bubbles: true, cancelable: true }));
    f.runtime.paste('`'); assert.equal(snapshot(f).source, '```'); assert.equal(f.observed.at(-1), false);
    f.runtime.setDraft('``');
    f.root.dispatchEvent(new dom.window.InputEvent('beforeinput', { inputType: 'insertText', data: '```', bubbles: true, cancelable: true }));
    assert.equal(snapshot(f).source, '`````'); assert.equal(f.changed, 0, 'bulk insertText is not a single third-key gesture');
  } finally { f.dispose(); }
});

native('a stale, mismatched or reset capture is consumed without closure', async () => {
  for (const mode of ['expired', 'source', 'selection', 'block', 'reset', 'dispose']) {
    const f = await fixture('``');
    const observeOnly = event => { event.preventDefault(); event.stopImmediatePropagation(); };
    // Register at the document so it runs before the fixture's committing root.
    const capture = event => { f.input.beforeInput(event); observeOnly(event); };
    document.addEventListener('beforeinput', capture, true);
    try {
      type(f, '`');
      if (mode === 'expired') await settle();
      if (mode === 'reset') f.input.resetRoot();
      if (mode === 'dispose') f.input.dispose();
      if (mode === 'block') f.runtime.setDraft('```');
      else f.editor.update(() => {
        const selection = api.getSelection(); selection.insertText(mode === 'source' ? '`x' : '`');
        if (mode === 'selection') api.getRoot().selectStart();
      }, { discrete: true });
      assert.equal(snapshot(f).source, mode === 'source' ? '```x' : '```', mode);
      assert.equal(f.changed, 0, mode);
      f.editor.update(() => api.getRoot().markDirty(), { discrete: true });
      assert.equal(f.changed, 0, 'later root transforms never revive the gesture');
    } finally { document.removeEventListener('beforeinput', capture, true); f.dispose(); }
  }
});

native('IME backticks do not arm native closure', async () => {
  const f = await fixture('``');
  try {
    type(f, '`', { isComposing: true }); assert.equal(snapshot(f).source, '```'); assert.equal(f.changed, 0);
    f.runtime.setDraft('``');
    const original = f.editor.isComposing; f.editor.isComposing = () => true;
    try { type(f, '`'); } finally { f.editor.isComposing = original; }
    assert.equal(snapshot(f).source, '```'); assert.equal(f.changed, 0);
  } finally { f.dispose(); }
});

native('Shift+Enter inserts a native body LF before a second empty break exits to one ordinary paragraph', async () => {
  const f = await fixture('', { preview: true });
  let host = 0; const hostKey = () => host++;
  try {
    type(f, '```正文');
    const before = snapshot(f);
    assert.equal(before.source, '```\n正文\n```');
    f.root.addEventListener('keydown', hostKey);
    const first = shiftEnter(f); await settle();
    const inside = snapshot(f);
    assert.equal(first.defaultPrevented, true); assert.equal(host, 0, 'the host sees no handled newline');
    assert.equal(f.keys.at(-1), true);
    assert.equal(inside.source, '```\n正文\n\n```'); assert.deepEqual(inside.range, collapsedAt(7));
    assert.deepEqual(inside.blocks.map(block => block.key), before.blocks.map(block => block.key));
    assert.equal(inside.blocks[1].children.at(-1).type, 'linebreak', 'the first break stays in the resident body paragraph');
    const second = shiftEnter(f); await settle();
    const state = snapshot(f);
    assert.equal(second.defaultPrevented, true); assert.equal(host, 0, 'the host sees no handled exit');
    assert.equal(f.keys.at(-1), true);
    assert.equal(state.source, '```\n正文\n```\n'); assert.deepEqual(state.range, collapsedAt(state.source.length));
    assert.equal(state.blocks.at(-1).type, 'paragraph'); assert.equal(state.blocks.at(-1).children.length, 0);
    assert.equal(state.style, '', 'plugin code metadata never leaks into the next ordinary line');
    type(f, '普通字');
    assert.equal(snapshot(f).source, '```\n正文\n```\n普通字');
    assert.equal(snapshot(f).blocks.at(-1).children[0].style, '');
  } finally { f.root.removeEventListener('keydown', hostKey); f.dispose(); }
});

native('an initially empty body gains one native LF and only the second Shift+Enter exits', async () => {
  const f = await fixture();
  try {
    type(f, '```'); const before = snapshot(f);
    const first = shiftEnter(f); await settle();
    const inside = snapshot(f);
    assert.equal(first.defaultPrevented, true); assert.equal(f.keys.at(-1), true);
    assert.equal(inside.source, '```\n\n\n```'); assert.deepEqual(inside.range, collapsedAt(5));
    assert.equal(inside.blocks[1].key, before.blocks[1].key);
    assert.deepEqual(inside.blocks[1].children.map(child => child.type), ['linebreak']);
    const second = shiftEnter(f); await settle();
    assert.equal(second.defaultPrevented, true); assert.equal(f.keys.at(-1), true);
    assert.equal(snapshot(f).source, '```\n\n```\n');
    assert.deepEqual(snapshot(f).range, collapsedAt(9));
  } finally { f.dispose(); }
});

for (const inline of [false, true]) {
  native(`Shift+Enter cleans the final blank body line and reuses the following ${inline ? 'native BR' : 'paragraph'}`, async () => {
    for (const tail of ['after', '', '\nafter']) {
      const clean = `\`\`\`js\nline one\nline two\n\`\`\`\n${tail}`;
      const source = clean.replace('line two\n', 'line two\n\n'), f = await fixture(inline ? '' : source, { preview: true });
      try {
        if (inline) inlineSource(f, source);
        selectBodyEnd(f);
        const before = snapshot(f), closing = inline
          ? before.blocks[0].children.findIndex(child => child.text === '```')
          : before.blocks.findIndex(block => block.text === '```');
        const following = inline ? before.blocks[0].children.slice(closing + 1) : before.blocks.slice(closing + 1);
        const event = shiftEnter(f); await settle();
        const state = snapshot(f);
        assert.equal(event.defaultPrevented, true); assert.equal(f.keys.at(-1), true);
        assert.equal(state.source, clean, 'only the last body LF is removed');
        assert.deepEqual(state.range, collapsedAt(clean.indexOf('```\n', 3) + 4));
        assert.equal(state.blocks.length, before.blocks.length - Number(!inline), 'exit adds no ordinary paragraph');
        assert.deepEqual(inline ? state.blocks[0].children.slice(-following.length) : state.blocks.slice(-following.length), following,
          'the existing following BR or paragraphs retain their keys and contents');
        assert.equal(state.style, '');
        type(f, 'plain'); assert.equal(snapshot(f).source, clean.replace(`\`\`\`\n${tail}`, `\`\`\`\nplain${tail}`));
      } finally { f.dispose(); }
    }
  });
}

native('Shift+Enter cleans a BR-only body before native insertParagraph exits', async () => {
  const f = await fixture();
  try {
    inlineSource(f, '```\nbody\n\n```'); selectBodyEnd(f);
    const event = shiftEnter(f); await settle();
    assert.equal(event.defaultPrevented, true); assert.equal(snapshot(f).source, '```\nbody\n```\n');
    assert.deepEqual(snapshot(f).blocks.map(block => block.text), ['```\nbody\n```', '']);
    type(f, 'outside'); assert.equal(snapshot(f).source, '```\nbody\n```\noutside');
  } finally { f.dispose(); }
});

native('Shift+Enter preserves explicit user selection style while clearing only owned metadata', async () => {
  const source = '~~~\nbody\n\n~~~', f = await fixture(source);
  try {
    selectBodyEnd(f);
    f.editor.update(() => api.getSelection().setStyle('--lmm-native: codeblock;'), { discrete: true });
    shiftEnter(f); await settle(); assert.equal(snapshot(f).style, '');
    assert.equal(snapshot(f).source, '~~~\nbody\n~~~\n');
    f.runtime.setDraft(source); selectBodyEnd(f);
    f.editor.update(() => api.getSelection().setStyle('color: red'), { discrete: true });
    shiftEnter(f); await settle(); assert.equal(snapshot(f).style, 'color: red');
    assert.equal(snapshot(f).source, '~~~\nbody\n~~~\n');
    type(f, 'outside'); assert.equal(snapshot(f).blocks.at(-1).children[0].style, 'color: red');
  } finally { f.dispose(); }
});

native('typing content between Shift+Enter gestures keeps multiple code lines before the next empty break exits', async () => {
  const f = await fixture('', { preview: true });
  try {
    type(f, '```foo');
    shiftEnter(f); await settle(); assert.equal(snapshot(f).source, '```\nfoo\n\n```');
    type(f, 'bar'); assert.equal(snapshot(f).source, '```\nfoo\nbar\n```');
    shiftEnter(f); await settle();
    const inside = snapshot(f);
    assert.equal(inside.source, '```\nfoo\nbar\n\n```'); assert.deepEqual(inside.range, collapsedAt(12));
    shiftEnter(f); await settle();
    assert.equal(snapshot(f).source, '```\nfoo\nbar\n```\n');
    assert.deepEqual(snapshot(f).range, collapsedAt(16));
    type(f, 'outside'); assert.equal(snapshot(f).source, '```\nfoo\nbar\n```\noutside');
    assert.equal(snapshot(f).blocks.at(-1).children[0].style, '');
  } finally { f.dispose(); }
});

for (const inline of [false, true]) {
  native(`Shift+Enter away from the body end only inserts a native LF with ${inline ? 'BRs' : 'paragraphs'}`, async () => {
    for (const [body, offset] of [
      ['fooBAR', 3], ['foo\nbar\n \t ', 0], ['foo\nbar\n \t ', 3],
      ['foo\n\nbar\n \t ', 4], ['foo\nbar\n \t ', 10],
    ]) {
      const source = `\`\`\`js\n${body}\n\`\`\`\nafter`, f = await fixture('', { preview: true });
      try {
        if (inline) inlineSource(f, source); else paragraphSource(f, source);
        const at = source.indexOf('\n') + 1 + offset;
        selectAt(f, at); const before = snapshot(f);
        const event = shiftEnter(f); await settle();
        const state = snapshot(f);
        assert.equal(event.defaultPrevented, true); assert.equal(f.keys.at(-1), true);
        assert.equal(state.source, `${source.slice(0, at)}\n${source.slice(at)}`, `body ${JSON.stringify(body)} at ${offset}`);
        assert.deepEqual(state.range, collapsedAt(at + 1));
        assert.equal(state.blocks.length, before.blocks.length, 'a native BR does not create another paragraph');
        assert.equal(state.source.slice(at + 1), source.slice(at), 'all source after the caret survives');
      } finally { f.dispose(); }
    }
  });

  native(`an existing trailing blank body line exits structurally and removes only that line with ${inline ? 'BRs' : 'paragraphs'}`, async () => {
    for (const body of ['foo\nbar', 'first\n\n\tsecond', 'foo\n']) {
      for (const blank of ['', '   ', ' \t ']) {
        const clean = `\`\`\`js\n${body}\n\`\`\`\noutside \ttext`;
        const source = `\`\`\`js\n${body}\n${blank}\n\`\`\`\noutside \ttext`, f = await fixture('', { preview: true });
        try {
          if (inline) inlineSource(f, source); else paragraphSource(f, source);
          selectBodyEnd(f); f.input.resetRoot(); await settle();
          const before = snapshot(f);
          if (source.includes('\t')) assert.ok(before.blocks.some(block => block.children.some(child => child.type === 'tab')),
            'the fixture contains resident TabNodes');
          const event = shiftEnter(f); await settle();
          const state = snapshot(f);
          assert.equal(event.defaultPrevented, true); assert.equal(f.keys.at(-1), true);
          assert.equal(state.source, clean, `keep ${JSON.stringify(body)} and remove only ${JSON.stringify(`\n${blank}`)}`);
          assert.deepEqual(state.range, collapsedAt(clean.indexOf('```\n', 3) + 4));
          assert.equal(state.blocks.length, before.blocks.length - Number(!inline));
          type(f, 'plain '); assert.equal(snapshot(f).source, clean.replace('outside \ttext', 'plain outside \ttext'));
        } finally { f.dispose(); }
      }
    }
  });
}

native('a single whitespace-only body still needs its first native LF before exit', async () => {
  const f = await fixture();
  try {
    inlineSource(f, '```\n \t \n```'); selectBodyEnd(f);
    assert.ok(snapshot(f).blocks[0].children.some(child => child.type === 'tab'));
    const first = shiftEnter(f); await settle();
    assert.equal(first.defaultPrevented, true); assert.equal(snapshot(f).source, '```\n \t \n\n```');
    assert.deepEqual(snapshot(f).range, collapsedAt(8));
    const second = shiftEnter(f); await settle();
    assert.equal(second.defaultPrevented, true); assert.equal(snapshot(f).source, '```\n \t \n```\n');
    assert.deepEqual(snapshot(f).range, collapsedAt(12));
  } finally { f.dispose(); }
});

native('the first native LF and the cleanup exit each commit one history-push update', async () => {
  const source = '```\nfoo\n```\nafter', f = await fixture(source, { preview: true });
  let off;
  try {
    selectBodyEnd(f); const commits = [];
    off = f.editor.registerUpdateListener(({ editorState, tags }) => {
      editorState.read(() => {
        const layout = readLayout(api.getRoot());
        commits.push({ source: layout.text, range: selectionRange(api.getSelection(), layout), tags: [...tags] });
      });
    });
    shiftEnter(f); await settle();
    assert.equal(commits.length, 1, 'the first line break is one resident update');
    assert.equal(commits[0].source, '```\nfoo\n\n```\nafter');
    assert.deepEqual(commits[0].range, collapsedAt(8)); assert.ok(commits[0].tags.includes('history-push'));
    commits.length = 0;
    shiftEnter(f); await settle();
    assert.equal(commits.length, 1, 'cleanup and outside selection commit together');
    assert.equal(commits[0].source, source); assert.deepEqual(commits[0].range, collapsedAt(12));
    assert.ok(commits[0].tags.includes('history-push'));
    type(f, 'plain '); assert.equal(snapshot(f).source, '```\nfoo\n```\nplain after');
  } finally { off?.(); f.dispose(); }
});

native('Shift+Enter keeps native code format, user styles, foreign nodes and embedded text LF under host control', async () => {
  for (const kind of ['code', 'style', 'text-ref', 'chip', 'text-LF']) {
    const f = await fixture('```\nbody\n\n```\nafter', { lexicon: new Map([['@', ['ref']]]) });
    try {
      f.editor.update(() => {
        const node = api.getRoot().getChildren()[1].getFirstChild();
        if (kind === 'code') node.setFormat('code');
        if (kind === 'style') node.setStyle('color: red');
        if (kind === 'text-ref') {
          const ref = new api.TextRefNode('@ref'); node.insertBefore(ref); ref.insertAfter(api.createText(' '));
        }
        if (kind === 'chip') node.insertBefore(new api.ReferenceChipNode({
          source: 'file', ref: 'fixture.md', label: 'fixture.md', clipboardText: '@fixture.md',
        }));
        if (kind === 'text-LF') node.setTextContent('bo\ndy');
      }, { discrete: true });
      selectBodyEnd(f); const before = snapshot(f);
      const foreignType = kind === 'text-ref' ? 'composer-text-ref' : kind === 'chip' ? 'reference-chip' : null;
      if (foreignType) assert.ok(before.blocks.some(block => block.children.some(child => child.type === foreignType)),
        `the fixture retains its resident ${foreignType}`);
      let result; const stop = event => { result = f.input.keydown(event); event.preventDefault(); event.stopImmediatePropagation(); };
      document.addEventListener('keydown', stop, true);
      try { shiftEnter(f); } finally { document.removeEventListener('keydown', stop, true); }
      assert.equal(result, false, kind); assert.deepEqual(snapshot(f), before, kind);
    } finally { f.dispose(); }
  }
});

native('other keys, noncollapsed selections, unfinished code and fence rows pass through unchanged', async () => {
  const f = await fixture('```\nbody\n```\nafter');
  try {
    const cases = [
      { key: 'Enter', shiftKey: false }, { ctrlKey: true }, { metaKey: true }, { altKey: true },
      { key: 'a' }, { isComposing: true }, { keyCode: 229 }, { repeat: true },
    ];
    for (const options of cases) {
      selectAt(f, 6); const before = snapshot(f);
      // Run before the host's keymap so these pass-through tests do not send or
      // insert a native newline after checking our observer's return value.
      let result;
      const stop = event => { result = f.input.keydown(event); event.preventDefault(); event.stopImmediatePropagation(); };
      document.addEventListener('keydown', stop, true);
      try { shiftEnter(f, options); } finally { document.removeEventListener('keydown', stop, true); }
      assert.equal(result, false, JSON.stringify(options)); assert.deepEqual(snapshot(f), before);
    }
    f.runtime.setDraft('```\nbody\n\n```'); selectBodyEnd(f);
    const composing = f.editor.isComposing, beforeComposition = snapshot(f);
    let compositionResult;
    const stopComposition = event => { compositionResult = f.input.keydown(event); event.preventDefault(); event.stopImmediatePropagation(); };
    document.addEventListener('keydown', stopComposition, true); f.editor.isComposing = () => true;
    try { shiftEnter(f); } finally {
      f.editor.isComposing = composing; document.removeEventListener('keydown', stopComposition, true);
    }
    assert.equal(compositionResult, false); assert.deepEqual(snapshot(f), beforeComposition);
    for (const [source, at, end] of [
      ['```\nbody', 6], ['```\n```', 4], ['```\nbody\n```', 2], ['```\nbody\n```', 10],
      ['```\nbody\n```\nafter', 14], ['```\nbody\n```', 5, 7], ['plain text', 5],
    ]) {
      f.runtime.setDraft(source); selectAt(f, at, end ?? at); const before = snapshot(f);
      let result; const stop = event => { result = f.input.keydown(event); event.preventDefault(); event.stopImmediatePropagation(); };
      document.addEventListener('keydown', stop, true);
      try { shiftEnter(f); } finally { document.removeEventListener('keydown', stop, true); }
      assert.equal(result, false, source); assert.deepEqual(snapshot(f), before);
    }
  } finally { f.dispose(); }
});

native('undo/redo contains the third key and its entire native closure in one step', async () => {
  const f = await fixture('``');
  try {
    f.commitTag = 'history-push'; type(f, '`');
    const closed = snapshot(f); assert.equal(closed.source, '```\n\n```');
    f.editor.dispatchCommand(api.undo, undefined); await settle();
    assert.equal(snapshot(f).source, '``'); assert.equal(snapshot(f).blocks.length, 1);
    f.editor.dispatchCommand(api.redo, undefined); await settle();
    assert.equal(snapshot(f).source, closed.source); assert.deepEqual(snapshot(f).range, closed.range);
    f.editor.dispatchCommand(api.undo, undefined); await settle();
    type(f, '`'); assert.equal(snapshot(f).source, closed.source, 'an identical later gesture still closes after undo');
    assert.equal(f.changed, 2);
    shiftEnter(f); await settle(); const inside = snapshot(f);
    assert.equal(inside.source, '```\n\n\n```'); assert.deepEqual(inside.range, collapsedAt(5));
    shiftEnter(f); await settle(); const outside = snapshot(f);
    assert.equal(outside.source, '```\n\n```\n'); assert.deepEqual(outside.range, collapsedAt(9));
    f.editor.dispatchCommand(api.undo, undefined); await settle();
    assert.equal(snapshot(f).source, inside.source, 'one undo restores the native blank body line removed by exit');
    assert.deepEqual(snapshot(f).range, inside.range);
    f.editor.dispatchCommand(api.undo, undefined); await settle();
    assert.equal(snapshot(f).source, closed.source, 'a separate undo removes the first native LF');
    assert.deepEqual(snapshot(f).range, closed.range);
    f.editor.dispatchCommand(api.redo, undefined); await settle();
    assert.equal(snapshot(f).source, inside.source); assert.deepEqual(snapshot(f).range, inside.range);
    f.editor.dispatchCommand(api.redo, undefined); await settle();
    assert.equal(snapshot(f).source, outside.source); assert.deepEqual(snapshot(f).range, outside.range);
  } finally { f.dispose(); }
});

native('dispose cancels an armed gesture and leaves the resident editor fully editable', async () => {
  const f = await fixture('``');
  try {
    const before = snapshot(f), root = f.editor.getRootElement();
    f.input.dispose(); f.input.dispose();
    assert.deepEqual(snapshot(f), before); assert.equal(f.editor.getRootElement(), root);
    type(f, '`'); assert.equal(snapshot(f).source, '```'); assert.equal(f.changed, 0);
    assert.equal(f.observed.at(-1), false);
    assert.ok(snapshot(f).blocks.every(block => block.children.every(child => !ownedStyle(child.style))));
  } finally { f.dispose(); }
});
