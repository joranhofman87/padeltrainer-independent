import React from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { 
  MapPin, CheckCircle, Clock, Play,
  Instagram, Youtube, Linkedin, Facebook
} from 'lucide-react';
import { StarRating } from '@/components/reviews/StarRating';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface SocialLink {
  platform: 'instagram' | 'tiktok' | 'youtube' | 'linkedin' | 'facebook';
  handle: string;
}

interface ProfileHeroCardProps {
  name: string;
  avatarUrl?: string | null;
  avatarAlt?: string; // For SEO-friendly alt text
  location?: string | null;
  isVerified?: boolean;
  
  experienceYears?: number | null;
  averageRating?: number | null;
  reviewCount?: number;
  socialLinks?: SocialLink[];
  quote?: string | null;
  videoUrl?: string | null;
  onVideoPlay?: () => void;
  children?: React.ReactNode; // For action buttons
  statsSlot?: React.ReactNode; // For additional stats like courts count
  badgeSlot?: React.ReactNode; // For additional badges
}

export function ProfileHeroCard({
  name,
  avatarUrl,
  avatarAlt,
  location,
  isVerified,
  hourlyRate,
  experienceYears,
  averageRating,
  reviewCount = 0,
  socialLinks,
  quote,
  videoUrl,
  onVideoPlay,
  children,
  statsSlot,
  badgeSlot,
}: ProfileHeroCardProps) {
  const { t } = useTranslation('common');

  const getInitials = (fullName: string | null) => {
    if (!fullName) return 'P';
    return fullName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  };

  const getSocialUrl = (platform: string, value: string | null) => {
    if (!value) return null;
    if (value.startsWith('http')) return value;
    const cleanHandle = value.replace('@', '');
    switch (platform) {
      case 'instagram': return `https://instagram.com/${cleanHandle}`;
      case 'tiktok': return `https://tiktok.com/@${cleanHandle}`;
      case 'youtube': return value.startsWith('http') ? value : `https://youtube.com/@${cleanHandle}`;
      case 'linkedin': return value.startsWith('http') ? value : `https://linkedin.com/${cleanHandle}`;
      case 'facebook': return value.startsWith('http') ? value : `https://facebook.com/${cleanHandle}`;
      default: return null;
    }
  };

  const hasSocialLinks = socialLinks && socialLinks.length > 0;

  const renderSocialIcon = (platform: string) => {
    switch (platform) {
      case 'instagram':
        return <Instagram className="h-5 w-5" />;
      case 'tiktok':
        return (
          <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
            <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1-.1z"/>
          </svg>
        );
      case 'youtube':
        return <Youtube className="h-5 w-5" />;
      case 'linkedin':
        return <Linkedin className="h-5 w-5" />;
      case 'facebook':
        return <Facebook className="h-5 w-5" />;
      default:
        return null;
    }
  };

  return (
    <Card className="mb-8 overflow-hidden">
      <CardContent className="p-0">
        <div className="relative bg-gradient-to-r from-primary/10 via-primary/5 to-transparent p-6 md:p-10">
          <div className="flex flex-col lg:flex-row gap-8">
            {/* Avatar with video play button */}
            <div className="relative mx-auto lg:mx-0">
              <Avatar className="h-36 w-36 ring-4 ring-background shadow-xl bg-muted">
                <AvatarImage 
                  src={avatarUrl || undefined} 
                  alt={avatarAlt || `${name} profile photo`}
                  className="object-cover"
                />
                <AvatarFallback className="text-4xl bg-primary text-primary-foreground">
                  {getInitials(name)}
                </AvatarFallback>
              </Avatar>
              {videoUrl && onVideoPlay && (
                <button
                  onClick={onVideoPlay}
                  className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-full opacity-0 hover:opacity-100 transition-opacity"
                >
                  <div className="bg-white/90 rounded-full p-3">
                    <Play className="h-6 w-6 text-primary fill-primary" />
                  </div>
                </button>
              )}
            </div>

            {/* Main Info */}
            <div className="flex-1 text-center lg:text-left">
              <div className="flex flex-col lg:flex-row lg:items-center gap-2 mb-3">
                <h1 className="text-3xl md:text-4xl font-bold">{name}</h1>
                {isVerified && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <CheckCircle className="h-5 w-5 text-green-500 flex-shrink-0" />
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>{t('verifiedProfile', 'Verified profile')}</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
                {badgeSlot}
              </div>

              {/* Location & Quick Stats */}
              <div className="flex flex-wrap gap-4 justify-center lg:justify-start mb-4">
                {location && (
                  <span className="text-muted-foreground flex items-center gap-1">
                    <MapPin className="h-4 w-4" />
                    {location}
                  </span>
                )}
                {hourlyRate && (
                  <span className="flex items-center gap-1">
                    <span className="font-bold text-xl text-primary">€{hourlyRate}</span>
                    <span className="text-muted-foreground">/hour</span>
                  </span>
                )}
                {experienceYears && (
                  <span className="text-muted-foreground flex items-center gap-1">
                    <Clock className="h-4 w-4" />
                    {experienceYears} {t('years', 'years')}
                  </span>
                )}
                {averageRating !== null && averageRating !== undefined && (
                  <span className="flex items-center gap-1">
                    <StarRating rating={averageRating} size="sm" />
                    <span className="text-muted-foreground">({reviewCount})</span>
                  </span>
                )}
                {statsSlot}
              </div>

              {/* Social Links */}
              {hasSocialLinks && (
                <div className="flex gap-3 justify-center lg:justify-start mb-4">
                  {socialLinks.map((link) => (
                    <a
                      key={link.platform}
                      href={getSocialUrl(link.platform, link.handle) || '#'}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-2 rounded-full bg-muted hover:bg-muted/80 transition-colors"
                    >
                      {renderSocialIcon(link.platform)}
                    </a>
                  ))}
                </div>
              )}

              {/* Quote */}
              {quote && (
                <blockquote className="relative pl-4 border-l-2 border-primary/50 italic text-muted-foreground mb-4">
                  "{quote}"
                </blockquote>
              )}
            </div>

            {/* Action Buttons */}
            {children && (
              <div className="flex flex-col gap-2 w-full lg:w-auto lg:min-w-[180px]">
                {children}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
