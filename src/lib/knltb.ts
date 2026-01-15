import { supabase } from '@/integrations/supabase/client';

interface KnltbRatingResult {
  success: boolean;
  data?: {
    knltbNumber: string;
    rating: number;
    source: string;
    scrapedAt: string;
  };
  error?: string;
  debug?: string;
}

export async function fetchKnltbRating(knltbNumber: string): Promise<KnltbRatingResult> {
  try {
    const { data, error } = await supabase.functions.invoke('scrape-knltb-rating', {
      body: { knltbNumber },
    });

    if (error) {
      return { success: false, error: error.message };
    }

    return data;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error: message };
  }
}

export async function updateProfileWithRating(
  profileId: string,
  knltbNumber: string,
  rating: number
): Promise<{ success: boolean; error?: string }> {
  const { error } = await supabase
    .from('profiles')
    .update({
      knltb_number: knltbNumber,
      skill_rating: rating,
    })
    .eq('id', profileId);

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true };
}
