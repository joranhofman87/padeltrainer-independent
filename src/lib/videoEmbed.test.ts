import { describe, it, expect } from 'vitest';
import {
  parseVideoUrl,
  getVideoThumbnail,
  getEmbedUrl,
  isValidVideoUrl,
} from './videoEmbed';

describe('parseVideoUrl', () => {
  describe('YouTube URLs', () => {
    it('parses standard youtube.com/watch URLs', () => {
      const result = parseVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      expect(result).toEqual({
        platform: 'youtube',
        videoId: 'dQw4w9WgXcQ',
        embedUrl: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
        thumbnailUrl: 'https://img.youtube.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
      });
    });

    it('parses youtu.be short URLs', () => {
      const result = parseVideoUrl('https://youtu.be/dQw4w9WgXcQ');
      expect(result).toEqual({
        platform: 'youtube',
        videoId: 'dQw4w9WgXcQ',
        embedUrl: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
        thumbnailUrl: 'https://img.youtube.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
      });
    });

    it('parses youtube.com/embed URLs', () => {
      const result = parseVideoUrl('https://www.youtube.com/embed/dQw4w9WgXcQ');
      expect(result).toEqual({
        platform: 'youtube',
        videoId: 'dQw4w9WgXcQ',
        embedUrl: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
        thumbnailUrl: 'https://img.youtube.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
      });
    });

    it('parses youtube.com/shorts URLs', () => {
      const result = parseVideoUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ');
      expect(result).toEqual({
        platform: 'youtube',
        videoId: 'dQw4w9WgXcQ',
        embedUrl: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
        thumbnailUrl: 'https://img.youtube.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
      });
    });

    it('handles URLs with extra query parameters', () => {
      const result = parseVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=120');
      expect(result?.videoId).toBe('dQw4w9WgXcQ');
    });
  });

  describe('Vimeo URLs', () => {
    it('parses standard vimeo.com URLs', () => {
      const result = parseVideoUrl('https://vimeo.com/123456789');
      expect(result).toEqual({
        platform: 'vimeo',
        videoId: '123456789',
        embedUrl: 'https://player.vimeo.com/video/123456789',
        thumbnailUrl: 'https://vumbnail.com/123456789.jpg',
      });
    });

    it('parses vimeo.com/video URLs', () => {
      const result = parseVideoUrl('https://vimeo.com/video/123456789');
      expect(result).toEqual({
        platform: 'vimeo',
        videoId: '123456789',
        embedUrl: 'https://player.vimeo.com/video/123456789',
        thumbnailUrl: 'https://vumbnail.com/123456789.jpg',
      });
    });
  });

  describe('TikTok URLs', () => {
    it('parses tiktok.com/@user/video URLs', () => {
      const result = parseVideoUrl('https://www.tiktok.com/@user/video/1234567890123456789');
      expect(result).toEqual({
        platform: 'tiktok',
        videoId: '1234567890123456789',
        embedUrl: 'https://www.tiktok.com/embed/v2/1234567890123456789',
        thumbnailUrl: '',
      });
    });

    it('parses vm.tiktok.com short URLs', () => {
      const result = parseVideoUrl('https://vm.tiktok.com/ZM8abc123');
      expect(result).toEqual({
        platform: 'tiktok',
        videoId: 'ZM8abc123',
        embedUrl: 'https://www.tiktok.com/embed/v2/ZM8abc123',
        thumbnailUrl: '',
      });
    });

    it('parses tiktok.com/t short URLs', () => {
      const result = parseVideoUrl('https://www.tiktok.com/t/ZM8abc123');
      expect(result).toEqual({
        platform: 'tiktok',
        videoId: 'ZM8abc123',
        embedUrl: 'https://www.tiktok.com/embed/v2/ZM8abc123',
        thumbnailUrl: '',
      });
    });
  });

  describe('Invalid inputs', () => {
    it('returns null for empty string', () => {
      expect(parseVideoUrl('')).toBeNull();
    });

    it('returns null for null input', () => {
      expect(parseVideoUrl(null as any)).toBeNull();
    });

    it('returns null for undefined input', () => {
      expect(parseVideoUrl(undefined as any)).toBeNull();
    });

    it('returns null for non-video URLs', () => {
      expect(parseVideoUrl('https://google.com')).toBeNull();
    });

    it('returns null for invalid YouTube video IDs', () => {
      expect(parseVideoUrl('https://youtube.com/watch?v=short')).toBeNull();
    });

    it('trims whitespace from URLs', () => {
      const result = parseVideoUrl('  https://youtu.be/dQw4w9WgXcQ  ');
      expect(result?.videoId).toBe('dQw4w9WgXcQ');
    });
  });
});

describe('getVideoThumbnail', () => {
  it('returns thumbnail URL for valid video', () => {
    const thumbnail = getVideoThumbnail('https://youtu.be/dQw4w9WgXcQ');
    expect(thumbnail).toBe('https://img.youtube.com/vi/dQw4w9WgXcQ/maxresdefault.jpg');
  });

  it('returns null for invalid URL', () => {
    expect(getVideoThumbnail('https://invalid.com')).toBeNull();
  });
});

describe('getEmbedUrl', () => {
  it('returns embed URL for valid video', () => {
    const embedUrl = getEmbedUrl('https://youtu.be/dQw4w9WgXcQ');
    expect(embedUrl).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
  });

  it('returns null for invalid URL', () => {
    expect(getEmbedUrl('https://invalid.com')).toBeNull();
  });
});

describe('isValidVideoUrl', () => {
  it('returns true for valid YouTube URL', () => {
    expect(isValidVideoUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(true);
  });

  it('returns true for valid Vimeo URL', () => {
    expect(isValidVideoUrl('https://vimeo.com/123456789')).toBe(true);
  });

  it('returns true for valid TikTok URL', () => {
    expect(isValidVideoUrl('https://www.tiktok.com/@user/video/1234567890123456789')).toBe(true);
  });

  it('returns false for invalid URL', () => {
    expect(isValidVideoUrl('https://invalid.com')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isValidVideoUrl('')).toBe(false);
  });
});
