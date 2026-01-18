import imageUrlBuilder from '@sanity/image-url';
import { sanityClient } from './client';
import type { SanityImage } from './types';

const builder = sanityClient ? imageUrlBuilder(sanityClient) : null;

export function urlFor(source: SanityImage) {
  if (!builder) {
    return { url: () => '/placeholder.svg', width: () => ({ url: () => '/placeholder.svg' }) };
  }
  return builder.image(source);
}
