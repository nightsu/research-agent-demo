import type { ComponentPropsWithoutRef } from "react";

type ReportPhase = "draft" | "final";

export interface ReportShellProps extends ComponentPropsWithoutRef<"article"> {
  phase: ReportPhase;
}

export function ReportShell({
  phase,
  className,
  children,
  ...articleProps
}: ReportShellProps) {
  // Shell 只稳定报告纸的 DOM 与视觉边界；内容、安全策略和滚动仍由各自组件负责。
  const classes = ["research-report", `report-shell-${phase}`, className]
    .filter(Boolean)
    .join(" ");

  return (
    <article
      {...articleProps}
      className={classes}
      data-report-phase={phase}
    >
      {children}
    </article>
  );
}
