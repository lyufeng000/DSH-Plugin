import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
function mount(saved = {}) {
  let module, stored;
  const slots = new Map(), disposers = [];
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), Fragment: 'fragment', useState: init => [typeof init === 'function' ? init() : init, () => {}], useEffect: () => {}, useRef: value => ({ current: value }) };
  const window = { __ModuleLoader__: { load: entry => { module = entry.factory(name => { assert.equal(name, 'react'); return React; }); } }, localStorage: { getItem: () => JSON.stringify(saved), setItem: (_key, value) => { stored = JSON.parse(value); } }, addEventListener() {}, removeEventListener() {}, setTimeout: () => 1, clearTimeout() {} };
  vm.runInNewContext(source, { window, console, AbortController, setTimeout, clearTimeout });
  let dict;
  module.apply({ effect: fn => { const off = fn(); if (typeof off === 'function') disposers.push(off); }, locale: { register: (_ns, dictionaries) => { dict = dictionaries.zh; }, bind: () => key => dict[key] ?? key, subscribe: () => () => {} }, slots: { inject: (_slot, fn) => fn(), register: (meta, component) => slots.set(meta.name, component) } });
  const flatten = node => node && typeof node === 'object' ? [node, ...(node.children ?? []).flat(Infinity).flatMap(flatten)] : [];
  return { nodes: flatten(slots.get('settings.section')()), stored: () => stored, dispose: () => disposers.forEach(fn => fn()) };
}
test('actual built client renders separate completion/error/manual-stop selectors', () => { const f = mount(); const values = f.nodes.filter(n => n.type === 'select').map(n => n.props.value); assert.deepEqual(values, ['all', 'chime', 'alert', 'retroDown']); f.dispose(); });
test('old custom completion sound, volume and scope survive migration', () => { const f = mount({ sound: 'custom', customUrl: 'data:audio/test;base64,AAA=', customName: 'old.mp3', volume: 0.35, scope: 'current', enabled: true }); assert.equal(f.nodes.find(n => n.type === 'input' && n.props.type === 'range').props.value, 35); const selects = f.nodes.filter(n => n.type === 'select'); assert.equal(selects[0].props.value, 'current'); assert.equal(selects[1].props.value, 'custom'); assert.equal(selects[2].props.value, 'alert'); f.dispose(); });
test('outcome choice persists separately without replacing the completion sound', () => { const f = mount({ sound: 'bell', volume: 0.4 }); f.nodes.find(n => n.type === 'select' && n.props['aria-label'] === '异常断开提示音').props.onChange({ target: { value: 'none' } }); assert.equal(f.stored().errorSound, 'none'); assert.equal(f.stored().sound, 'bell'); assert.equal(f.stored().interruptedSound, 'retroDown'); f.dispose(); });
test('invalid outcome options normalize to distinct defaults', () => { const f = mount({ errorSound: 'bad', interruptedSound: 'custom' }); const choices = f.nodes.filter(n => n.type === 'select').slice(2).map(n => n.props.value); assert.deepEqual(choices, ['alert', 'retroDown']); f.dispose(); });
