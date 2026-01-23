import { createClient, EntryFieldTypes, Entry, Asset, ContentfulClientApi } from 'contentful';
import { BLOCKS, type Document } from '@contentful/rich-text-types';

// Contentful client configuration
const spaceId = import.meta.env.VITE_CONTENTFUL_SPACE_ID;
const accessToken = import.meta.env.VITE_CONTENTFUL_ACCESS_TOKEN;

// Create client only if credentials are configured
let client: ContentfulClientApi<undefined> | null = null;

if (spaceId && accessToken) {
  client = createClient({
    space: spaceId,
    accessToken: accessToken,
  });
} else {
  console.warn('Contentful credentials not configured. Blog features will be disabled.');
}

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
  const content = fields.content as Document | undefined;
  
  // Create empty document if content is missing
  const safeContent: Document = content || {
    nodeType: BLOCKS.DOCUMENT,
    data: {},
    content: [],
  };
  
  return {
    slug: (fields.slug as string) || '',
    title: (fields.title as string) || 'Untitled',
    excerpt: (fields.subtitle as string) || '',
    content: safeContent,
    image: featuredImage?.fields?.file?.url 
      ? `https:${featuredImage.fields.file.url}` 
      : '/placeholder.svg',
    date: (fields.publishedDate as string) || new Date().toISOString(),
    readTime: calculateReadTime(content),
    author: fields.author as string | undefined,
  };
}

// Map i18next locale to Contentful locale
function getContentfulLocale(locale: string): string {
  return locale === 'nl' ? 'nl' : 'en-US';
}

// Fetch all blog posts, sorted by published date (newest first)
export async function getBlogPosts(locale: string = 'en'): Promise<BlogPost[]> {
  if (!client) {
    console.warn('Contentful client not initialized');
    return [];
  }
  
  try {
    const response = await client.getEntries<BlogPostSkeleton>({
      content_type: 'blogPost',
      order: ['-fields.publishedDate'],
      locale: getContentfulLocale(locale),
    });
    
    return response.items.map(transformEntry);
  } catch (error) {
    console.error('Error fetching blog posts from Contentful:', error);
    return [];
  }
}

// Fetch a single blog post by slug
export async function getBlogPostBySlug(slug: string, locale: string = 'en'): Promise<BlogPost | null> {
  if (!client) {
    console.warn('Contentful client not initialized');
    return null;
  }
  
  try {
    const response = await client.getEntries<BlogPostSkeleton>({
      content_type: 'blogPost',
      'fields.slug': slug,
      limit: 1,
      locale: getContentfulLocale(locale),
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
