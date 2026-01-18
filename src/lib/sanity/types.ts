import type { PortableTextBlock } from '@portabletext/types';

export interface SanityImage {
  _type: 'image';
  asset: {
    _ref: string;
    _type: 'reference';
  };
  alt?: string;
}

export interface SanityPost {
  _id: string;
  title: string;
  slug: string;
  excerpt: string;
  content?: PortableTextBlock[];
  category: string;
  publishedAt: string;
  readTime: string;
  mainImage?: SanityImage;
}
