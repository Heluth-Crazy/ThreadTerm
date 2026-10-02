import {
  Children,
  Fragment,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "../PrototypeIcon";

export type SelectChangeEvent = { target: { value: string } };

type OptionProps = {
  value?: string | number;
  disabled?: boolean;
  children?: ReactNode;
};

type SelectOption = {
  value: string;
  label: ReactNode;
  disabled: boolean;
  key: string;
};

export type SelectProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "value" | "defaultValue" | "onChange" | "type"
> & {
  value?: string | number;
  defaultValue?: string | number;
  onChange?: (event: SelectChangeEvent) => void;
  children?: ReactNode;
};

function optionText(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(optionText).join("");
  if (isValidElement<{ children?: ReactNode }>(value)) return optionText(value.props.children);
  return "";
}

function readOptions(children: ReactNode): SelectOption[] {
  return Children.toArray(children).flatMap((child, index) => {
    if (!isValidElement<OptionProps>(child)) return [];
    if (child.type === Fragment) return readOptions(child.props.children);
    if (child.type !== "option") return [];
    const label = child.props.children;
    const value = child.props.value === undefined ? optionText(label) : String(child.props.value);
    return [{
      value,
      label,
      disabled: Boolean(child.props.disabled),
      key: child.key === null ? `${value}-${index}` : String(child.key),
    }];
  });
}

function nextEnabled(options: SelectOption[], start: number, direction: 1 | -1): number {
  if (!options.length) return -1;
  let index = start;
  for (let count = 0; count < options.length; count += 1) {
    index = (index + direction + options.length) % options.length;
    if (!options[index].disabled) return index;
  }
  return -1;
}

function firstEnabled(options: SelectOption[], fromEnd = false): number {
  if (fromEnd) {
    for (let index = options.length - 1; index >= 0; index -= 1) {
      if (!options[index].disabled) return index;
    }
  } else {
    for (let index = 0; index < options.length; index += 1) {
      if (!options[index].disabled) return index;
    }
  }
  return -1;
}

function keepInViewport(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function Select({
  value: controlledValue,
  defaultValue = "",
  onChange,
  children,
  className = "",
  disabled = false,
  onClick: externalOnClick,
  onKeyDown: externalOnKeyDown,
  ...buttonProps
}: SelectProps) {
  const options = readOptions(children);
  const [uncontrolledValue, setUncontrolledValue] = useState(String(defaultValue));
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const optionIdPrefix = `tt-select-option-${menuId.replace(/:/g, "")}`;
  const currentValue = controlledValue === undefined ? uncontrolledValue : String(controlledValue);
  const selectedIndex = options.findIndex((option) => option.value === currentValue);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const updatePosition = useCallback(() => {
    const element = trigger.current;
    if (!element || typeof window === "undefined") return;
    const rect = element.getBoundingClientRect();
    const margin = 8;
    const width = Math.min(Math.max(rect.width, 160), Math.max(160, window.innerWidth - margin * 2));
    const preferredHeight = Math.min(320, Math.max(40, options.length * 34 + 10));
    const below = Math.max(40, window.innerHeight - rect.bottom - margin);
    const above = Math.max(40, rect.top - margin);
    const openAbove = below < preferredHeight && above > below;
    const maxHeight = Math.min(preferredHeight, openAbove ? above : below);
    const left = keepInViewport(rect.left, margin, window.innerWidth - width - margin);
    setMenuStyle({
      left,
      width,
      maxHeight,
      ...(openAbove ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
    });
  }, [options.length]);

  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return undefined;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !menu.current?.contains(target)) setOpen(false);
    };
    const reposition = () => updatePosition();
    document.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const current = selectedIndex >= 0 && !options[selectedIndex].disabled
      ? selectedIndex
      : firstEnabled(options);
    setActiveIndex(current);
  }, [open, options.length, selectedIndex]);

  const choose = useCallback((index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    if (controlledValue === undefined) setUncontrolledValue(option.value);
    onChange?.({ target: { value: option.value } });
    setOpen(false);
    trigger.current?.focus();
  }, [controlledValue, onChange, options]);

  const openMenu = (fromEnd = false) => {
    if (disabled) return;
    const index = selectedIndex >= 0 && !options[selectedIndex].disabled
      ? selectedIndex
      : firstEnabled(options, fromEnd);
    setActiveIndex(index);
    setOpen(true);
  };

  const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    externalOnKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openMenu();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        openMenu(true);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => nextEnabled(options, index < 0 ? (event.key === "ArrowDown" ? -1 : 0) : index, event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActiveIndex(firstEnabled(options, event.key === "End"));
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (activeIndex >= 0) choose(activeIndex);
    }
  };

  const triggerClass = ["tt-select-trigger", className].filter(Boolean).join(" ");
  const rootClass = ["tt-select", className].filter(Boolean).join(" ");

  return (
    <span className={rootClass}>
      <button
        {...buttonProps}
        ref={trigger}
        type="button"
        className={triggerClass}
        disabled={disabled}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        aria-activedescendant={open && activeIndex >= 0 ? `${optionIdPrefix}-${activeIndex}` : undefined}
        data-value={currentValue}
        onClick={(event) => {
          externalOnClick?.(event);
          if (!event.defaultPrevented) (open ? setOpen(false) : openMenu());
        }}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="tt-select-value">{selected?.label ?? currentValue}</span>
        <Icon name="chevD" className="tt-select-chevron" />
      </button>
      {open && menuStyle && createPortal(
        <div ref={menu} id={menuId} className="tt-select-menu" role="listbox" style={menuStyle} aria-label={buttonProps["aria-label"]}>
          {options.map((option, index) => (
            <button
              key={option.key}
              id={`${optionIdPrefix}-${index}`}
              type="button"
              role="option"
              aria-selected={index === selectedIndex}
              aria-disabled={option.disabled || undefined}
              data-value={option.value}
              disabled={option.disabled}
              className={`tt-select-option${index === activeIndex ? " is-active" : ""}${index === selectedIndex ? " is-selected" : ""}`}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(index)}
            >
              <span className="tt-select-option-label">{option.label}</span>
              {index === selectedIndex && <Icon name="check" className="tt-select-option-check" />}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </span>
  );
}
