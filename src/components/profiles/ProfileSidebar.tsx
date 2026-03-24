import React from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { 
  Users, Calendar, Star, Target, LayoutGrid, 
  Instagram, Youtube, Linkedin, Facebook, Mail, Phone
} from 'lucide-react';
import { Button } from '@/components/ui/button';

interface StatItem {
  icon: React.ReactNode;
  label: string;
  value: string | number;
}

interface ProfileQuickStatsCardProps {
  stats: StatItem[];
  title?: string;
}

export function ProfileQuickStatsCard({ stats, title }: ProfileQuickStatsCardProps) {
  const { t } = useTranslation('common');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title || t('quickStats', 'Quick Stats')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {stats.map((stat, index) => (
          <React.Fragment key={index}>
            {index > 0 && <Separator />}
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground flex items-center gap-2">
                {stat.icon}
                {stat.label}
              </span>
              <span className="font-semibold">{stat.value}</span>
            </div>
          </React.Fragment>
        ))}
      </CardContent>
    </Card>
  );
}

interface SocialLink {
  platform: 'instagram' | 'tiktok' | 'youtube' | 'linkedin' | 'facebook';
  handle: string;
}

interface ProfileSocialCardProps {
  socialLinks: SocialLink[];
  title?: string;
  children?: React.ReactNode;
}

export function ProfileSocialCard({ socialLinks, title, children }: ProfileSocialCardProps) {
  const { t } = useTranslation('common');

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

  const getSocialIcon = (platform: string) => {
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

  const getPlatformLabel = (platform: string) => {
    return platform.charAt(0).toUpperCase() + platform.slice(1);
  };

  if (socialLinks.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title || t('followUs', 'Follow Us')}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex gap-3">
          {socialLinks.map((link) => (
            <a
              key={link.platform}
              href={getSocialUrl(link.platform, link.handle) || '#'}
              target="_blank"
              rel="noopener noreferrer"
              className="p-3 rounded-lg bg-muted hover:bg-muted/80 transition-colors flex-1 flex flex-col items-center gap-1"
            >
              {getSocialIcon(link.platform)}
              <span className="text-xs text-muted-foreground">{getPlatformLabel(link.platform)}</span>
            </a>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

interface ProfileContactCardProps {
  title?: string;
  description?: string;
  action?: React.ReactNode;
  email?: string | null;
  phone?: string | null;
}

export function ProfileContactCard({ title, description, action, email, phone }: ProfileContactCardProps) {
  const { t } = useTranslation('common');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title || t('contactInfo', 'Contact Info')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
        {email && (
          <div className="flex items-center gap-2 text-sm">
            <Mail className="h-4 w-4 text-muted-foreground" />
            <a href={`mailto:${email}`} className="text-primary hover:underline">{email}</a>
          </div>
        )}
        {phone && (
          <div className="flex items-center gap-2 text-sm">
            <Phone className="h-4 w-4 text-muted-foreground" />
            <a href={`tel:${phone}`} className="text-primary hover:underline">{phone}</a>
          </div>
        )}
        {action}
      </CardContent>
    </Card>
  );
}
