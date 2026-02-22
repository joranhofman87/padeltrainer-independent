import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function makeDisplayTitle(title: string, metaTitle: string | null, maxLen = 50): string {
  const source = metaTitle || title;
  if (source.length <= maxLen) return source;
  const trimmed = source.substring(0, maxLen);
  const lastSpace = trimmed.lastIndexOf(" ");
  if (lastSpace <= 10) return trimmed + "...";
  return trimmed.substring(0, lastSpace) + "...";
}

function base64ToUint8Array(base64: string): Uint8Array {
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { article_id, canonical_id, all_locales, force } = await req.json();

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Determine which articles to process
    let articles: any[] = [];

    if (all_locales && canonical_id) {
      const { data, error } = await supabase
        .from("articles")
        .select("*")
        .eq("canonical_id", canonical_id);
      if (error) throw error;
      articles = data || [];
      // Skip articles that already have covers unless force
      if (!force) {
        articles = articles.filter((a: any) => !a.cover_image_url);
      }
    } else if (article_id) {
      const { data, error } = await supabase
        .from("articles")
        .select("*")
        .eq("id", article_id)
        .single();
      if (error) throw error;
      articles = [data];
    } else {
      throw new Error("Provide article_id or canonical_id + all_locales");
    }

    if (articles.length === 0) {
      return new Response(JSON.stringify({ message: "No articles to process" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const results: any[] = [];

    for (const article of articles) {
      try {
        const displayTitle = makeDisplayTitle(article.title, article.meta_title);
        const tagsHint = article.tags?.slice(0, 3)?.join(", ") || "padel";

        const prompt = `Create a professional blog cover image in landscape 1200x630 format for a padel sports website called PadelTrainer.ai. 
Style: modern, clean, high contrast, editorial quality. 
Background: a padel court scene, player in action, or abstract padel-themed visuals. Keep it visually striking but not cluttered.
Text overlay: "${displayTitle}" — render this text prominently in a large, bold, readable sans-serif font. Ensure high contrast between text and background (use a dark overlay or text shadow if needed). The text must be in ${article.locale === "nl" ? "Dutch" : article.locale === "es" ? "Spanish" : article.locale === "de" ? "German" : article.locale === "fr" ? "French" : "English"}.
Small "PadelTrainer.ai" watermark in the bottom-right corner.
Topic hint: ${tagsHint}.
Do NOT include any other text, logos, or UI elements.`;

        console.log(`Generating cover for article ${article.id} (${article.locale})...`);

        const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${LOVABLE_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash-image",
            messages: [{ role: "user", content: prompt }],
            modalities: ["image", "text"],
          }),
        });

        if (!aiResponse.ok) {
          const errText = await aiResponse.text();
          console.error(`AI gateway error [${aiResponse.status}]:`, errText);
          results.push({ id: article.id, locale: article.locale, error: `AI error: ${aiResponse.status}` });
          continue;
        }

        const aiData = await aiResponse.json();
        const imageUrl = aiData.choices?.[0]?.message?.images?.[0]?.image_url?.url;

        if (!imageUrl || !imageUrl.startsWith("data:image/")) {
          console.error("No image returned from AI");
          results.push({ id: article.id, locale: article.locale, error: "No image generated" });
          continue;
        }

        // Extract base64 data
        const base64Data = imageUrl.split(",")[1];
        const imageBytes = base64ToUint8Array(base64Data);

        // Determine content type from data URI
        const mimeMatch = imageUrl.match(/^data:(image\/\w+);/);
        const contentType = mimeMatch ? mimeMatch[1] : "image/png";
        const ext = contentType === "image/webp" ? "webp" : contentType === "image/jpeg" ? "jpg" : "png";

        const storagePath = `blog-covers/${article.locale}/${article.slug}-1200x630.${ext}`;

        // Upload to storage (upsert)
        const { error: uploadError } = await supabase.storage
          .from("blog-images")
          .upload(storagePath, imageBytes, {
            contentType,
            upsert: true,
          });

        if (uploadError) {
          console.error("Upload error:", uploadError);
          results.push({ id: article.id, locale: article.locale, error: `Upload failed: ${uploadError.message}` });
          continue;
        }

        // Get public URL
        const { data: urlData } = supabase.storage.from("blog-images").getPublicUrl(storagePath);
        const publicUrl = urlData.publicUrl;

        // Generate alt text
        const altText = `Cover image for: ${article.title}`;

        // Update article
        const { error: updateError } = await supabase
          .from("articles")
          .update({
            cover_image_url: publicUrl,
            cover_image_alt: altText,
            cover_image_generated_at: new Date().toISOString(),
          })
          .eq("id", article.id);

        if (updateError) {
          console.error("DB update error:", updateError);
          results.push({ id: article.id, locale: article.locale, error: `DB update failed: ${updateError.message}` });
          continue;
        }

        console.log(`Cover generated for ${article.locale}: ${publicUrl}`);
        results.push({ id: article.id, locale: article.locale, url: publicUrl, success: true });
      } catch (articleErr) {
        console.error(`Error processing article ${article.id}:`, articleErr);
        results.push({
          id: article.id,
          locale: article.locale,
          error: articleErr instanceof Error ? articleErr.message : "Unknown error",
        });
      }
    }

    return new Response(JSON.stringify({ results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("generate-blog-cover error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
