

# Make Blog Cover Images Look More Realistic

## Problem
The current AI prompt produces images that look too obviously AI-generated. The prompt asks for "abstract padel-themed visuals" and "editorial quality" which tends to produce synthetic-looking results.

## Solution
Update the prompt in `supabase/functions/generate-blog-cover/index.ts` to guide the model toward photorealistic output. Key changes:

### Updated Prompt Strategy
- Request a **photorealistic, editorial photography** style instead of "modern, clean"
- Ask for a **real photograph** look: natural lighting, shallow depth of field, realistic textures
- Avoid terms like "abstract" or "visually striking" that push toward synthetic aesthetics
- Use photography-specific language: "DSLR", "natural light", "candid", "sports photography"
- Keep the dark overlay + text overlay approach (that part works well for readability)

### Revised Prompt (in edge function, lines 80-86)
```
Create a photorealistic blog cover image in landscape 1200x630 format.
Style: editorial sports photography, shot on a DSLR camera, natural lighting, 
realistic textures and colors. Must look like a real photograph, NOT like AI art.
Scene: a real-looking padel court with natural shadows, or a close-up of padel 
equipment (racket, ball, court surface), or a candid moment of players on court. 
Use shallow depth of field where appropriate.
Add a semi-transparent dark gradient overlay on the lower half for text readability.
Text overlay: "{displayTitle}" in a large, bold, clean sans-serif font (white text). 
The text must be in {language}.
Small "PadelTrainer.ai" watermark in the bottom-right corner (subtle, small).
Topic hint: {tagsHint}.
Do NOT include any other text, logos, watermarks, or UI elements. 
Do NOT make it look like a graphic design or illustration.
```

### File Changed
- `supabase/functions/generate-blog-cover/index.ts` -- update the prompt on lines 80-86

### After Deploying
Existing covers won't change. Use the "Regenerate" button in the admin to re-generate covers for specific articles and verify the new style.

