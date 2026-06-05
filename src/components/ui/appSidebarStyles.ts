/** Shared authenticated app sidebar shell + nav pill styles (Academy/Player reference). */

export const appSidebarShellClass =
  "[&_[data-sidebar=sidebar]]:border-r [&_[data-sidebar=sidebar]]:border-slate-200 [&_[data-sidebar=sidebar]]:bg-slate-50";

export const appSidebarHeaderClass = "border-b border-slate-200/80 bg-slate-50";
export const appSidebarContentClass = "bg-slate-50";
export const appSidebarFooterClass = "border-t border-slate-200/80 bg-slate-50";

export const appNavLinkBase =
  "flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

export const appNavLinkInactive =
  "text-slate-600 hover:bg-white hover:text-slate-900 [&>svg]:text-slate-500";

export const appNavLinkActive =
  "border border-slate-200 bg-white text-slate-900 shadow-sm [&>svg]:text-[hsl(var(--brand-500))]";

export const appSidebarGhostButtonClass =
  "text-slate-600 hover:bg-white hover:text-slate-900";
