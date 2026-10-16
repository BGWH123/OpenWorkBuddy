import { useEffect, useMemo, useRef, useState } from "react";

export function Picker({ ariaLabel, text, options, value, onChange, searchable, searchLabel }: {
  ariaLabel: string;
  text: string;
  value: string;
  options: Array<{ id: string; label: string; group?: string }>;
  onChange: (id: string) => void;
  searchable?: boolean;
  searchLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [place, setPlace] = useState({ left: 0, bottom: 0 });
  const root = useRef<HTMLDivElement>(null);

  function toggle() {
    const rect = root.current?.getBoundingClientRect();
    if (rect) setPlace({ left: rect.left, bottom: window.innerHeight - rect.top + 8 });
    setOpen((current) => !current);
  }

  useEffect(() => {
    if (!open) return undefined;
    function close(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? options.filter((item) => item.label.toLowerCase().includes(needle) || item.id.toLowerCase().includes(needle)) : options;
  }, [options, query]);

  const groups = useMemo(() => {
    const map = new Map<string, typeof visible>();
    for (const item of visible) {
      const key = item.group || "";
      map.set(key, [...(map.get(key) || []), item]);
    }
    return [...map.entries()];
  }, [visible]);

  return (
    <div className="picker" ref={root}>
      <button type="button" className="picker-trigger" aria-label={ariaLabel} aria-expanded={open} onClick={toggle}>
        <span>{text}</span>
        <i />
      </button>
      {open && (
        <div className="picker-menu" role="listbox" style={{ left: place.left, bottom: place.bottom }}>
          {searchable && (
            <input
              aria-label={searchLabel || "搜索"}
              value={query}
              placeholder="搜索"
              onChange={(event) => setQuery(event.target.value)}
            />
          )}
          {groups.map(([group, items]) => (
            <div key={group || "all"}>
              {group && <p className="picker-group">{group}</p>}
              {items.map((item) => (
                <button
                  type="button"
                  key={item.id || item.label}
                  role="option"
                  aria-selected={item.id === value}
                  onClick={() => {
                    onChange(item.id);
                    setOpen(false);
                    setQuery("");
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ))}
          {visible.length === 0 && <p className="empty">没有匹配项</p>}
        </div>
      )}
    </div>
  );
}
