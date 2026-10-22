const dialogStates = new WeakMap();
const boundDialogs = new WeakSet();
let activeDialog = null;

const focusableControls = modal => [...modal.querySelectorAll('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')]
    .filter(control => !control.closest('[hidden], [inert]') && control.getClientRects().length);

export function closeDialog(modal, { restoreFocus = true } = {}) {
    if (!modal) return;
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    const state = dialogStates.get(modal);
    if (!state) return;
    document.body.style.overflow = state.overflow;
    dialogStates.delete(modal);
    if (activeDialog === modal) activeDialog = null;
    if (restoreFocus && state.opener?.isConnected) state.opener.focus({ preventScroll: true });
}

export function openDialog(modal) {
    if (!modal || dialogStates.has(modal)) return;
    if (activeDialog) closeDialog(activeDialog);
    dialogStates.set(modal, { overflow: document.body.style.overflow, opener: document.activeElement });
    activeDialog = modal;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-hidden', 'false');
    if (!modal.hasAttribute('aria-label') && !modal.hasAttribute('aria-labelledby')) modal.setAttribute('aria-label', 'Your cart');
    modal.style.display = 'block';
    document.body.style.overflow = 'hidden';
    if (!boundDialogs.has(modal)) {
        modal.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                event.preventDefault();
                closeDialog(modal);
            } else if (event.key === 'Tab') {
                const controls = focusableControls(modal);
                const first = controls[0];
                const last = controls.at(-1);
                if (!first || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
                    event.preventDefault();
                    (event.shiftKey ? last : first)?.focus({ preventScroll: true });
                }
            }
        });
        boundDialogs.add(modal);
    }
    const first = focusableControls(modal)[0];
    if (first) first.focus({ preventScroll: true });
    else {
        modal.setAttribute('tabindex', '-1');
        modal.focus({ preventScroll: true });
    }
}
