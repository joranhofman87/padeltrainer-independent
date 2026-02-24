import React from 'react';

const URL_REGEX = /(https?:\/\/[^\s<]+)/g;

/**
 * Converts plain-text URLs in a string into clickable <a> tags.
 * Returns an array of React nodes (strings and anchor elements).
 */
export function autoLinkText(text: string): React.ReactNode[] {
  const parts = text.split(URL_REGEX);
  return parts.map((part, i) =>
    URL_REGEX.test(part) ? (
      <a
        key={i}
        href={part}
        target="_blank"
        rel="noopener noreferrer"
        className="underline text-primary hover:text-primary/80 break-all"
      >
        {part}
      </a>
    ) : (
      part
    )
  );
}
