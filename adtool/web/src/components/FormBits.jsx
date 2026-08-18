/* 开设广告 / 手动广告两个页面共用的小组件 */

/** 多选标签组 */
export function Chips({ items, value, onChange }) {
  return (
    <div className="chips">
      {items.map(({ id, label, sub }) => {
        const on = value.includes(id);
        return (
          <label key={id} className={`chip${on ? ' on' : ''}`}>
            <input
              type="checkbox"
              checked={on}
              onChange={() => onChange(on ? value.filter((v) => v !== id) : [...value, id])}
            />
            {label}
            {sub ? <span className="chip-sub">{sub}</span> : null}
          </label>
        );
      })}
    </div>
  );
}

/** 带编号的一块表单 */
export function Sec({ n, title, tone = 'blue', meta, children }) {
  return (
    <section className="sec">
      <header className="sec-head">
        <span className={`sec-num ${tone}`}>{n}</span>
        <h3 className="sec-title">{title}</h3>
        <div className="spacer" />
        {meta}
      </header>
      {children}
    </section>
  );
}
