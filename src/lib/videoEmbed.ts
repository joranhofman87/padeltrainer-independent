export interface VideoEmbedInfo {
  platform: 'youtube' | 'vimeo';
  videoId: string;
  embedUrl: string;
  thumbnailUrl: string;
}

/**
 * Parse a YouTube or Vimeo URL and extract video information
 */
export function parseVideoUrl(url: string): VideoEmbedInfo | null {
  if (!url || typeof url !== 'string') return null;
  
  const trimmedUrl = url.trim();
  
  // YouTube patterns
  const youtubePatterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
  ];
  
  for (const pattern of youtubePatterns) {
    const match = trimmedUrl.match(pattern);
    if (match && match[1]) {
      const videoId = match[1];
      return {
        platform: 'youtube',
        videoId,
        embedUrl: `https://www.youtube.com/embed/${videoId}`,
        thumbnailUrl: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
      };
    }
  }
  
  // Vimeo patterns
  const vimeoPattern = /vimeo\.com\/(?:video\/)?(\d+)/;
  const vimeoMatch = trimmedUrl.match(vimeoPattern);
  if (vimeoMatch && vimeoMatch[1]) {
    const videoId = vimeoMatch[1];
    return {
      platform: 'vimeo',
      videoId,
      embedUrl: `https://player.vimeo.com/video/${videoId}`,
      thumbnailUrl: `https://vumbnail.com/${videoId}.jpg`,
    };
  }
  
  return null;
}

/**
 * Get the thumbnail URL for a video
 */
export function getVideoThumbnail(url: string): string | null {
  const info = parseVideoUrl(url);
  return info?.thumbnailUrl || null;
}

/**
 * Get the embed URL for a video
 */
export function getEmbedUrl(url: string): string | null {
  const info = parseVideoUrl(url);
  return info?.embedUrl || null;
}

/**
 * Check if a URL is a valid video URL
 */
export function isValidVideoUrl(url: string): boolean {
  return parseVideoUrl(url) !== null;
}
