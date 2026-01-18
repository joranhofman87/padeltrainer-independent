import { createClient, EntryFieldTypes, Entry, Asset } from 'contentful';
import type { Document } from '@contentful/rich-text-types';

// Contentful client configuration
const client = createClient({
  space: import.meta.env.VITE_CONTENTFUL_SPACE_ID || 'svknnky6rx22',
  accessToken: import.meta.env.VITE_CONTENTFUL_ACCESS_TOKEN || 't8UH6GF7-In5Hz5NFCcdPvFrtICqXEaPa0yZnc6Q4ZE',
});

// Content type skeleton for Contentful SDK v10+
export interface BlogPostSkeleton {
  contentTypeId: 'blogPost';
  fields: {
    title: EntryFieldTypes.Text;
    slug: EntryFieldTypes.Text;
    subtitle: EntryFieldTypes.Text;
    content: EntryFieldTypes.RichText;
    featuredImage?: EntryFieldTypes.AssetLink;
    publishedDate: EntryFieldTypes.Date;
    author?: EntryFieldTypes.Text;
    rating?: EntryFieldTypes.Number;
  };
}

// Transformed blog post for use in components
export interface BlogPost {
  slug: string;
  title: string;
  excerpt: string;
  content: Document;
  image: string;
  date: string;
  readTime: string;
  author?: string;
}

// Calculate read time from content (rough estimate: 200 words per minute)
function calculateReadTime(content: Document | undefined): string {
  if (!content || !content.content) {
    return '1 min read';
  }
  
  let wordCount = 0;
  const countWords = (node: any) => {
    if (!node) return;
    if (node.nodeType === 'text' && node.value) {
      wordCount += node.value.split(/\s+/).filter(Boolean).length;
    }
    if (node.content && Array.isArray(node.content)) {
      node.content.forEach(countWords);
    }
  };
  countWords(content);
  const minutes = Math.max(1, Math.ceil(wordCount / 200));
  return `${minutes} min read`;
}

// Transform Contentful entry to BlogPost
function transformEntry(entry: Entry<BlogPostSkeleton, undefined, string>): BlogPost {
  const fields = entry.fields;
  const featuredImage = fields.featuredImage as Asset | undefined;
  const content = fields.content as Document;
  
  return {
    slug: fields.slug as string,
    title: fields.title as string,
    excerpt: (fields.subtitle as string) || '',
    content: content,
    image: featuredImage?.fields?.file?.url 
      ? `https:${featuredImage.fields.file.url}` 
      : '/placeholder.svg',
    date: fields.publishedDate as string,
    readTime: calculateReadTime(content),
    author: fields.author as string | undefined,
  };
}

// Fetch all blog posts, sorted by published date (newest first)
export async function getBlogPosts(): Promise<BlogPost[]> {
  try {
    const response = await client.getEntries<BlogPostSkeleton>({
      content_type: 'blogPost',
      order: ['-fields.publishedDate'],
    });
    
    return response.items.map(transformEntry);
  } catch (error) {
    console.error('Error fetching blog posts from Contentful:', error);
    return [];
  }
}

// Fetch a single blog post by slug
export async function getBlogPostBySlug(slug: string): Promise<BlogPost | null> {
  try {
    const response = await client.getEntries<BlogPostSkeleton>({
      content_type: 'blogPost',
      'fields.slug': slug,
      limit: 1,
    });
    
    if (response.items.length === 0) {
      return null;
    }
    
    return transformEntry(response.items[0]);
  } catch (error) {
    console.error('Error fetching blog post from Contentful:', error);
    return null;
  }
}
