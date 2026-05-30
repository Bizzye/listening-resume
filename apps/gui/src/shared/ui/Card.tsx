import { clsx } from "clsx";
import { type HTMLAttributes, forwardRef } from "react";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  active?: boolean;
  hoverable?: boolean;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ active, hoverable = true, className, children, ...props }, ref) => (
    <div
      ref={ref}
      className={clsx(
        "rounded-xl border bg-surface-elevated p-4 transition-all duration-200",
        active ? "border-accent/40 bg-accent-subtle" : "border-border",
        hoverable &&
          "hover:border-border-strong hover:bg-surface-hover cursor-pointer",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  ),
);

Card.displayName = "Card";
