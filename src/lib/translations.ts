import { sanityClient } from '@/lib/sanity';

export interface Translation {
  language: string;
  slug: string;
}

/**
 * Given a Sanity document, find all available translations (including self).
 * Uses the `translationOf` reference to find the English root, then fetches all siblings.
 */
export async function getTranslations(
  docId: string,
  docType: string,
  currentLang: string,
  translationOfRef?: string | null
): Promise<Translation[]> {
  // Determine the English root document ID
  const englishId = currentLang === 'en' && !translationOfRef ? docId : translationOfRef;

  if (!englishId) {
    // No translation chain — return just the current document
    return [];
  }

  // Fetch all translations: the English root + all docs that reference it
  const translations = await sanityClient.fetch<Translation[]>(
    `*[_type == $type && (_id == $englishId || translationOf._ref == $englishId) && !(_id in path("drafts.**"))]{
      "language": language,
      "slug": slug.current
    }`,
    { type: docType, englishId }
  );

  return translations || [];
}
