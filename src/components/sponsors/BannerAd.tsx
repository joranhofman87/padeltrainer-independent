import { useEffect, useRef } from 'react';
import { trackEvent } from '@/lib/tracking';
import type { BannerData } from '@/lib/banners';

interface BannerAdProps {
  banner: BannerData;
}

export function BannerAd({ banner }: BannerAdProps) {
  const ref = useRef<HTMLAnchorElement>(null);
  const tracked = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || tracked.current) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !tracked.current) {
          tracked.current = true;
          trackEvent('banner_impression', {
            banner_id: banner._id,
            banner_tracking_id: banner.trackingId,
            banner_title: banner.title,
            sponsor_name: banner.sponsorName,
            sponsor_slug: banner.sponsorSlug,
            sponsor_plan: banner.sponsorPlan,
            zone: banner.zone,
            click_url: banner.clickUrl,
          });
        }
      },
      { threshold: 0.5 }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [banner]);

  const handleClick = () => {
    trackEvent('banner_click', {
      banner_id: banner._id,
      banner_tracking_id: banner.trackingId,
      banner_title: banner.title,
      sponsor_name: banner.sponsorName,
      sponsor_slug: banner.sponsorSlug,
      sponsor_plan: banner.sponsorPlan,
      zone: banner.zone,
      click_url: banner.clickUrl,
    });
  };

  return (
    <a
      ref={ref}
      href={banner.clickUrl}
      target="_blank"
      rel="noopener noreferrer sponsored"
      onClick={handleClick}
      className="block relative group rounded-lg overflow-hidden"
    >
      <span className="absolute top-1 right-1 text-[10px] text-muted-foreground bg-background/80 px-1.5 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity z-10">
        Sponsored
      </span>
      <img
        src={banner.image}
        alt={banner.imageAlt || `${banner.sponsorName} banner`}
        className="w-full h-auto rounded-lg"
        loading="lazy"
        decoding="async"
      />
      {banner.ctaText && (
        <span className="absolute bottom-2 right-2 bg-primary text-primary-foreground text-sm px-3 py-1 rounded-full shadow-sm">
          {banner.ctaText}
        </span>
      )}
    </a>
  );
}
