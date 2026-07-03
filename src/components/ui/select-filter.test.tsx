import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SelectFilter, ALL_FILTER } from "./select-filter";

// Repo convention: don't drive the Radix Select portal in jsdom (no pointer
// polyfills). We cover the trigger surface the migrated filter sites rely on;
// the "all"-sentinel filtering itself lives in each page and is unchanged.
describe("SelectFilter", () => {
  it("exposes the shared 'all' sentinel", () => {
    expect(ALL_FILTER).toBe("all");
  });

  it("shows the all-label in the trigger when the value is the sentinel", () => {
    render(
      <SelectFilter
        value="all"
        onValueChange={() => {}}
        allLabel="All Trainers"
        options={[{ value: "t1", label: "Coach A" }]}
        ariaLabel="Trainer filter"
      />,
    );
    expect(screen.getByRole("combobox", { name: "Trainer filter" })).toHaveTextContent(
      "All Trainers",
    );
  });

  it("shows the selected option's label in the trigger", () => {
    render(
      <SelectFilter
        value="t1"
        onValueChange={() => {}}
        allLabel="All Trainers"
        options={[{ value: "t1", label: "Coach A" }]}
        ariaLabel="Trainer filter"
      />,
    );
    expect(screen.getByRole("combobox", { name: "Trainer filter" })).toHaveTextContent(
      "Coach A",
    );
  });

  it("applies the canonical width by default; triggerClassName REPLACES it entirely", () => {
    const { rerender } = render(
      <SelectFilter value="all" onValueChange={() => {}} allLabel="All" options={[]} ariaLabel="f" />,
    );
    expect(screen.getByRole("combobox", { name: "f" })).toHaveClass("w-full", "sm:w-[160px]");

    // A plain w-[140px] override must not fight a leftover sm: default at
    // breakpoints, so the default is dropped when triggerClassName is passed.
    rerender(
      <SelectFilter
        value="all"
        onValueChange={() => {}}
        allLabel="All"
        options={[]}
        ariaLabel="f"
        triggerClassName="w-[140px] h-9 text-sm"
      />,
    );
    const trigger = screen.getByRole("combobox", { name: "f" });
    expect(trigger).toHaveClass("w-[140px]", "h-9", "text-sm");
    expect(trigger).not.toHaveClass("sm:w-[160px]");
    expect(trigger).not.toHaveClass("w-full");
  });

  it("can be disabled", () => {
    render(
      <SelectFilter
        value="all"
        onValueChange={() => {}}
        allLabel="All"
        options={[]}
        ariaLabel="f"
        disabled
      />,
    );
    expect(screen.getByRole("combobox", { name: "f" })).toBeDisabled();
  });
});
