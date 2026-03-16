import { useState, useRef, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';
import { LocalizedLink } from '@/components/LocalizedLink';
import { AnimatePresence, motion } from 'framer-motion';

interface MegaMenuColumn {
  title: string;
  items: {
    to: string;
    label: string;
    description?: string;
    icon: React.ReactNode;
    external?: boolean;
  }[];
}

interface MegaMenuProps {
  label: string;
  columns: MegaMenuColumn[];
  onNavigate?: () => void;
}

export function MegaMenu({ label, columns, onNavigate }: MegaMenuProps) {
  const [open, setOpen] = useState(false);
  const [panelShiftX, setPanelShiftX] = useState(0);
  const timeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const enter = () => {
    clearTimeout(timeout.current);
    setOpen(true);
  };

  const leave = () => {
    timeout.current = setTimeout(() => setOpen(false), 150);
  };

  useEffect(() => () => clearTimeout(timeout.current), []);

  useEffect(() => {
    if (!open) {
      setPanelShiftX(0);
      return;
    }

    const clampPanel = () => {
      if (!panelRef.current) return;
      const rect = panelRef.current.getBoundingClientRect();
      const margin = 16;

      let nextShift = 0;
      if (rect.right > window.innerWidth - margin) {
        nextShift -= rect.right - (window.innerWidth - margin);
      }
      if (rect.left + nextShift < margin) {
        nextShift += margin - (rect.left + nextShift);
      }

      setPanelShiftX(nextShift);
    };

    const rafId = requestAnimationFrame(clampPanel);
    window.addEventListener('resize', clampPanel);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', clampPanel);
    };
  }, [open, columns.length]);

  return (
    <div ref={ref} className="relative" onMouseEnter={enter} onMouseLeave={leave}>
      <button className="flex items-center gap-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
        {label}
        <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>

      <AnimatePresence>
        {open && (
          <>
            {/* Invisible bridge so mouse doesn't lose hover between trigger and panel */}
            <div className="absolute left-0 top-full h-3 w-full" />
            <motion.div
              ref={panelRef}
              initial={{ opacity: 0, y: 8, x: 0 }}
              animate={{ opacity: 1, y: 0, x: panelShiftX }}
              exit={{ opacity: 0, y: 8, x: panelShiftX }}
              transition={{ duration: 0.15 }}
              className="absolute left-0 top-[calc(100%+0.75rem)] z-50"
            >
              <div className="rounded-xl border bg-popover p-6 shadow-xl">
                <div className={`grid gap-10 ${columns.length >= 3 ? 'grid-cols-3 min-w-[680px]' : columns.length === 2 ? 'grid-cols-2 min-w-[520px]' : 'grid-cols-1 min-w-[280px]'}`}>
                  {columns.map((col) => (
                    <div key={col.title}>
                      <h4 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                        {col.title}
                      </h4>
                      <div className="flex flex-col gap-1">
                        {col.items.map((item) => (
                          <LocalizedLink
                            key={item.to}
                            to={item.to}
                            onClick={() => {
                              setOpen(false);
                              onNavigate?.();
                            }}
                            className="group flex items-start gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-accent/10"
                          >
                            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/20">
                              {item.icon}
                            </span>
                            <div className="flex flex-col">
                              <span className="text-sm font-medium text-foreground">{item.label}</span>
                              {item.description && (
                                <span className="text-xs text-muted-foreground">{item.description}</span>
                              )}
                            </div>
                          </LocalizedLink>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Mobile version — accordion style */
export function MegaMenuMobile({ label, columns, onNavigate }: MegaMenuProps) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        {label}
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="mt-3 space-y-4 pl-2">
          {columns.map((col) => (
            <div key={col.title}>
              <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                {col.title}
              </h4>
              <div className="flex flex-col gap-1">
                {col.items.map((item) => (
                  <LocalizedLink
                    key={item.to}
                    to={item.to}
                    onClick={() => {
                      setOpen(false);
                      onNavigate?.();
                    }}
                    className="flex items-center gap-2.5 rounded-md px-2 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/10 hover:text-foreground"
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                      {item.icon}
                    </span>
                    {item.label}
                  </LocalizedLink>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
