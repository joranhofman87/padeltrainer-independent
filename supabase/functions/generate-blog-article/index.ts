import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const { topic_id } = await req.json();
    if (!topic_id) throw new Error('topic_id required');

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY not configured');

    // Fetch topic
    const { data: topic, error: topicError } = await supabase
      .from('content_topics')
      .select('*')
      .eq('id', topic_id)
      .single();
    if (topicError || !topic) throw new Error('Topic not found');

    // Mark in_progress
    await supabase.from('content_topics').update({ status: 'in_progress' }).eq('id', topic_id);

    const primaryLocale = topic.locales?.[0] || 'en';

    // Generate article via AI
    const prompt = `You are a padel content writer for PadelTrainer.ai. Write a COMPLETE, comprehensive blog article about "${topic.primary_keyword}".
${topic.angle ? `Angle/approach: ${topic.angle}` : ''}
${topic.notes ? `Additional notes: ${topic.notes}` : ''}

Requirements:
- Write in ${primaryLocale === 'nl' ? 'Dutch' : primaryLocale === 'es' ? 'Spanish' : primaryLocale === 'de' ? 'German' : primaryLocale === 'fr' ? 'French' : 'English'}
- Focus on how-to and framework content, avoid factual claims that could be wrong
- Keep it padel-specific and aligned with trainer/academy/club positioning
- Target 1000-1500 words. Write the COMPLETE article from introduction to conclusion. Do NOT stop early or truncate.
- Use clean, well-formatted HTML with semantic tags: h2 for main sections, h3 for subsections, p for paragraphs, ul/ol with li for lists, strong for emphasis, em for italic
- Structure the article with clear sections: introduction, 3-5 main sections with h2 headings, and a conclusion
- Do NOT include h1 (it's rendered separately)
- Every section must have substantive content (at least 2-3 paragraphs)

Write the COMPLETE article. Do not stop early. Include a proper conclusion section.

Return a JSON object using the suggest_article tool.`;

    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          { role: 'system', content: 'You are a padel content expert writing for PadelTrainer.ai.' },
          { role: 'user', content: prompt },
        ],
        tools: [{
          type: 'function',
          function: {
            name: 'suggest_article',
            description: 'Return the generated article',
            parameters: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                slug: { type: 'string', description: 'URL-friendly slug' },
                excerpt: { type: 'string', description: 'Short summary, max 160 chars' },
                body_html: { type: 'string', description: 'Article body in clean HTML' },
                meta_title: { type: 'string', description: 'SEO title, max 60 chars' },
                meta_description: { type: 'string', description: 'SEO description, max 155 chars' },
                tags: { type: 'array', items: { type: 'string' }, description: '3-5 relevant tags' },
              },
              required: ['title', 'slug', 'excerpt', 'body_html', 'meta_title', 'meta_description', 'tags'],
              additionalProperties: false,
            },
          },
        }],
        tool_choice: { type: 'function', function: { name: 'suggest_article' } },
        max_tokens: 16384,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('AI error:', response.status, errText);
      await supabase.from('content_topics').update({ status: 'failed' }).eq('id', topic_id);

      if (response.status === 429) {
        return new Response(JSON.stringify({ error: 'Rate limit exceeded, try again later' }), {
          status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: 'AI credits exhausted' }), {
          status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      throw new Error('AI generation failed');
    }

    const aiResult = await response.json();
    const toolCall = aiResult.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall) throw new Error('No tool call in AI response');

    const article = JSON.parse(toolCall.function.arguments);
    const canonical_id = crypto.randomUUID();

    // Insert article
    const { data: inserted, error: insertError } = await supabase.from('articles').insert({
      canonical_id,
      locale: primaryLocale,
      title: article.title,
      slug: article.slug,
      excerpt: article.excerpt,
      body_html: article.body_html,
      body_md: '',
      status: 'review',
      tags: article.tags,
      primary_keyword: topic.primary_keyword,
      meta_title: article.meta_title,
      meta_description: article.meta_description,
      author_name: 'Padel Trainer',
    }).select().single();

    if (insertError) {
      console.error('Insert error:', insertError);
      await supabase.from('content_topics').update({ status: 'failed' }).eq('id', topic_id);
      throw insertError;
    }

    // Mark topic done
    await supabase.from('content_topics').update({ status: 'done' }).eq('id', topic_id);

    return new Response(JSON.stringify({ success: true, article_id: inserted.id, canonical_id }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('generate-blog-article error:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
