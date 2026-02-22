import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Pick up to 3 queued topics
    const { data: topics, error } = await supabase
      .from('content_topics')
      .select('*')
      .eq('status', 'queued')
      .order('created_at', { ascending: true })
      .limit(3);

    if (error) throw error;
    if (!topics || topics.length === 0) {
      return new Response(JSON.stringify({ message: 'No queued topics' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const results = [];

    for (const topic of topics) {
      try {
        // Call generate-blog-article for each topic
        const genResponse = await fetch(`${supabaseUrl}/functions/v1/generate-blog-article`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${supabaseKey}`,
          },
          body: JSON.stringify({ topic_id: topic.id }),
        });

        const genResult = await genResponse.json();

        if (genResponse.ok && genResult.article_id) {
          // Generate translations for remaining locales
          const remainingLocales = (topic.locales || []).slice(1);
          for (const locale of remainingLocales) {
            try {
              await fetch(`${supabaseUrl}/functions/v1/translate-blog-article`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${supabaseKey}`,
                },
                body: JSON.stringify({ article_id: genResult.article_id, target_locale: locale }),
              });
            } catch (transErr) {
              console.error(`Translation to ${locale} failed:`, transErr);
            }
          }
          results.push({ topic_id: topic.id, status: 'done', article_id: genResult.article_id });
        } else {
          results.push({ topic_id: topic.id, status: 'failed', error: genResult.error });
        }
      } catch (topicErr) {
        console.error(`Topic ${topic.id} failed:`, topicErr);
        results.push({ topic_id: topic.id, status: 'failed', error: (topicErr as Error).message });
      }
    }

    return new Response(JSON.stringify({ processed: results.length, results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('process-blog-queue error:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
