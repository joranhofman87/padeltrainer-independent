import { useRef, useEffect, useCallback } from "react";
import { useBannerRotation } from "@/hooks/useBannerRotation";

interface SponsorBannerProps {
  placementSlug: string;
  locationId?: string;
  className?: string;
}

export function SponsorBanner({ placementSlug, locationId, className = "" }: SponsorBannerProps) {
  const { currentBanner, loading, trackEvent, hasBanners } = useBannerRotation({
    placementSlug,
    locationId,
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const impressionTracked = useRef<string | null>(null);

  // Track impression when banner enters viewport
  useEffect(() => {
    if (!currentBanner || !containerRef.current) return;
    if (impressionTracked.current === currentBanner.id) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && currentBanner && impressionTracked.current !== currentBanner.id) {
          impressionTracked.current = currentBanner.id;
          trackEvent("impression");
        }
      },
      { threshold: 0.5 }
    );

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [currentBanner, trackEvent]);

  // Reset impression tracking when banner changes
  useEffect(() => {
    if (currentBanner) {
      impressionTracked.current = null;
    }
  }, [currentBanner?.id]);

  const handleClick = useCallback(() => {
    trackEvent("click");
    if (currentBanner?.link_url) {
      window.open(currentBanner.link_url, "_blank", "noopener,noreferrer");
    }
  }, [currentBanner, trackEvent]);

  if (loading || !hasBanners || !currentBanner) return null;

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <div
        className="cursor-pointer overflow-hidden rounded-lg border border-border bg-muted transition-opacity hover:opacity-90"
        onClick={handleClick}
        role="link"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && handleClick()}
      >
        <img
          src={currentBanner.image_url}
          alt={currentBanner.sponsor_name || currentBanner.name}
          className="w-full h-auto object-cover"
          loading="lazy"
        />
      </div>
      <span className="absolute bottom-1 right-1 rounded bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground backdrop-blur-sm">
        Sponsored
      </span>
    </div>
  );
}
