import imageUrlBuilder from '@sanity/image-url';
import { sanityClient } from './client';
import type { SanityImage } from './types';

const builder = imageUrlBuilder(sanityClient);

export function urlFor(source: SanityImage) {
  return builder.image(source);
}
