"use client";

import { type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { type SelectOption, filterOptions, moveActive, popupPosition, typeaheadMatch } from "@/lib/select";

export type { SelectOption };

const FIELD =
  "w-full rounded-md border border-zinc-300 bg-transparent py-2 pr-9 pl-3 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-zinc-500 disabled:opacity-60 aria-[invalid=true]:border-red-600 dark:border-zinc-700";

const TYPEAHEAD_RESET_MS = 500;

function Chevron() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-zinc-500 dark:text-zinc-400"
    >
      <path d="M5.2 7.2a.75.75 0 0 1 1.06 0L10 10.94l3.74-3.74a.75.75 0 1 1 1.06 1.06l-4.27 4.27a.75.75 0 0 1-1.06 0L5.2 8.26a.75.75 0 0 1 0-1.06Z" />
    </svg>
  );
}

type ListProps = {
  id: string;
  anchor: RefObject<HTMLElement | null>;
  options: SelectOption[];
  active: number;
  selected: string;
  onPick: (option: SelectOption) => void;
  onActive: (index: number) => void;
  onDismiss: () => void;
};

// The open list. It's a popover because that puts it in the top layer: above a modal dialog, and
// not clipped by the dialog's scrolling body.
function OptionList({ id, anchor, options, active, selected, onPick, onActive, onDismiss }: ListProps) {
  const ref = useRef<HTMLUListElement>(null);
  const dismiss = useRef(onDismiss);

  useLayoutEffect(() => {
    dismiss.current = onDismiss;
  });

  useLayoutEffect(() => {
    ref.current?.showPopover();
  }, []);

  useLayoutEffect(() => {
    const place = () => {
      const list = ref.current;
      const trigger = anchor.current?.getBoundingClientRect();
      if (!list || !trigger) return;
      const position = popupPosition({
        trigger,
        popupHeight: list.scrollHeight + 2, // the list's 1px borders
        viewport: { width: window.innerWidth, height: window.innerHeight },
      });
      list.style.top = `${position.top}px`;
      list.style.left = `${position.left}px`;
      list.style.width = `${position.width}px`;
      list.style.maxHeight = `${position.maxHeight}px`;
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchor, options.length]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!anchor.current?.contains(target) && !ref.current?.contains(target)) dismiss.current();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [anchor]);

  useEffect(() => {
    ref.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <ul
      ref={ref}
      id={id}
      role="listbox"
      popover="manual"
      // Keeps focus on the field, which is what handles the keyboard.
      onPointerDown={(event) => event.preventDefault()}
      className="fixed inset-auto m-0 overflow-y-auto rounded-md border border-zinc-200 bg-white p-1 text-sm text-zinc-900 shadow-lg dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
    >
      {options.map((option, index) => {
        const isSelected = option.value === selected;
        return (
          <li
            key={option.value}
            id={`${id}-${index}`}
            data-index={index}
            role="option"
            aria-selected={isSelected}
            onClick={() => onPick(option)}
            onPointerMove={() => onActive(index)}
            className={`flex cursor-pointer items-center justify-between gap-2 rounded px-2.5 py-2 [overflow-wrap:anywhere] ${
              index === active ? "bg-zinc-100 dark:bg-zinc-800" : ""
            } ${isSelected ? "font-medium" : ""}`}
          >
            {option.label}
            {isSelected ? (
              <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="size-4 shrink-0">
                <path d="M16.7 5.3a1 1 0 0 1 0 1.4l-8 8a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4L8 12.58l7.3-7.28a1 1 0 0 1 1.4 0Z" />
              </svg>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

type FieldProps = {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  ariaLabel?: string;
  className?: string;
};

// Choose one option from a list. Pair it with <label htmlFor={id}>, or pass ariaLabel.
export function Select({
  id,
  value,
  onChange,
  options,
  placeholder,
  disabled,
  invalid,
  describedBy,
  ariaLabel,
  className = "w-full",
}: FieldProps & { placeholder?: string }) {
  const listId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const typed = useRef("");
  const typedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(typedTimer.current), []);

  const selectedIndex = options.findIndex((o) => o.value === value);
  const showList = () => {
    setActive(selectedIndex);
    setOpen(true);
  };
  const pick = (option: SelectOption) => {
    setOpen(false);
    if (option.value !== value) onChange(option.value);
  };

  function typeahead(key: string) {
    clearTimeout(typedTimer.current);
    typed.current += key;
    typedTimer.current = setTimeout(() => {
      typed.current = "";
    }, TYPEAHEAD_RESET_MS);
    const from = open ? active : selectedIndex;
    const match = typeaheadMatch(options, typed.current, from);
    if (!open) setOpen(true);
    setActive(match >= 0 ? match : from);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    const { key } = event;
    if (key === "Tab") {
      setOpen(false);
      return;
    }
    if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && (key !== " " || typed.current !== "")) {
      event.preventDefault();
      typeahead(key);
      return;
    }
    if (!open) {
      if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") {
        event.preventDefault();
        showList();
      }
      return;
    }
    if (key === "ArrowDown" || key === "ArrowUp") setActive((a) => moveActive(a, key === "ArrowDown" ? 1 : -1, options.length));
    else if (key === "Home") setActive(options.length > 0 ? 0 : -1);
    else if (key === "End") setActive(options.length - 1);
    else if ((key === "Enter" || key === " ") && options[active]) pick(options[active]);
    else if (key === "Enter" || key === " " || key === "Escape") setOpen(false);
    else return;
    // Includes Escape, which would otherwise close a dialog around this field as well.
    event.preventDefault();
  }

  return (
    <div className={`relative min-w-0 ${className}`}>
      <button
        ref={trigger}
        id={id}
        type="button"
        role="combobox"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        onClick={() => (open ? setOpen(false) : showList())}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
        className={`${FIELD} block truncate`}
      >
        {selectedIndex >= 0 ? (
          options[selectedIndex].label
        ) : (
          <span className="text-zinc-500 dark:text-zinc-400">{placeholder ?? " "}</span>
        )}
      </button>
      <Chevron />
      {open ? (
        <OptionList
          id={listId}
          anchor={trigger}
          options={options}
          active={active}
          selected={value}
          onPick={pick}
          onActive={setActive}
          onDismiss={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

// A text field with suggestions: pick one, or type something that isn't on the list.
export function ComboBox({
  id,
  value,
  onChange,
  options,
  disabled,
  invalid,
  describedBy,
  ariaLabel,
  className = "w-full",
  maxLength,
}: FieldProps & { maxLength?: number }) {
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  const shown = filterOptions(options, value);
  const expanded = open && shown.length > 0;

  const pick = (option: SelectOption) => {
    setOpen(false);
    setActive(-1);
    onChange(option.value);
  };

  function onKeyDown(event: React.KeyboardEvent) {
    const { key } = event;
    if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActive((a) => moveActive(expanded ? a : -1, key === "ArrowDown" ? 1 : -1, shown.length));
    } else if (key === "Enter" && expanded && shown[active]) {
      event.preventDefault();
      pick(shown[active]);
    } else if (key === "Escape" && expanded) {
      // Otherwise it would close a dialog around this field as well.
      event.preventDefault();
      setOpen(false);
    } else if (key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <div className={`relative min-w-0 ${className}`}>
      <input
        ref={input}
        id={id}
        type="text"
        role="combobox"
        autoComplete="off"
        maxLength={maxLength}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        aria-activedescendant={expanded && active >= 0 ? `${listId}-${active}` : undefined}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        onChange={(event) => {
          setActive(-1);
          setOpen(true);
          onChange(event.target.value);
        }}
        onClick={() => setOpen(true)}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
        className={FIELD}
      />
      <Chevron />
      {expanded ? (
        <OptionList
          id={listId}
          anchor={input}
          options={shown}
          active={active}
          selected={value}
          onPick={pick}
          onActive={setActive}
          onDismiss={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}
