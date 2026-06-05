import { describe, it, expect, vi, beforeEach } from "vitest";

const eqMock = vi.fn();
const orderMock = vi.fn();
const selectMock = vi.fn();

vi.mock("@/lib/supabaseClient", () => ({
  supabase: {
    from: vi.fn(() => ({
      select: selectMock,
    })),
  },
}));

vi.mock("@/lib/playerRemovalVisibility", () => ({
  fetchRemovedPlayerKeys: vi.fn().mockResolvedValue({ guestIds: new Set(), profileIds: new Set() }),
  filterGuestRowsByRemoval: vi.fn(
    (rows: { id: string }[], keys: { guestIds: Set<string> }) =>
      rows.filter((g) => !keys.guestIds.has(g.id)),
  ),
  mergeRemovedPlayerKeys: vi.fn((...sets: { guestIds: Set<string>; profileIds: Set<string> }[]) => ({
    guestIds: new Set(sets.flatMap((s) => Array.from(s.guestIds))),
    profileIds: new Set(sets.flatMap((s) => Array.from(s.profileIds))),
  })),
}));

import { supabase } from "@/lib/supabaseClient";
import {
  GUEST_PLAYER_ACADEMY_FILTER_COLUMN,
  GUEST_PLAYER_TRAINER_FILTER_COLUMN,
  GUEST_PLAYER_CALENDAR_SELECT,
  getGuestPlayerLoadStrategy,
  getGuestPlayerQueryFilter,
  loadGuestPlayersForAcademy,
  loadGuestPlayersForTrainer,
  loadGuestPlayersForBulkCreate,
  loadActiveGuestPlayersForBooking,
  usesAcademyProfileIdFilterOnly,
} from "@/lib/guestPlayers";
import { fetchRemovedPlayerKeys } from "@/lib/playerRemovalVisibility";

describe("guest player query filters", () => {
  it("academy filter uses academy_profile_id only", () => {
    expect(getGuestPlayerQueryFilter("academy", "academy-1")).toEqual({
      column: GUEST_PLAYER_ACADEMY_FILTER_COLUMN,
      value: "academy-1",
    });
    expect(GUEST_PLAYER_ACADEMY_FILTER_COLUMN).toBe("academy_profile_id");
    expect(usesAcademyProfileIdFilterOnly()).toBe(true);
  });

  it("trainer filter uses trainer_id", () => {
    expect(getGuestPlayerQueryFilter("trainer", "trainer-1")).toEqual({
      column: GUEST_PLAYER_TRAINER_FILTER_COLUMN,
      value: "trainer-1",
    });
  });

  it("calendar select uses linked_profile_id not linked_player_id", () => {
    expect(GUEST_PLAYER_CALENDAR_SELECT).toContain("linked_profile_id");
    expect(GUEST_PLAYER_CALENDAR_SELECT).not.toContain("linked_player_id");
  });
});

describe("getGuestPlayerLoadStrategy (bulk create)", () => {
  it("prefers academy loader when academyId is set", () => {
    expect(getGuestPlayerLoadStrategy("academy-1", "trainer-1")).toBe("academy");
  });

  it("uses trainer loader when only trainerId is set", () => {
    expect(getGuestPlayerLoadStrategy(undefined, "trainer-1")).toBe("trainer");
  });
});

describe("guest player Supabase loaders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eqMock.mockReturnValue({ order: orderMock });
    selectMock.mockReturnValue({ eq: eqMock });
    orderMock.mockResolvedValue({ data: [{ id: "g1" }], error: null });
  });

  it("loadGuestPlayersForAcademy filters by academy_profile_id", async () => {
    await loadGuestPlayersForAcademy("academy-uuid");
    expect(supabase.from).toHaveBeenCalledWith("guest_players");
    expect(eqMock).toHaveBeenCalledWith("academy_profile_id", "academy-uuid");
    expect(eqMock).not.toHaveBeenCalledWith("trainer_id", expect.anything());
    expect(eqMock).not.toHaveBeenCalledWith("trainer_id", null);
  });

  it("loadGuestPlayersForTrainer filters by trainer_id", async () => {
    await loadGuestPlayersForTrainer("trainer-uuid");
    expect(eqMock).toHaveBeenCalledWith("trainer_id", "trainer-uuid");
    expect(eqMock).not.toHaveBeenCalledWith("academy_profile_id", expect.anything());
  });

  it("loadGuestPlayersForBulkCreate uses academy path when academyId is set", async () => {
    await loadGuestPlayersForBulkCreate("academy-uuid", "trainer-uuid");
    expect(eqMock).toHaveBeenCalledWith("academy_profile_id", "academy-uuid");
    expect(eqMock).not.toHaveBeenCalledWith("trainer_id", "trainer-uuid");
  });

  it("loadGuestPlayersForBulkCreate uses trainer path without academyId", async () => {
    await loadGuestPlayersForBulkCreate(undefined, "trainer-uuid");
    expect(eqMock).toHaveBeenCalledWith("trainer_id", "trainer-uuid");
  });

  it("loadActiveGuestPlayersForBooking applies trainer removal keys", async () => {
    vi.mocked(fetchRemovedPlayerKeys).mockResolvedValue({
      guestIds: new Set(["g-removed"]),
      profileIds: new Set(),
    });
    orderMock.mockResolvedValue({
      data: [
        { id: "g-active", full_name: "Active" },
        { id: "g-removed", full_name: "Removed" },
      ],
      error: null,
    });

    const { data } = await loadActiveGuestPlayersForBooking("trainer-uuid");
    expect(data?.map((g) => g.id)).toEqual(["g-active"]);
    expect(fetchRemovedPlayerKeys).toHaveBeenCalledWith({
      kind: "trainer",
      trainerProfileId: "trainer-uuid",
    });
  });
});
