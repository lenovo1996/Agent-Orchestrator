import * as React from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"

export interface AccordionProps extends React.HTMLAttributes<HTMLDivElement> {
  type?: "single" | "multiple"
  collapsible?: boolean
  value?: string | string[]
  onValueChange?: (value: any) => void
}

export const Accordion = React.forwardRef<HTMLDivElement, AccordionProps>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("space-y-1", className)} {...props} />
  )
)
Accordion.displayName = "Accordion"

export interface AccordionItemProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string
}

const AccordionContext = React.createContext<{
  openItems: string[];
  toggleItem: (value: string) => void;
} | null>(null);

export const AccordionRoot = ({
  type = "multiple",
  className,
  children
}: {
  type?: "single" | "multiple",
  className?: string,
  children: React.ReactNode
}) => {
  const [openItems, setOpenItems] = React.useState<string[]>([]);

  const toggleItem = React.useCallback((value: string) => {
    setOpenItems(prev => {
      if (type === "single") {
        return prev.includes(value) ? [] : [value];
      }
      return prev.includes(value)
        ? prev.filter(i => i !== value)
        : [...prev, value];
    });
  }, [type]);

  return (
    <AccordionContext.Provider value={{ openItems, toggleItem }}>
      <div className={cn("space-y-1", className)}>
        {children}
      </div>
    </AccordionContext.Provider>
  );
}

export const AccordionItem = React.forwardRef<HTMLDivElement, AccordionItemProps>(
  ({ className, value, children, ...props }, ref) => {
    const ctx = React.useContext(AccordionContext);
    const isOpen = ctx?.openItems.includes(value);

    return (
      <div
        ref={ref}
        className={cn("border rounded-md border-border bg-card", className)}
        data-state={isOpen ? "open" : "closed"}
        {...props}
      >
        {React.Children.map(children, child => {
          if (React.isValidElement(child)) {
             return React.cloneElement(child, { value, isOpen, toggleItem: ctx?.toggleItem } as any);
          }
          return child;
        })}
      </div>
    )
  }
)
AccordionItem.displayName = "AccordionItem"

export const AccordionTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { value?: string; isOpen?: boolean; toggleItem?: (v: string) => void }
>(({ className, children, value, isOpen, toggleItem, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    onClick={() => value && toggleItem?.(value)}
    className={cn(
      "flex flex-1 w-full items-center justify-between py-2 px-3 text-sm font-medium transition-all hover:bg-muted/50 text-left",
      className
    )}
    {...props}
  >
    {children}
    <ChevronDown
      className={cn(
        "h-4 w-4 shrink-0 transition-transform duration-200 text-muted-foreground",
        isOpen && "rotate-180"
      )}
    />
  </button>
))
AccordionTrigger.displayName = "AccordionTrigger"

export const AccordionContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { isOpen?: boolean }
>(({ className, children, isOpen, ...props }, ref) => {
  if (!isOpen) return null;

  return (
    <div
      ref={ref}
      className={cn(
        "overflow-hidden text-sm border-t border-border",
        className
      )}
      {...props}
    >
      <div className="p-3">{children}</div>
    </div>
  )
})
AccordionContent.displayName = "AccordionContent"
