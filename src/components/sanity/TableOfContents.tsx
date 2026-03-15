import type { TocHeading } from './PortableTextRenderer';

interface TableOfContentsProps {
  headings: TocHeading[];
  className?: string;
}

export function TableOfContents({ headings, className = '' }: TableOfContentsProps) {
  if (headings.length < 2) return null;

  return (
    <nav aria-label="Table of contents" className={className}>
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        On this page
      </h2>
      <ul className="space-y-1.5 text-sm">
        {headings.map((heading) => (
          <li key={heading.id} className={heading.level === 3 ? 'ml-4' : ''}>
            <a
              href={`#${heading.id}`}
              className="text-muted-foreground hover:text-primary transition-colors line-clamp-2"
            >
              {heading.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
