import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { confirmLeave } from "./drafts";
export default function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const root = ref.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    root?.querySelector<HTMLElement>("input,select,button")?.focus();
    function key(e: KeyboardEvent) {
      if (root && !root.contains(document.activeElement)) return;
      if (e.key === "Escape" && confirmLeave()) close.current();
      if (e.key === "Tab" && root) {
        const items = Array.from(
          root.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]",
          ),
        );
        const first = items[0],
          last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    }
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      document.body.style.overflow = previousOverflow;
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget && confirmLeave()) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={ref}
      >
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button
            className="icon-button"
            aria-label="Cerrar"
            onClick={() => {
              if (confirmLeave()) onClose();
            }}
          >
            <X />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
