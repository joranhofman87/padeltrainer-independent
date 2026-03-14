import type { BodySection } from '@/lib/sanity';

interface BodySectionsProps {
  sections: BodySection[] | null;
}

export function BodySections({ sections }: BodySectionsProps) {
  if (!sections || sections.length === 0) return null;

  return (
    <div className="prose prose-lg max-w-none dark:prose-invert">
      {sections.map((section, i) => (
        <div key={i} className="mb-8">
          {section.heading && <h2>{section.heading}</h2>}
          {section.content &&
            section.content.split('\n\n').map((paragraph, j) => (
              <p key={j}>{paragraph}</p>
            ))}
        </div>
      ))}
    </div>
  );
}
