import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/lib/supabaseClient";

interface BannerWithAssignment {
  id: string;
  name: string;
  image_url: string;
  link_url: string | null;
  sponsor_name: string | null;
  sponsor_logo_url: string | null;
  weight: number;
  placement_id: string;
}

interface UseBannerRotationOptions {
  placementSlug: string;
  locationId?: string;
}

function getSessionId(): string {
  let sid = sessionStorage.getItem("banner_session_id");
  if (!sid) {
    sid = crypto.randomUUID();
    sessionStorage.setItem("banner_session_id", sid);
  }
  return sid;
}

function weightedRandom(banners: BannerWithAssignment[]): BannerWithAssignment | null {
  if (banners.length === 0) return null;
  const totalWeight = banners.reduce((sum, b) => sum + b.weight, 0);
  let r = Math.random() * totalWeight;
  for (const banner of banners) {
    r -= banner.weight;
    if (r <= 0) return banner;
  }
  return banners[0];
}

export function useBannerRotation({ placementSlug, locationId }: UseBannerRotationOptions) {
  const [banners, setBanners] = useState<BannerWithAssignment[]>([]);
  const [currentBanner, setCurrentBanner] = useState<BannerWithAssignment | null>(null);
  const [rotationInterval, setRotationInterval] = useState(15);
  const [loading, setLoading] = useState(true);
  const sessionId = useRef(getSessionId());

  // Fetch banners for this placement
  useEffect(() => {
    async function fetchBanners() {
      const now = new Date().toISOString();

      // Get placement info
      const { data: placement } = await supabase
        .from("banner_placements")
        .select("id, rotation_interval_seconds")
        .eq("slug", placementSlug)
        .single();

      if (!placement) {
        setLoading(false);
        return;
      }

      setRotationInterval(placement.rotation_interval_seconds || 15);

      // Get active assignments with their banners
      const { data: assignments } = await supabase
        .from("banner_placement_assignments")
        .select(`
          id, weight, priority, placement_id,
          banner:partner_banners (
            id, name, image_url, link_url, sponsor_name, sponsor_logo_url,
            is_active, start_date, end_date, location_id
          )
        `)
        .eq("placement_id", placement.id)
        .eq("is_active", true)
        .order("priority", { ascending: false });

      if (!assignments) {
        setLoading(false);
        return;
      }

      // Filter active banners with valid dates and location
      const activeBanners: BannerWithAssignment[] = [];
      for (const a of assignments) {
        const b = a.banner as any;
        if (!b || !b.is_active) continue;
        if (b.start_date && b.start_date > now) continue;
        if (b.end_date && b.end_date < now) continue;
        if (b.location_id && locationId && b.location_id !== locationId) continue;
        // Global banners (no location_id) always show
        activeBanners.push({
          id: b.id,
          name: b.name,
          image_url: b.image_url,
          link_url: b.link_url,
          sponsor_name: b.sponsor_name,
          sponsor_logo_url: b.sponsor_logo_url,
          weight: a.weight || 1,
          placement_id: placement.id,
        });
      }

      setBanners(activeBanners);
      setCurrentBanner(weightedRandom(activeBanners));
      setLoading(false);
    }

    fetchBanners();
  }, [placementSlug, locationId]);

  // Auto-rotate
  useEffect(() => {
    if (banners.length <= 1) return;
    const interval = setInterval(() => {
      setCurrentBanner(weightedRandom(banners));
    }, rotationInterval * 1000);
    return () => clearInterval(interval);
  }, [banners, rotationInterval]);

  const trackEvent = useCallback(
    async (eventType: "impression" | "click") => {
      if (!currentBanner) return;
      try {
        await supabase.functions.invoke("track-banner-event", {
          body: {
            banner_id: currentBanner.id,
            placement_id: currentBanner.placement_id,
            event_type: eventType,
            page_url: window.location.href,
            session_id: sessionId.current,
          },
        });
      } catch {
        // Silent fail for tracking
      }
    },
    [currentBanner]
  );

  return { currentBanner, loading, trackEvent, hasBanners: banners.length > 0 };
}
