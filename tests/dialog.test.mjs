import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, existsSync } from 'node:fs';

function setup() {
    const events = {};
    const close = { focus(options) { document.activeElement = this; this.options = options; }, getClientRects: () => [{}], closest: () => null };
    const action = { focus(options) { document.activeElement = this; this.options = options; }, getClientRects: () => [{}], closest: () => null };
    const trigger = { focus(options) { document.activeElement = this; this.options = options; }, isConnected: true };
    const document = { body: { style: { overflow: 'auto' } }, activeElement: trigger };
    const modal = {
        style: { display: 'none' }, attrs: {},
        setAttribute(key, value) { this.attrs[key] = String(value); },
        hasAttribute(key) { return key in this.attrs; },
        querySelectorAll: () => [close, action],
        querySelector: () => close,
        addEventListener(type, callback) { events[type] = callback; },
        focus() { document.activeElement = this; },
    };
    const context = vm.createContext({ document });
    assert.ok(existsSync('dialog.mjs'), 'shared dialog scroll/focus controller must exist');
    vm.runInContext(readFileSync('dialog.mjs', 'utf8').replace(/^export /gm, ''), context);
    return { context, document, modal, events, close, action, trigger };
}

test('dialogs preserve underlying scroll overflow, enter focus, trap Tab, and restore their opener', () => {
    const h = setup();
    h.context.openDialog(h.modal);
    assert.equal(h.modal.style.display, 'block');
    assert.equal(h.document.body.style.overflow, 'hidden');
    assert.equal(h.document.activeElement, h.close);
    assert.equal(h.close.options.preventScroll, true);
    assert.equal(h.modal.attrs.role, 'dialog');
    h.document.activeElement = h.action;
    let prevented = false;
    h.events.keydown({ key: 'Tab', preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(h.document.activeElement, h.close);
    h.events.keydown({ key: 'Escape', preventDefault() {} });
    assert.equal(h.modal.style.display, 'none');
    assert.equal(h.document.body.style.overflow, 'auto');
    assert.equal(h.document.activeElement, h.trigger);
    assert.equal(h.trigger.options.preventScroll, true);
});

test('opening and closing the same dialog twice preserves the original overflow state', () => {
    const h = setup();
    h.context.openDialog(h.modal);
    h.context.openDialog(h.modal);
    h.context.closeDialog(h.modal);
    h.context.closeDialog(h.modal);
    assert.equal(h.document.body.style.overflow, 'auto');
});
