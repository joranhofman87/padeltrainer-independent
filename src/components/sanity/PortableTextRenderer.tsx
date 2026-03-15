import { PortableText, type PortableTextComponents } from '@portabletext/react';
import { LocalizedLink } from '@/components/LocalizedLink';
import { urlFor } from '@/lib/sanity';

/**
 * Extract headings (h2/h3) from Portable Text blocks for TOC generation.
 */
export interface TocHeading {
  id: string;
  text: string;
  level: 2 | 3;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractHeadings(blocks: any[]): TocHeading[] {
  if (!blocks) return [];
  const headings: TocHeading[] = [];
  for (const block of blocks) {
    if (block._type !== 'block') continue;
    if (block.style === 'h2' || block.style === 'h3') {
      const text = (block.children || [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((c: any) => c.text || '')
        .join('');
      if (text) {
        const id = text
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, '')
          .replace(/\s+/g, '-')
          .slice(0, 80);
        headings.push({ id, text, level: block.style === 'h2' ? 2 : 3 });
      }
    }
  }
  return headings;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 80);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getBlockText(children: any[]): string {
  return (children || []).map((c: { text?: string }) => c.text || '').join('');
}

const components: PortableTextComponents = {
  block: {
    h1: ({ children, value }) => {
      const text = getBlockText(value.children);
      const id = slugify(text);
      return <h2 id={id} className="scroll-mt-24">{children}</h2>;
    },
    h2: ({ children, value }) => {
      const text = getBlockText(value.children);
      const id = slugify(text);
      return <h2 id={id} className="scroll-mt-24">{children}</h2>;
    },
    h3: ({ children, value }) => {
      const text = getBlockText(value.children);
      const id = slugify(text);
      return <h3 id={id} className="scroll-mt-24">{children}</h3>;
    },
    h4: ({ children, value }) => {
      const text = getBlockText(value.children);
      const id = slugify(text);
      return <h4 id={id} className="scroll-mt-24">{children}</h4>;
    },
    h5: ({ children }) => <h5>{children}</h5>,
    h6: ({ children }) => <h6>{children}</h6>,
    blockquote: ({ children }) => (
      <blockquote className="border-l-4 border-primary/30 pl-4 italic text-muted-foreground my-4">
        {children}
      </blockquote>
    ),
    normal: ({ children }) => <p>{children}</p>,
  },
  list: {
    bullet: ({ children }) => <ul className="list-disc pl-6 space-y-1">{children}</ul>,
    number: ({ children }) => <ol className="list-decimal pl-6 space-y-1">{children}</ol>,
  },
  listItem: {
    bullet: ({ children }) => <li>{children}</li>,
    number: ({ children }) => <li>{children}</li>,
  },
  types: {
    image: ({ value }) => {
      if (!value?.asset) return null;
      const alt = value.alt || '';
      const src = urlFor(value).width(800).auto('format').quality(80).url();
      return (
        <figure className="my-6">
          <img
            src={src}
            alt={alt}
            loading="lazy"
            width={800}
            height={450}
            className="rounded-lg w-full h-auto"
          />
          {value.caption && (
            <figcaption className="text-sm text-muted-foreground mt-2 text-center">
              {value.caption}
            </figcaption>
          )}
        </figure>
      );
    },
  },
  marks: {
    strong: ({ children }) => <strong>{children}</strong>,
    em: ({ children }) => <em>{children}</em>,
    code: ({ children }) => <code className="bg-muted px-1.5 py-0.5 rounded text-sm">{children}</code>,
    underline: ({ children }) => <u>{children}</u>,
    'strike-through': ({ children }) => <s>{children}</s>,
    link: ({ children, value }) => {
      const href: string = value?.href || '#';
      // Internal links: use LocalizedLink for crawlable routing
      if (href.startsWith('/')) {
        return (
          <LocalizedLink to={href} className="underline text-primary hover:text-primary/80">
            {children}
          </LocalizedLink>
        );
      }
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="underline text-primary hover:text-primary/80"
        >
          {children}
        </a>
      );
    },
  },
};

interface PortableTextRendererProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content: any[];
}

export function PortableTextRenderer({ content }: PortableTextRendererProps) {
  if (!content || content.length === 0) return null;

  return (
    <div className="prose prose-lg max-w-none dark:prose-invert">
      <PortableText value={content} components={components} />
    </div>
  );
}
