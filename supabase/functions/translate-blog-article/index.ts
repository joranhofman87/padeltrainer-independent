import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const { article_id, target_locale } = await req.json();
    if (!article_id || !target_locale) throw new Error('article_id and target_locale required');

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY not configured');

    // Fetch source article
    const { data: source, error: srcError } = await supabase
      .from('articles')
      .select('*')
      .eq('id', article_id)
      .single();
    if (srcError || !source) throw new Error('Source article not found');

    const langNames: Record<string, string> = { en: 'English', nl: 'Dutch', es: 'Spanish', de: 'German', fr: 'French' };
    const targetLang = langNames[target_locale] || target_locale;

    const prompt = `Translate this padel article to ${targetLang}. Preserve the meaning, tone, and HTML structure. Localize examples for a European audience.

Original title: ${source.title}
Original excerpt: ${source.excerpt}
Original body HTML:
${source.body_html}

Return a JSON object using the translate_article tool with localized title, slug, excerpt, body_html, meta_title, and meta_description.`;

    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          { role: 'system', content: `You are a professional translator specializing in padel content. Translate to ${targetLang}.` },
          { role: 'user', content: prompt },
        ],
        tools: [{
          type: 'function',
          function: {
            name: 'translate_article',
            description: 'Return the translated article',
            parameters: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                slug: { type: 'string' },
                excerpt: { type: 'string' },
                body_html: { type: 'string' },
                meta_title: { type: 'string' },
                meta_description: { type: 'string' },
              },
              required: ['title', 'slug', 'excerpt', 'body_html', 'meta_title', 'meta_description'],
              additionalProperties: false,
            },
          },
        }],
        tool_choice: { type: 'function', function: { name: 'translate_article' } },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('AI translation error:', response.status, errText);
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
          status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: 'AI credits exhausted' }), {
          status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      throw new Error('AI translation failed');
    }

    const aiResult = await response.json();
    const toolCall = aiResult.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall) throw new Error('No tool call in response');

    const translated = JSON.parse(toolCall.function.arguments);

    // Check if translation already exists
    const { data: existing } = await supabase
      .from('articles')
      .select('id')
      .eq('canonical_id', source.canonical_id)
      .eq('locale', target_locale)
      .maybeSingle();

    if (existing) {
      // Update existing translation
      await supabase.from('articles').update({
        title: translated.title,
        slug: translated.slug,
        excerpt: translated.excerpt,
        body_html: translated.body_html,
        meta_title: translated.meta_title,
        meta_description: translated.meta_description,
        status: 'review',
        tags: source.tags,
        primary_keyword: source.primary_keyword,
      }).eq('id', existing.id);
    } else {
      // Create new translation
      await supabase.from('articles').insert({
        canonical_id: source.canonical_id,
        locale: target_locale,
        title: translated.title,
        slug: translated.slug,
        excerpt: translated.excerpt,
        body_html: translated.body_html,
        body_md: '',
        status: 'review',
        tags: source.tags,
        primary_keyword: source.primary_keyword,
        meta_title: translated.meta_title,
        meta_description: translated.meta_description,
        author_name: source.author_name,
        cover_image_url: source.cover_image_url,
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('translate-blog-article error:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
