import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './AppDialog.css';

export default function AppDialog({ title, children, onClose, busy = false, wide = false }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement;
    ref.current.showModal();
    const dialog = ref.current;
    return () => { dialog.close(); previous?.focus?.(); };
  }, []);
  return createPortal(<dialog ref={ref} className={`app-dialog${wide ? ' wide' : ''}`} aria-labelledby={titleId}
    onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}>
    <header className="row"><h2 id={titleId}>{title}</h2><div className="spacer" />
      <button className="btn ghost" autoFocus disabled={busy} aria-label="关闭对话框" onClick={onClose}>关闭</button></header>
    {children}
  </dialog>, document.body);
}

export function useConfirm() {
  const [pending, setPending] = useState(null);
  const resolver = useRef(null);
  useEffect(() => () => resolver.current?.(false), []);
  function finish(value) { resolver.current?.(value); resolver.current = null; setPending(null); }
  const ask = (message, action = '确认') => new Promise((resolve) => { resolver.current?.(false); resolver.current = resolve; setPending({ message, action }); });
  const dialog = pending && <AppDialog title="确认操作" onClose={() => finish(false)}>
    <p>{pending.message}</p><footer className="row"><div className="spacer" />
      <button className="btn" onClick={() => finish(false)}>取消</button>
      <button className="btn danger" onClick={() => finish(true)}>{pending.action}</button></footer>
  </AppDialog>;
  return [ask, dialog];
}
